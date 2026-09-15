import { env } from 'cloudflare:workers';
import { SELF, applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { currentWaiver, processMessage } from '../src/index.js';
import { coordinated, registerMember } from '../src/membership.js';
import { hash, issueToken, loginDestination, memberToken, now, provider, queryEvents, verifyToken } from '../src/services.js';

describe('Membership', () => {
  // Global fetch spies also apply inside the bound Durable Object in this runtime.
  // Every unexpected provider request fails; no tests can reach live services.
  let interceptors;
  const fetchMock = {
    activate() {
      interceptors = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
        // Exercise workerd's Request validation even when provider HTTP is mocked.
        new Request(input, init);
        const url = new URL(typeof input === 'string' ? input : input.url);
        const path = url.pathname + url.search;
        const mock = interceptors.find(item => item.remaining > 0 && item.origin === url.origin && item.method === (init.method || 'GET') && (typeof item.path === 'string' ? item.path === path : item.path.test(path)));
        if (!mock) throw new Error(`Unexpected provider request: ${init.method || 'GET'} ${url}`);
        mock.remaining--;
        const data = typeof mock.data === 'function' ? await mock.data(init) : mock.data;
        return new Response(mock.status === 204 ? null : JSON.stringify(data), { status: mock.status, headers: mock.headers });
      });
    },
    get(origin) {
      return { intercept({ path, method }) {
        return { reply(status, data, options = {}) {
          const mock = { origin, path, method, status, data, headers: options.headers, remaining: 1 };
          interceptors.push(mock);
          return { times(count) { mock.remaining = count; } };
        } };
      } };
    },
    assertNoPendingInterceptors() {
      expect(interceptors.filter(item => item.remaining).map(item => `${item.method} ${item.path}`)).toEqual([]);
    },
  };

  const id = '333333333333333333';
  const user = { id, username: 'maker', email: 'maker@example.com' };
  const customer = 'cus_member';
  const api = (path, options, bindings = env) => worker.fetch(new Request(`${env.SITE_URL}${path}`, options), bindings);
  const readMember = () => env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(id).first();
  const memberStub = async () => env.MEMBERS.get(env.MEMBERS.idFromName((await readMember()).member_id));
  const checkout = async (input = {}) => {
    const member = await registerMember(env, user);
    await seedWaiver(member);
    return coordinated(env, member.member_id, 'checkout', { user, ...input });
  };
  async function seedWaiver(member = null) {
    member ||= await registerMember(env, user);
    const waiver = await currentWaiver();
    await env.DB.prepare(`INSERT INTO waivers (member_id, version, content, name, email, agreements)
      SELECT ?, ?, ?, 'Test Maker', ?, ? WHERE NOT EXISTS (SELECT 1 FROM waivers WHERE member_id = ?)`)
      .bind(member.member_id, waiver.version, waiver.content, user.email, JSON.stringify(waiver.agreements), member.member_id).run();
  }
  const subscription = (status = 'active', subID = 'sub_member') => ({ id: subID, customer, status, created: now(), metadata: { thelab_discord_id: id } });

  function mockStripe(path, data, options = {}) {
    return fetchMock.get('https://api.stripe.com').intercept({ path: typeof path === 'string' ? `/v1${path}` : path, method: options.method || 'GET' })
      .reply(options.status || 200, data, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  }

  function mockDiscord(path, data = {}, method = 'GET', status = 200, headers = {}) {
    return fetchMock.get('https://discord.com').intercept({ path: `/api/v10${path}`, method })
      .reply(status, data, { headers: { 'Content-Type': 'application/json', ...headers } });
  }

  function mockSubs(subscriptions = []) {
    return mockStripe(/^\/v1\/subscriptions\?/, { data: subscriptions, has_more: false });
  }

  function mockBilling(name = 'Billing Maker', email = 'billing@example.com') {
    return mockStripe(`/customers/${customer}`, { id: customer, name, email });
  }

  function mockCheckoutEmail() {
    return mockStripe(`/customers/${customer}`, options => {
      expect(new URLSearchParams(options.body).get('email')).toBe('');
      return { id: customer, email: null };
    }, { method: 'POST' });
  }

  function mockPrice(annual = false) {
    return mockStripe(/^\/v1\/prices\?/, { data: [{ id: annual ? 'price_yearly' : 'price_monthly', product: 'prod_membership', type: 'recurring', recurring: { interval: annual ? 'year' : 'month', interval_count: 1 } }], has_more: false });
  }

  async function seed(extra = {}) {
    await env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, stripe_customer_id) VALUES (?, ?, ?, ?)')
      .bind(id, user.username, user.email, customer).run();
    for (const [key, value] of Object.entries(extra)) await env.DB.prepare(`UPDATE members SET ${key} = ? WHERE discord_user_id = ?`).bind(value, id).run();
  }

  async function loginCookie() {
    return `thelab_member=${await memberToken(env, await readMember())}`;
  }

  async function assignAnnualBilling() {
    const member = await readMember();
    return coordinated(env, member.member_id, 'updateMetadata', { fields: {
      discord_user_id: id, stripe_customer_id: customer, stripe_subscription_id: '',
      name_override: member.name_override, notes: member.notes, billing: 'yearly',
      discount_type: member.discount_type, metadata_version: String(member.metadata_version),
    } });
  }

  async function start(query = '') {
    const response = await api(`/signup${query}`);
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get('Location'));
    return { target, state: target.searchParams.get('state'), cookie: response.headers.get('Set-Cookie').split(';')[0] };
  }

  function oauthMock({ verified = true, guildStatus = 200, roles = [] } = {}) {
    mockDiscord('/oauth2/token', { access_token: 'access-token', token_type: 'Bearer' }, 'POST');
    mockDiscord('/users/@me', { ...user, verified });
    if (verified) mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}`, { user, roles }, 'GET', guildStatus);
  }

  async function signedEvent(type = 'customer.subscription.updated', eventID = 'evt_update', object = subscription()) {
    const payload = JSON.stringify({ id: eventID, type, data: { object } });
    const timestamp = now();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`))), n => n.toString(16).padStart(2, '0')).join('');
    return { method: 'POST', body: payload, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` } };
  }

  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    fetchMock.activate();
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
    vi.restoreAllMocks();
  });

  describe('GitHub onboarding', () => {
    const teamPath = '/orgs/TheLab-ms/teams/members/memberships/octomaker';
    const mockGithub = (path, data, method = 'GET', status = 200) =>
      fetchMock.get('https://api.github.com').intercept({ path, method }).reply(status, data);

    async function begin() {
      const session = await loginCookie();
      const response = await api('/github', { headers: { Cookie: session } });
      expect(response.status).toBe(303);
      const target = new URL(response.headers.get('Location'));
      expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(target.searchParams.get('scope')).toBe('');
      expect(target.searchParams.get('code_challenge_method')).toBe('S256');
      const browser = response.headers.get('Set-Cookie').split(';')[0];
      return { target, browser, cookie: `${session}; ${browser}`,
        path: `/login/github/callback?state=${target.searchParams.get('state')}&code=github-code` };
    }

    function identity(flow, accountID = 12345) {
      fetchMock.get('https://github.com').intercept({ path: '/login/oauth/access_token', method: 'POST' })
        .reply(200, async options => {
          const form = new URLSearchParams(options.body);
          expect(form.get('client_secret')).toBe(env.GITHUB_CLIENT_SECRET);
          expect(form.get('redirect_uri')).toBe(`${env.SITE_URL}/login/github/callback`);
          expect(form.get('code')).toBe('github-code');
          const verifier = flow.browser.split('=')[1];
          expect(form.get('code_verifier')).toBe(verifier);
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
          expect(flow.target.searchParams.get('code_challenge')).toBe(btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''));
          return { access_token: 'github-user-token', token_type: 'bearer' };
        });
      mockGithub('/user', options => {
        expect(options.headers.Authorization).toBe('Bearer github-user-token');
        return { id: accountID, login: 'octomaker', type: 'User' };
      });
    }

    it('returns unsigned members through Discord login to GitHub onboarding', async () => {
      await seed({ stripe_subscription_state: 'active' });
      const response = await api('/github');
      const target = new URL(response.headers.get('Location'));
      expect(target.hostname).toBe('discord.com');
      const state = target.searchParams.get('state');
      expect(await verifyToken(env, state, 'oauth')).toMatchObject({ purpose: 'member', return_to: '/github' });
      oauthMock();
      const callback = await api(`/login/discord/callback?state=${state}&code=test-code`, {
        headers: { Cookie: response.headers.get('Set-Cookie').split(';')[0] },
      });
      expect(callback.status).toBe(303);
      expect(callback.headers.get('Location')).toBe(`${env.SITE_URL}/github`);
    });

    it.each([{ stripe_subscription_state: 'active' }, { stripe_subscription_state: 'trialing' }, { non_billable: 1 }, { legacy_billing: 1 }])
      ('allows eligible members: %j', async fields => { await seed(fields); await begin(); });

    it('rejects inactive members and missing configuration before GitHub OAuth', async () => {
      await seed({ stripe_subscription_state: 'canceled' });
      expect((await api('/github', { headers: { Cookie: await loginCookie() } })).status).toBe(403);
      expect((await api('/github', {}, { ...env, GITHUB_TEAM_TOKEN: '' })).status).toBe(503);
    });

    it.each(['active', 'pending'])('saves identity and grants %s team membership', async state => {
      await seed({ stripe_subscription_state: 'active' });
      const flow = await begin();
      identity(flow);
      mockGithub(teamPath, {}, 'GET', 404);
      mockGithub(teamPath, options => {
        expect(options.headers.Authorization).toBe(`Bearer ${env.GITHUB_TEAM_TOKEN}`);
        expect(JSON.parse(options.body)).toEqual({ role: 'member' });
        return { state, role: 'member' };
      }, 'PUT');
      const response = await api(flow.path, { headers: { Cookie: flow.cookie } });
      expect(response.status).toBe(state === 'active' ? 303 : 200);
      if (state === 'active') expect(response.headers.get('Location')).toBe('https://github.com/TheLab-ms/wiki/wiki');
      else {
        const html = await response.text();
        expect(html).toContain('https://github.com/orgs/TheLab-ms/invitation');
        expect(html).toContain('https://github.com/TheLab-ms/wiki/wiki');
      }
      expect(response.headers.get('Set-Cookie')).toContain('thelab_github_oauth=;');
      expect(await readMember()).toMatchObject({ github_user_id: '12345', github_username: 'octomaker' });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM member_events WHERE event_type = 'GitHubAccountChanged'").first()).toEqual({ count: 1 });
    });

    it('preserves maintainers and retries a failed team grant with the saved account', async () => {
      await seed({ non_billable: 1 });
      const first = await begin();
      identity(first);
      mockGithub(teamPath, {}, 'GET', 404);
      mockGithub(teamPath, {}, 'PUT', 503);
      expect((await api(first.path, { headers: { Cookie: first.cookie } })).status).toBe(502);
      expect((await readMember()).github_user_id).toBe('12345');
      const retry = await begin();
      identity(retry);
      mockGithub(teamPath, { state: 'active', role: 'maintainer' });
      expect((await api(retry.path, { headers: { Cookie: retry.cookie } })).status).toBe(303);
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM member_events WHERE event_type = 'GitHubAccountChanged'").first()).toEqual({ count: 1 });
    });

    it.each(['missing cookie', 'changed session', 'revoked session', 'expired', 'bad state', 'duplicate state', 'denied', 'inactive'])
      ('rejects %s before contacting GitHub', async scenario => {
        await seed({ stripe_subscription_state: 'active' });
        const flow = await begin();
        let path = flow.path, cookie = flow.cookie;
        if (scenario === 'missing cookie') cookie = await loginCookie();
        if (scenario === 'changed session') cookie = `${await loginCookie()}; ${flow.browser}`;
        if (scenario === 'revoked session') await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1').run();
        if (scenario === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601000);
        if (scenario === 'bad state') path = '/login/github/callback?state=invalid&code=test';
        if (scenario === 'duplicate state') path += '&state=another';
        if (scenario === 'denied') path += '&error=access_denied';
        if (scenario === 'inactive') await env.DB.prepare("UPDATE members SET stripe_subscription_state = 'canceled'").run();
        const response = await api(path, { headers: { Cookie: cookie } });
        expect(response.status).toBe(scenario === 'inactive' ? 403 : 400);
        expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
        expect((await readMember()).github_user_id).toBeNull();
      });

    it.each(['another member', 'different account'])('rejects linking an account belonging to %s', async scenario => {
      await seed({ non_billable: 1, ...(scenario === 'different account' ? { github_user_id: '999' } : {}) });
      if (scenario === 'another member') await env.DB.prepare("INSERT INTO members (github_user_id) VALUES ('12345')").run();
      const flow = await begin();
      identity(flow);
      expect((await api(flow.path, { headers: { Cookie: flow.cookie } })).status).toBe(409);
      expect((await readMember()).github_user_id).toBe(scenario === 'different account' ? '999' : null);
    });

    it('rechecks membership authorization inside the coordinator', async () => {
      await seed({ non_billable: 1 });
      const member = await readMember();
      const input = { user: { id: '12345', username: 'octomaker' }, discord_user_id: id, auth_version: member.auth_version };
      await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1').run();
      await expect(coordinated(env, member.member_id, 'linkGithub', input)).rejects.toMatchObject({ status: 401 });
      await env.DB.prepare('UPDATE members SET auth_version = auth_version - 1, non_billable = 0').run();
      await expect(coordinated(env, member.member_id, 'linkGithub', input)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('JWT authentication', () => {
    it.each(['admin', 'member', 'oauth'])('validates %s JWT signatures, audiences, issuers, and expiry', async audience => {
      const subject = audience === 'oauth' ? await hash('browser') : id;
      const token = await issueToken(env, subject, audience);
      expect(await verifyToken(env, token, audience)).toMatchObject({ sub: subject, aud: audience, iss: env.SITE_URL });
      const [header, payload, signature] = token.split('.');
      const changed = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))), sub: '555555555555555555' })).replace(/=+$/, '');
      for (const invalid of ['', 'a'.repeat(64), `${header}.${changed}.${signature}`, `${header}.${payload}.`, `e30.${payload}.${signature}`]) {
        expect(await verifyToken(env, invalid, audience)).toBeNull();
      }
      for (const other of ['admin', 'member', 'oauth'].filter(value => value !== audience)) {
        expect(await verifyToken(env, token, other)).toBeNull();
      }
      expect(await verifyToken({ ...env, AUTH_SECRET: 'different-secret-that-is-at-least-32-bytes' }, token, audience)).toBeNull();
      expect(await verifyToken({ ...env, SITE_URL: 'https://other.example' }, token, audience)).toBeNull();
      const claims = await verifyToken(env, token, audience);
      const clock = vi.spyOn(Date, 'now').mockReturnValue((claims.iat - 1) * 1000);
      expect(await verifyToken(env, token, audience)).toBeNull();
      clock.mockReturnValue(claims.exp * 1000);
      expect(await verifyToken(env, token, audience)).toBeNull();
    });

    it('requires a signing secret before starting OAuth', async () => {
      expect((await api('/signup', undefined, { ...env, AUTH_SECRET: '' })).status).toBe(503);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('prevents member/admin token substitution and invalidates prior member identities', async () => {
      await seed();
      const member = await readMember(), token = await memberToken(env, member);
      expect((await api('/admin', { headers: { Cookie: `thelab_admin=${token}` } })).headers.get('Location')).toContain('discord.com/oauth2/authorize');
      const admin = await issueToken(env, id, 'admin');
      expect((await api('/payment/resume', { headers: { Cookie: `thelab_member=${admin}` } })).headers.get('Location')).toContain('discord.com/oauth2/authorize');
      // An identity transferred away and back retains its incremented auth version.
      await env.DB.prepare('UPDATE members SET auth_version = auth_version + 2').run();
      expect((await api('/payment/resume', { headers: { Cookie: `thelab_member=${token}` } })).headers.get('Location')).toContain('discord.com/oauth2/authorize');
    });

    it.each(['/admin/members/new', '/admin/members/333333333333333333', '/admin?page=2', '/payment/resume', '/payment/success?session_id=cs_member'])('enters OAuth directly and restores %s', async path => {
      await seed({ bill_annually: 1, discount_type: 'student', discord_email: '' });
      const admin = path.startsWith('/admin');
      const response = await api(path);
      expect(response.status).toBe(303);
      const target = new URL(response.headers.get('Location'));
      expect(target.origin).toBe('https://discord.com');
      oauthMock({ roles: admin ? [env.DISCORD_ADMIN_ROLE_ID] : [] });
      const callback = await api(`/login/discord/callback?state=${target.searchParams.get('state')}&code=test`, {
        headers: { Cookie: response.headers.get('Set-Cookie').split(';')[0] },
      });
      expect(callback.headers.get('Location')).toBe(`${env.SITE_URL}${path}`);
      const cookies = callback.headers.get('Set-Cookie');
      expect(cookies).toContain('HttpOnly; SameSite=Lax');
      expect(cookies).toContain('; Secure');
      expect(cookies).toContain('thelab_oauth=;');
      const token = cookies.match(new RegExp(`thelab_${admin ? 'admin' : 'member'}=([^;]+)`))[1];
      expect(await verifyToken(env, token, admin ? 'admin' : 'member')).toMatchObject({ sub: id });
      expect(await readMember()).toMatchObject({ bill_annually: 1, discount_type: 'student' });
      expect((await readMember()).discord_email).toBe(admin ? '' : user.email);
    });

    it('does not accept arbitrary return URLs or replay an expired POST', async () => {
      const response = await api(`/admin/members/${id}?return_to=https://other.example`, { method: 'POST' });
      const pending = await verifyToken(env, new URL(response.headers.get('Location')).searchParams.get('state'), 'oauth');
      expect(pending.return_to).toBe('/admin');
      expect(response.status).toBe(303);
    });
  });

  describe('Discord signup', () => {
    it('binds login to the browser cookie and ignores signup and callback billing and discount inputs', async () => {
      await seedWaiver();
      const { target, state, cookie } = await start('?billing=yearly&discount=student');
      expect(target.origin).toBe('https://discord.com');
      expect(target.searchParams.get('scope')).toBe('identify email');
      expect(target.searchParams.get('redirect_uri')).toBe(`${env.SITE_URL}/login/discord/callback`);
      const claims = await verifyToken(env, state, 'oauth');
      expect(claims).toMatchObject({ sub: await hash(cookie.split('=')[1]), purpose: 'signup', return_to: '/payment/resume' });
      expect(claims).not.toHaveProperty('bill_annually');
      expect(claims).not.toHaveProperty('discount_type');
      expect(claims.exp - claims.iat).toBe(600);
      expect((await api(`/login/discord/callback?code=hello&state=${state}`)).status).toBe(400);
      oauthMock();
      mockPrice(); mockCheckoutEmail();
      mockStripe('/customers', { id: customer }, { method: 'POST' });
      mockStripe('/checkout/sessions', options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('line_items[0][price]')).toBe('price_monthly');
        expect(form.has('discounts[0][coupon]')).toBe(false);
        return { id: 'cs_signup', url: 'https://checkout.stripe.com/c/pay/signup' };
      }, { method: 'POST' });
      const response = await api(`/login/discord/callback?code=hello&state=${state}&discount=&billing=yearly`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/signup');
      expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax');
      expect(await readMember()).toMatchObject({ bill_annually: 0, discount_type: '', stripe_customer_id: customer });
      expect(response.headers.get('Set-Cookie')).toContain('thelab_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      expect((await api(`/login/discord/callback?code=hello&state=${state}`, { headers: { Cookie: 'thelab_oauth=' } })).status).toBe(400);
      // A copied cookie/state pair remains valid, but Discord rejects a reused code.
      mockDiscord('/oauth2/token', { error: 'invalid_grant' }, 'POST', 400);
      expect((await api(`/login/discord/callback?code=hello&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(502);
    });

    it('starts OAuth without database access and uses fresh browser nonces', async () => {
      const first = await api('/signup', undefined, { ...env, DB: undefined });
      const second = await api('/signup', undefined, { ...env, DB: undefined });
      expect(first.status).toBe(303);
      expect(second.status).toBe(303);
      expect(first.headers.get('Set-Cookie')).not.toBe(second.headers.get('Set-Cookie'));
      expect(first.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax; Max-Age=600; Secure');
      expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_states'").all()).results).toEqual([]);
    });

    it('rejects tampered state, mismatched cookies, and session tokens before contacting Discord', async () => {
      const first = await start(), second = await start();
      const [header, payload, signature] = first.state.split('.');
      const changed = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))), purpose: 'admin' })).replace(/=+$/, '');
      const invalid = [
        { state: `${header}.${changed}.${signature}`, cookie: first.cookie },
        { state: first.state, cookie: second.cookie },
        { state: first.state, cookie: `thelab_oauth=${'x'.repeat(64)}` },
        { state: 'a'.repeat(64), cookie: first.cookie },
        ...await Promise.all(['member', 'admin'].map(async audience => ({ state: await issueToken(env, id, audience), cookie: first.cookie }))),
      ];
      for (const { state, cookie } of invalid) {
        const response = await api(`/login/discord/callback?state=${state}&code=code`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(400);
        expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
      }
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      { purpose: 'unknown' }, { purpose: null },
      { return_to: 'https://other.example' },
      { return_to: null }, { purpose: 'admin', return_to: '/payment/resume' },
    ])('rejects invalid signed OAuth claims: %j', async invalid => {
      const { state, cookie } = await start();
      const claims = await verifyToken(env, state, 'oauth');
      const token = await issueToken(env, claims.sub, 'oauth', { ...claims, ...invalid });
      expect((await api(`/login/discord/callback?state=${token}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects expired, duplicate, or declined OAuth state before contacting Discord', async () => {
      const { state, cookie } = await start();
      expect((await api(`/login/discord/callback?state=${state}&state=${state}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400);
      expect((await api(`/login/discord/callback?state=${state}&code=one&code=two`, { headers: { Cookie: cookie } })).status).toBe(400);
      vi.spyOn(Date, 'now').mockReturnValue((now() + 600) * 1000);
      expect((await api(`/login/discord/callback?state=${state}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400);
      const next = await start();
      expect((await api(`/login/discord/callback?state=${next.state}&error=access_denied`, { headers: { Cookie: next.cookie } })).status).toBe(400);
      expect(await readMember()).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([{ verified: false, guildStatus: 200 }, { verified: true, guildStatus: 404 }])('requires verified email and existing guild membership: %j', async (settings) => {
      const { state, cookie } = await start();
      oauthMock(settings);
      const response = await api(`/login/discord/callback?state=${state}&code=hello`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(403);
      expect(await readMember()).toBeNull();
    });

    it('redirects a waiver-signed signup directly to Stripe and persists stable ownership', async () => {
      await seedWaiver();
      const { state, cookie } = await start();
      oauthMock();
      mockPrice();
      mockCheckoutEmail();
      let customerForm, checkoutForm;
      fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/customers', method: 'POST' }).reply(200, options => {
        customerForm = new URLSearchParams(options.body);
        return { id: customer };
      });
      fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
        checkoutForm = new URLSearchParams(options.body);
        return { id: 'cs_member', url: 'https://checkout.stripe.com/c/pay/test' };
      });
      const response = await api(`/login/discord/callback?state=${state}&code=hello`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/test');
      expect(customerForm.get('metadata[thelab_discord_id]')).toBe(id);
      expect(customerForm.has('email')).toBe(false);
      expect(checkoutForm.has('customer_email')).toBe(false);
      expect(checkoutForm.get('subscription_data[metadata][thelab_discord_id]')).toBe(id);
      expect(checkoutForm.get('mode')).toBe('subscription');
      expect(checkoutForm.get('customer_update[name]')).toBe('auto');
      expect(checkoutForm.get('line_items[0][price]')).toBe('price_monthly');
      expect(checkoutForm.get('success_url')).toContain('/payment/success?session_id={CHECKOUT_SESSION_ID}');
      expect(await readMember()).toMatchObject({ stripe_customer_id: customer, discord_email: user.email, billing_email: '' });
    });

    it.each(['signup', 'resume'])('uses the latest admin billing cycle and discount during %s despite user-supplied parameters', async flow => {
      await seed({ discount_type: 'family', bill_annually: 0 });
      await seedWaiver();
      const login = flow === 'signup' ? await start('?billing=monthly&discount=student') : null;
      // An admin edit during OAuth must take effect at checkout.
      await env.DB.prepare("UPDATE members SET bill_annually = 1, discount_type = 'retired' WHERE discord_user_id = ?").bind(id).run();
      if (login) oauthMock();
      mockSubs(); mockPrice(true); mockCheckoutEmail();
      mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_retired', valid: true, metadata: { discountTypes: 'retired' } }], has_more: false });
      mockStripe('/checkout/sessions', options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('discounts[0][coupon]')).toBe('coupon_retired');
        expect(form.get('line_items[0][price]')).toBe('price_yearly');
        return { id: 'cs_current', url: 'https://checkout.stripe.com/c/pay/current' };
      }, { method: 'POST' });
      const response = login
        ? await api(`/login/discord/callback?state=${login.state}&code=test&discount=student&billing=monthly`, { headers: { Cookie: login.cookie } })
        : await api('/payment/resume?discount=student&billing=monthly', { headers: { Cookie: await loginCookie() } });
      expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/current');
      expect(await readMember()).toMatchObject({ bill_annually: 1, discount_type: 'retired' });
    });

    it('resumes the saved selection instead of resetting it to full price', async () => {
      await seed({ bill_annually: 1, discount_type: 'family' });
      mockSubs([subscription()]);
      mockStripe('/billing_portal/sessions', { url: 'https://billing.stripe.com/p/session/resume' }, { method: 'POST' });
      const response = await api('/payment/resume', { headers: { Cookie: await loginCookie() } });
      expect(response.headers.get('Location')).toBe('https://billing.stripe.com/p/session/resume');
      expect(await readMember()).toMatchObject({ bill_annually: 1, discount_type: 'family' });
    });
  });

  describe('member administration', () => {
    let token, cookie;
    beforeEach(() => { token = ''; cookie = ''; });
    const fields = (extra = {}) => ({ discord_user_id: id, stripe_customer_id: customer, stripe_subscription_id: '', name_override: 'Maker Name',
      notes: 'Orientation complete', billing: 'yearly',
      discount_type: 'student', metadata_version: '0', ...extra });
    async function authenticate() {
      token = await issueToken(env, id, 'admin');
      cookie = `thelab_admin=${token}`;
    }
    async function save(values = fields(), options = {}) {
      return api(`/admin/members/${id}`, { method: 'POST', body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`), ...values }),
        headers: { Cookie: cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...options } });
    }

    async function adminPost(path, values = {}, headers = {}) {
      return api(path, { method: 'POST', body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`), ...values }),
        headers: { Cookie: cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
    }
    const newFields = (extra = {}) => ({ email: '  Maker@Example.com ', name_override: 'New Maker', discord_user_id: '',
      notes: 'Meet at open house', billing: 'yearly', discount_type: 'student', ...extra });

    it('creates a member from the list and links the same record on later Discord signup', async () => {
      await authenticate();
      expect(await (await api('/admin', { headers: { Cookie: cookie } })).text()).toContain('href="/admin/members/new"');
      expect((await api('/admin/members/new', { headers: { Cookie: cookie } })).status).toBe(200);
      const response = await adminPost('/admin/members/new', newFields());
      expect(response.status).toBe(303);
      const member = await env.DB.prepare('SELECT * FROM members WHERE email = ?').bind(user.email).first();
      expect(response.headers.get('Location')).toBe(`/admin/members/${member.member_id}?created=1`);
      expect(member).toMatchObject({ name_override: 'New Maker', notes: 'Meet at open house', discord_user_id: null,
        bill_annually: 1, discount_type: 'student', stripe_customer_id: null });
      expect((await queryEvents(env)).events.map(event => event.event_type)).toEqual(['MemberRegistered']);
      expect(await registerMember(env, user)).toMatchObject({ member_id: member.member_id, discord_user_id: id, bill_annually: 1, discount_type: 'student' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('validates optional Discord membership and rejects duplicate member creation', async () => {
      await authenticate();
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}`, { user });
      expect((await adminPost('/admin/members/new', newFields({ discord_user_id: id }))).status).toBe(303);
      expect(await readMember()).toMatchObject({ discord_username: user.username, discord_email: '', email: user.email });
      for (const values of [newFields(), newFields({ email: 'other@example.com', discord_user_id: id })]) {
        const response = await adminPost('/admin/members/new', values);
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('already belongs to a member');
      }
      await env.DB.prepare('UPDATE members SET email = NULL').run();
      await env.DB.prepare('UPDATE members SET discord_email = ?').bind(user.email).run();
      expect((await adminPost('/admin/members/new', newFields())).status).toBe(409);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM members').first()).count).toBe(1);
    });

    it('preserves invalid creation drafts and prevents concurrent duplicate inserts', async () => {
      await authenticate();
      for (const extra of [{ email: 'bad' }, { billing: 'weekly' }, { discount_type: 'fake' }, { discord_user_id: 'bad' }]) {
        const response = await adminPost('/admin/members/new', newFields(extra));
        expect(response.status).toBe(400);
        expect(await response.text()).toContain('value="New Maker"');
      }
      const results = await Promise.all([adminPost('/admin/members/new', newFields()), adminPost('/admin/members/new', newFields())]);
      expect(results.map(result => result.status).sort()).toEqual([303, 409]);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM members').first()).count).toBe(1);
    });

    it('protects member actions with admin authentication, CSRF, and POST-only checkout/deletion', async () => {
      await seed(); await authenticate();
      for (const path of ['/admin/members/new', `/admin/members/${id}/checkout`, `/admin/members/${id}/delete`]) {
        expect((await adminPost(path, newFields(), { Cookie: '' })).status).toBe(303);
        expect((await adminPost(path, { ...newFields(), csrf: 'wrong' })).status).toBe(403);
        expect((await adminPost(path, newFields(), { Origin: 'https://other.example' })).status).toBe(403);
        expect((await adminPost(path, newFields(), { Cookie: `thelab_admin=${await memberToken(env, await readMember())}` })).status).toBe(303);
      }
      expect((await api(`/admin/members/${id}/checkout`, { headers: { Cookie: cookie } })).status).toBe(405);
      expect((await api(`/admin/members/${id}/delete`, { headers: { Cookie: cookie } })).status).toBe(405);
      expect(await readMember()).not.toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('deletes a member, revokes their session and role, and retains waiver and fob history', async () => {
      await seed({ fob_id: 123, non_billable: 1 }); await authenticate();
      const member = await readMember(), memberCookie = await loginCookie();
      await seedWaiver(member);
      const page = await api(`/admin/members/${id}`, { headers: { Cookie: cookie } });
      expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
      const html = await page.text();
      expect(html).toContain(`action="/admin/members/${member.member_id}/delete"`);
      expect(html).toContain('form="delete-member" disabled>Delete member');
      expect(html).toContain('<script src="/script.js" defer></script>');
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      const revision = await env.DB.prepare('SELECT revision FROM edge_changes').first();
      const response = await adminPost(`/admin/members/${member.member_id}/delete`);
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe('/admin');
      expect(await readMember()).toBeNull();
      expect(await env.DB.prepare('SELECT member_id, name FROM waivers').first()).toEqual({ member_id: null, name: 'Test Maker' });
      const assignment = await env.DB.prepare('SELECT member_id, ended FROM fob_assignments WHERE fob = 123').first();
      expect(assignment.member_id).toBeNull();
      expect(assignment.ended).not.toBeNull();
      expect((await env.DB.prepare('SELECT revision FROM edge_changes').first()).revision).toBeGreaterThan(revision.revision);
      const events = (await queryEvents(env)).events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(event => event.member_id === null)).toBe(true);
      expect((await api('/payment/resume', { headers: { Cookie: memberCookie } })).headers.get('Location')).toContain('discord.com/oauth2/authorize');
      await expect(coordinated(env, member.member_id, 'sync')).resolves.toBeUndefined();
    });

    it('deletes an unlinked member without provider calls', async () => {
      await authenticate();
      const created = await adminPost('/admin/members/new', newFields());
      const path = created.headers.get('Location').split('?')[0];
      expect((await adminPost(`${path}/delete`)).status).toBe(303);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM members').first()).count).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('keeps the member when role removal fails and allows retry if they have left Discord', async () => {
      await seed(); await authenticate();
      const path = `/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`;
      mockDiscord(path, {}, 'DELETE', 403);
      expect((await adminPost(`/admin/members/${id}/delete`)).status).toBe(502);
      expect(await readMember()).not.toBeNull();
      mockDiscord(path, {}, 'DELETE', 404);
      expect((await adminPost(`/admin/members/${id}/delete`)).status).toBe(303);
      expect(await readMember()).toBeNull();
    });

    it('generates and reuses a shareable checkout without Discord or a waiver, then syncs payment to that member', async () => {
      await authenticate();
      const created = await adminPost('/admin/members/new', newFields());
      const path = created.headers.get('Location').split('?')[0];
      const member = await env.DB.prepare('SELECT * FROM members').first();
      const url = 'https://checkout.stripe.com/c/pay/shared';
      mockPrice(true); mockCheckoutEmail();
      mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }], has_more: false });
      mockStripe('/customers', options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('metadata[thelab_member_id]')).toBe(member.member_id);
        expect(form.has('metadata[thelab_discord_id]')).toBe(false);
        expect(form.get('name')).toBe('New Maker');
        return { id: customer };
      }, { method: 'POST' });
      mockStripe('/checkout/sessions', options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('client_reference_id')).toBe(member.member_id);
        expect(form.get('metadata[thelab_member_id]')).toBe(member.member_id);
        expect(form.get('subscription_data[metadata][thelab_member_id]')).toBe(member.member_id);
        expect(form.has('metadata[thelab_discord_id]')).toBe(false);
        expect(form.get('line_items[0][price]')).toBe('price_yearly');
        expect(form.get('discounts[0][coupon]')).toBe('coupon_student');
        expect(form.get('success_url')).toBe(`${env.SITE_URL}/welcome`);
        return { id: 'cs_shared', url };
      }, { method: 'POST' });
      const response = await adminPost(`${path}/checkout`, { billing: 'monthly', discount_type: '' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toContain(`readonly value="${url}"`);
      mockSubs(); mockPrice(true); mockCheckoutEmail();
      mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }], has_more: false });
      mockStripe('/checkout/sessions/cs_shared', { id: 'cs_shared', status: 'open', url });
      expect(await (await adminPost(`${path}/checkout`)).text()).toContain(url);
      mockBilling(); mockSubs([{ ...subscription(), metadata: { thelab_member_id: member.member_id } }]);
      await processMessage({ customer_id: customer }, env);
      expect(await env.DB.prepare('SELECT stripe_subscription_state, discord_user_id FROM members').first())
        .toEqual({ stripe_subscription_state: 'active', discord_user_id: null });
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM waivers').first()).count).toBe(0);
    });

    it.each(['active', 'trialing', 'past_due', 'incomplete'])('does not generate a shared checkout or portal for an ongoing %s subscription', async state => {
      await seed(); await authenticate();
      mockSubs([subscription(state)]);
      const response = await adminPost(`/admin/members/${id}/checkout`);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('already has an ongoing subscription');
    });

    it('blocks duplicate shared checkouts while a completed payment is still processing', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_shared', url: 'https://checkout.stripe.com/c/pay/shared' }, { method: 'POST' });
      expect((await adminPost(`/admin/members/${id}/checkout`)).status).toBe(200);
      mockSubs().times(2);
      mockStripe('/checkout/sessions/cs_shared', { id: 'cs_shared', status: 'complete', subscription: 'sub_pending' });
      const response = await adminPost(`/admin/members/${id}/checkout`);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain('previous checkout is being processed');
    });

    it('recovers shared checkout creation after an ambiguous Stripe failure using the same idempotency key', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      let key;
      mockStripe('/checkout/sessions', options => {
        key = options.headers['Idempotency-Key'];
        expect(key).toBeTruthy();
        return {};
      }, { method: 'POST', status: 500 });
      expect((await adminPost(`/admin/members/${id}/checkout`)).status).toBe(502);
      mockSubs(); mockPrice(); mockCheckoutEmail();
      const session = { id: 'cs_recovered', status: 'open', url: 'https://checkout.stripe.com/c/pay/recovered' };
      mockStripe('/checkout/sessions', options => {
        expect(options.headers['Idempotency-Key']).toBe(key);
        return session;
      }, { method: 'POST' });
      mockStripe('/checkout/sessions/cs_recovered', session);
      const response = await adminPost(`/admin/members/${id}/checkout`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(session.url);
    });

    it('expires a shared checkout on billing edits and generates a replacement at the new price', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_shared', url: 'https://checkout.stripe.com/c/pay/shared' }, { method: 'POST' });
      expect((await adminPost(`/admin/members/${id}/checkout`)).status).toBe(200);
      mockStripe('/checkout/sessions/cs_shared', { id: 'cs_shared', status: 'open' });
      mockStripe('/checkout/sessions/cs_shared/expire', { status: 'expired' }, { method: 'POST' });
      expect((await save(fields({ discount_type: '' }))).status).toBe(303);
      mockSubs(); mockPrice(true); mockCheckoutEmail();
      mockStripe('/checkout/sessions', options => {
        expect(new URLSearchParams(options.body).get('line_items[0][price]')).toBe('price_yearly');
        return { id: 'cs_replacement', url: 'https://checkout.stripe.com/c/pay/replacement' };
      }, { method: 'POST' });
      expect(await (await adminPost(`/admin/members/${id}/checkout`)).text()).toContain('/pay/replacement');
    });

    it('expires an open checkout link before deleting the member', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_shared', url: 'https://checkout.stripe.com/c/pay/shared' }, { method: 'POST' });
      expect((await adminPost(`/admin/members/${id}/checkout`)).status).toBe(200);
      mockStripe('/checkout/sessions/cs_shared', { id: 'cs_shared', status: 'open' });
      mockStripe('/checkout/sessions/cs_shared/expire', { status: 'expired' }, { method: 'POST' });
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      expect((await adminPost(`/admin/members/${id}/delete`)).status).toBe(303);
      expect(await readMember()).toBeNull();
    });

    it('records committed admin edits once and leaves history intact on stale or invalid saves', async () => {
      await seed(); await authenticate();
      expect((await save()).status).toBe(303);
      const history = await queryEvents(env);
      expect(history.events.map(event => event.event_type).sort()).toEqual([
        'BillingCycleChanged', 'DiscountTypeModified', 'MemberRegistered', 'NameOverrideChanged', 'NotesUpdated',
      ]);
      expect(history.events.find(event => event.event_type === 'NotesUpdated').details).toBe('{}');
      expect(JSON.stringify(history)).not.toContain('Orientation complete');
      expect((await save()).status).toBe(409);
      expect((await save(fields({ metadata_version: '1', discount_type: 'bogus' }))).status).toBe(400);
      expect((await queryEvents(env)).events).toEqual(history.events);
    });

    it('isolates admin OAuth from signup, requires a role, and clears the browser cookie', async () => {
      const response = await api('/admin/login', undefined, { ...env, STRIPE_SECRET_KEY: '', DB: undefined });
      expect(response.status).toBe(303);
      const state = new URL(response.headers.get('Location')).searchParams.get('state');
      const browser = response.headers.get('Set-Cookie').split(';')[0];
      expect((await api(`/login/discord/callback?state=${state}&code=test`)).status).toBe(400);
      oauthMock({ roles: [env.DISCORD_ADMIN_ROLE_ID] });
      const signedIn = await api(`/login/discord/callback?state=${state}&code=test`, { headers: { Cookie: browser } }, { ...env, STRIPE_SECRET_KEY: '', DB: undefined });
      expect(signedIn.status).toBe(303);
      expect(signedIn.headers.get('Location')).toBe(`${env.SITE_URL}/admin`);
      expect(signedIn.headers.get('Set-Cookie')).toContain('thelab_admin=');
      expect(signedIn.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax');
      expect(await readMember()).toBeNull();
      expect(signedIn.headers.get('Set-Cookie')).not.toContain('thelab_member=');
      expect(signedIn.headers.get('Set-Cookie')).toContain('thelab_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
      expect((await api(`/login/discord/callback?state=${state}&code=test`, { headers: { Cookie: 'thelab_oauth=' } })).status).toBe(400);
      const denied = await api('/admin/login');
      const deniedState = new URL(denied.headers.get('Location')).searchParams.get('state');
      oauthMock();
      expect((await api(`/login/discord/callback?state=${deniedState}&code=test`, { headers: { Cookie: denied.headers.get('Set-Cookie').split(';')[0] } })).status).toBe(403);
    });

    it('rejects anonymous, expired, and unconfigured access to reads and writes', async () => {
      expect((await api('/admin')).headers.get('Location')).toContain('https://discord.com/oauth2/authorize?');
      expect((await save()).status).toBe(303);
      await seed();
      expect((await api('/admin', { headers: { Cookie: await loginCookie() } })).status).toBe(303);
      await authenticate();
      expect((await api('/admin', { headers: { Cookie: cookie } }, { ...env, DISCORD_ADMIN_ROLE_ID: '' })).status).toBe(503);
      vi.spyOn(Date, 'now').mockReturnValue((now() + 8 * 3600) * 1000);
      expect((await api(`/admin/members/${id}`, { headers: { Cookie: cookie } })).status).toBe(303);
      expect((await save()).status).toBe(303);
      expect((await readMember()).metadata_version).toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('authorizes admin reads and saves from the signed session without Discord requests', async () => {
      await seed(); await authenticate();
      for (const path of ['/admin', `/admin/members/${id}`, '/admin/events', `/admin/members/${id}/events`]) {
        expect((await api(path, { headers: { Cookie: cookie } }, { ...env, DISCORD_BOT_TOKEN: '' })).status).toBe(200);
      }
      expect((await save()).status).toBe(303);
      expect((await readMember()).name_override).toBe('Maker Name');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('logs unexpected admin database errors with context and keeps details out of HTML', async () => {
      await authenticate();
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const response = await api('/admin?code=private-code', { headers: { Cookie: cookie } }, {
        ...env, DB: { prepare() { throw new Error('D1 connection failed', { cause: new Error('database offline') }); } },
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('D1 connection failed');
      const entry = JSON.parse(log.mock.calls[0][0]);
      expect(entry).toMatchObject({ event: 'admin.failed', path: '/admin', method: 'GET', status: 500,
        error: { message: 'D1 connection failed', cause: { message: 'database offline' } } });
      expect(entry.error.stack).toContain('membership.test.js');
      expect(entry.request_id).toBeTruthy();
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-code');
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    });

    it('paginates eligible members with deterministic ordering and handles empty/invalid pages', async () => {
      await authenticate();
      expect(await (await api('/admin', { headers: { Cookie: cookie } })).text()).toContain('No members match your search and filters.');
      await env.DB.batch(Array.from({ length: 26 }, (_, i) => env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, created, legacy_waiver_signed) VALUES (?, ?, ?, ?, 1)')
        .bind(String(BigInt(id) + BigInt(i)), `maker-${i}`, `maker${i}@example.com`, 1000)));
      const first = await api('/admin', { headers: { Cookie: cookie } });
      const html = await first.text();
      expect(first.headers.get('Cache-Control')).toBe('no-store');
      expect(html).toContain('26 matching members');
      expect(html).toContain('Page 1 of 2');
      expect(html.match(/href="\/admin\/members\/[0-9]/g)).toHaveLength(25);
      expect(html).toContain('>maker-25</a>');
      expect(html).not.toContain('>maker-0</a>');
      const second = await (await api('/admin?page=2', { headers: { Cookie: cookie } })).text();
      expect(second.match(/href="\/admin\/members\/[0-9]/g)).toHaveLength(1);
      expect(second).toContain('>maker-0</a>');
      expect((await api('/admin?page=3', { headers: { Cookie: cookie } })).headers.get('Location')).toBe('/admin?page=2');
      expect((await api('/admin?page=-1', { headers: { Cookie: cookie } })).status).toBe(400);
    });

    it('combines waiver, Discord, payment, and search filters with signed/linked defaults', async () => {
      const members = [];
      const billing = [
        { payment: 'inactive', state: null },
        { payment: 'inactive', state: 'past_due' },
        { payment: 'inactive', state: 'canceled' },
        { payment: 'stripe_active', state: 'active' },
        { payment: 'stripe_active', state: 'trialing' },
        { payment: 'legacy_billing', state: 'active', legacy: 1 },
        { payment: 'non_billable', state: 'active', legacy: 1, nonBillable: 1 },
      ];
      for (const waiver of ['unsigned', 'legacy', 'signed']) {
        for (const linked of [false, true]) {
          for (const status of billing) {
            const name = `filter-${members.length}`;
            const member = await env.DB.prepare(`INSERT INTO members
              (name_override, discord_user_id, legacy_waiver_signed, stripe_subscription_state, legacy_billing, non_billable)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`)
              .bind(name, linked ? String(BigInt(id) + BigInt(members.length)) : null, waiver === 'legacy' ? 1 : 0,
                status.state, status.legacy || 0, status.nonBillable || 0).first();
            if (waiver === 'signed') await seedWaiver(member);
            members.push({ name, signed: waiver !== 'unsigned', linked, payment: status.payment });
          }
        }
      }
      await authenticate();
      const check = async (params, expected) => {
        const response = await api(`/admin?${new URLSearchParams(params)}`, { headers: { Cookie: cookie } });
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain(`${expected.length} matching members`);
        expect([...html.matchAll(/>(filter-\d+)<\/a>/g)].map(match => match[1]).sort()).toEqual(expected.map(m => m.name).sort());
        return html;
      };
      const defaults = await check({}, members.filter(m => m.signed && m.linked));
      expect(defaults).toContain('<option value="signed" selected>Waiver signed</option>');
      expect(defaults).toContain('<option value="linked" selected>Discord linked</option>');
      expect(defaults).toContain('<option value="all" selected>Any payment status</option>');
      for (const waiver of ['signed', 'unsigned', 'all']) {
        for (const discord of ['linked', 'unlinked', 'all']) {
          if (waiver === 'all' && discord === 'all') continue; // Covered by the paginated unfiltered view below.
          const expected = members.filter(m => (waiver === 'all' || m.signed === (waiver === 'signed'))
            && (discord === 'all' || m.linked === (discord === 'linked')));
          if (expected.length <= 25) await check({ waiver, discord }, expected);
        }
      }
      for (const payment of ['inactive', 'non_billable', 'legacy_billing', 'stripe_active']) {
        await check({ waiver: 'all', discord: 'all', payment, q: 'filter-' }, members.filter(m => m.payment === payment));
        await check({ payment, q: 'filter-' }, members.filter(m => m.signed && m.linked && m.payment === payment));
      }
      const all = await (await api('/admin?waiver=all&discord=all', { headers: { Cookie: cookie } })).text();
      expect(all).toContain('42 registered members');
      expect(all).toContain('Page 1 of 2');
      expect(all).toContain('href="/admin?page=2&amp;waiver=all&amp;discord=all"');
      for (const query of ['waiver=bad', 'discord=', 'payment=active', 'waiver=signed&waiver=all', 'discord=linked&discord=all', 'payment=inactive&payment=all']) {
        expect((await api(`/admin?${query}`, { headers: { Cookie: cookie } })).status).toBe(400);
        expect(loginDestination(`/admin?${query}`, 'admin')).toBe('/admin');
      }
    });

    it.each([
      ['discord_user_id', id, id.slice(3)],
      ['discord_username', 'Workshop.Handle', 'SHOP.han'],
      ['discord_email', 'discord-contact@example.com', 'CORD-contact@'],
      ['billing_name', 'Stripe Billing Person', 'BILLING per'],
      ['billing_email', 'stripe-contact@example.com', 'IPE-contact@'],
      ['name_override', 'Preferred Member Name', 'FERRED mem'],
      ['fob_id', 4294967295, '4294967295'],
      ['fob_id', 4294967295, '949672'],
    ])('searches partial values in %s', async (column, value, query) => {
      await seed({ [column]: value });
      await seedWaiver(await readMember());
      const otherID = '555555555555555555';
      await env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email) VALUES (?, ?, ?)')
        .bind(otherID, 'unrelated', 'unrelated@example.com').run();
      await authenticate();
      const response = await api(`/admin?${new URLSearchParams({ q: `  ${query}  ` })}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('1 matching member');
      expect(html).toContain(`href="/admin/members/${id}"`);
      expect(html).not.toContain(`href="/admin/members/${otherID}"`);
      expect(html).toContain(`value="${query}"`);
    });

    it('treats search wildcards literally, escapes HTML, and handles empty and invalid searches', async () => {
      await seed({ billing_name: '100%_\\special' });
      await seedWaiver(await readMember());
      await authenticate();
      for (const query of ['%', '_', '\\']) {
        const html = await (await api(`/admin?${new URLSearchParams({ q: query })}`, { headers: { Cookie: cookie } })).text();
        expect(html).toContain(`href="/admin/members/${id}"`);
      }
      await env.DB.prepare("UPDATE members SET billing_name = ''").run();
      for (const query of ['%', '_', '\\', "' OR 1=1 --", '"><script>alert(1)</script>']) {
        const html = await (await api(`/admin?${new URLSearchParams({ q: query })}`, { headers: { Cookie: cookie } })).text();
        expect(html).toContain('0 matching members');
        expect(html).toContain('No members match your search and filters.');
        expect(html).not.toContain(`href="/admin/members/${id}"`);
        expect(html).not.toContain('<script>');
        if (query.includes('<script>')) expect(html).toContain('&lt;script&gt;');
      }
      const empty = await (await api('/admin?q=++', { headers: { Cookie: cookie } })).text();
      expect(empty).toContain('1 matching member');
      for (const query of ['q=one&q=two', `q=${'x'.repeat(255)}`]) {
        expect((await api(`/admin?${query}`, { headers: { Cookie: cookie } })).status).toBe(400);
      }
    });

    it('paginates filtered results and preserves the query in links and page redirects', async () => {
      await seed();
      await env.DB.batch(Array.from({ length: 26 }, (_, i) => env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, billing_name, created) VALUES (?, ?, ?, ?, ?)')
        .bind(String(BigInt(id) + BigInt(i + 1)), `person-${i}`, '', 'Search & Match', 1000)));
      await authenticate();
      const filters = '&waiver=unsigned&discord=all&payment=inactive';
      const first = await (await api(`/admin?q=Search+%26+Match${filters}`, { headers: { Cookie: cookie } })).text();
      expect(first).toContain('26 matching members');
      expect(first.match(/href="\/admin\/members\/[0-9]/g)).toHaveLength(25);
      expect(first).toContain('href="/admin?page=2&amp;q=Search+%26+Match&amp;waiver=unsigned&amp;discord=all&amp;payment=inactive"');
      expect(first).toContain('href="/admin?page=1&amp;waiver=unsigned&amp;discord=all&amp;payment=inactive">Clear search</a>');
      expect(first).toContain('method="get" action="/admin"');
      expect(first).not.toContain('name="page"');
      const second = await (await api(`/admin?page=2&q=Search+%26+Match${filters}`, { headers: { Cookie: cookie } })).text();
      expect(second.match(/href="\/admin\/members\/[0-9]/g)).toHaveLength(1);
      expect(second).toContain('href="/admin?page=1&amp;q=Search+%26+Match&amp;waiver=unsigned&amp;discord=all&amp;payment=inactive"');
      expect((await api(`/admin?page=3&q=Search+%26+Match${filters}`, { headers: { Cookie: cookie } })).headers.get('Location'))
        .toBe(`/admin?page=2&q=Search+%26+Match${filters}`);
      expect((await api('/admin?page=3&q=absent', { headers: { Cookie: cookie } })).headers.get('Location')).toBe('/admin?page=1&q=absent');
    });

    it('preserves searches through admin OAuth and only accepts known return destinations', async () => {
      const destination = '/admin?q=Maker+%26+Co%40example.com&page=2&waiver=all&discord=unlinked&payment=legacy_billing';
      const response = await api(destination);
      const state = new URL(response.headers.get('Location')).searchParams.get('state');
      expect((await verifyToken(env, state, 'oauth')).return_to).toBe(destination);
      oauthMock({ roles: [env.DISCORD_ADMIN_ROLE_ID] });
      const signedIn = await api(`/login/discord/callback?state=${state}&code=test`, { headers: { Cookie: response.headers.get('Set-Cookie').split(';')[0] } });
      expect(signedIn.headers.get('Location')).toBe(`${env.SITE_URL}${destination}`);
      for (const invalid of ['//evil.example/admin?q=x', '/admin?redirect=https://evil.example', '/admin?q=x&q=y', '/admin?q=x&page=-1', '/admin?q=x#fragment']) {
        expect(loginDestination(invalid, 'admin')).toBe('/admin');
      }
    });

    it('saves editable metadata without changing Stripe state, escapes HTML, and rejects stale forms', async () => {
      const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await seed({ stripe_subscription_id: 'sub_member', stripe_subscription_state: 'active' });
      await authenticate();
      const result = await save(fields({ notes: '<script>alert(1)</script>', stripe_subscription_id: 'sub_member', stripe_subscription_state: 'canceled',
        discord_username: 'forged', discord_email: 'forged@example.com', billing_name: 'forged', billing_email: 'forged@example.com' }));
      expect(result.status).toBe(303);
      expect(await readMember()).toMatchObject({ discord_username: user.username, discord_email: user.email, name_override: 'Maker Name', billing_name: '', billing_email: '',
        bill_annually: 1, discount_type: 'student', metadata_version: 1,
        stripe_customer_id: customer, stripe_subscription_state: 'active', stripe_subscription_id: 'sub_member' });
      const view = await api(`/admin/members/${id}?saved=1`, { headers: { Cookie: cookie } });
      const html = await view.text();
      expect(html).toContain('Member metadata saved.');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('custom_metadata');
      expect(html).not.toContain('contact_name');
      expect(html).not.toContain('discount_status');
      for (const name of ['discord_username', 'discord_email', 'billing_name', 'billing_email']) {
        expect(html).not.toContain(`name="${name}"`);
      }
      expect(html).toContain(`<dt>Discord username</dt><dd>${user.username}</dd>`);
      expect(html).toContain(`<dt>Discord email</dt><dd>${user.email}</dd>`);
      expect(html).toContain('<dt>Billing name (Stripe)</dt><dd>—</dd>');
      expect(html).toContain('<dt>Billing email (Stripe)</dt><dd>—</dd>');
      expect(html).toContain('<details class="admin-section admin-linked-accounts">');
      for (const name of ['discord_user_id', 'stripe_customer_id', 'stripe_subscription_id']) {
        expect(html).toMatch(new RegExp(`<input id="${name}"[^>]+name="${name}"`));
      }
      expect(html).toContain(await hash(`admin-csrf:${token}`));
      expect(view.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
      const stale = await save(fields({ notes: 'Stale notes' }));
      expect(stale.status).toBe(409);
      const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
      const operation = entries.find(entry => entry.event === 'membership.failed');
      expect(operation).toMatchObject({ status: 409, operation: 'updateMetadata' });
      expect(entries.find(entry => entry.event === 'admin.save_failed')).toMatchObject({ status: 409, error_id: operation.error_id });
      const staleHTML = await stale.text();
      expect(staleHTML).toContain('Stale notes');
      expect(staleHTML).toContain('<details class="admin-section admin-linked-accounts" open>');
      expect(staleHTML).toContain('admin-notice--error" role="alert"');
      expect((await readMember()).notes).toBe('<script>alert(1)</script>');
    });

    it('rejects cross-site and malformed saves before changing data', async () => {
      await seed(); await authenticate();
      expect((await save(fields(), { Origin: 'https://elsewhere.example' })).status).toBe(403);
      expect((await save({ ...fields(), csrf: 'wrong' })).status).toBe(403);
      expect((await save(fields(), { 'Content-Type': 'application/json' })).status).toBe(415);
      for (const invalid of [{ discount_type: 'free' }, { billing: 'weekly' }, { discord_user_id: 'invalid' }, { stripe_customer_id: 'bad' },
        { stripe_subscription_id: 'bad' }, { stripe_customer_id: '', stripe_subscription_id: 'sub_member' }, { name_override: 'x'.repeat(161) }, { notes: 'x'.repeat(5001) }]) {
        const response = await save(fields(invalid));
        expect(response.status).toBe(400);
        const html = await response.text();
        expect(html).toContain('<details class="admin-section admin-linked-accounts" open>');
        for (const name of ['discord_user_id', 'stripe_customer_id', 'stripe_subscription_id']) {
          if (name in invalid) expect(html).toContain(`name="${name}" type="text" value="${invalid[name]}"`);
        }
      }
      expect((await readMember()).metadata_version).toBe(0);
      expect((await api('/admin/members/999999999999999999', { headers: { Cookie: cookie } })).status).toBe(404);
    });

    it.each([
      ['active', 'sub_member', 'Active'],
      ['trialing', 'sub_member', 'Trialing'],
      ['past_due', 'sub_member', 'Past due'],
      ['canceled', 'sub_member', 'Canceled'],
      [null, 'sub_member', 'Unknown — not yet synced'],
      [null, null, 'No subscription'],
    ])('shows stored subscription status and dashboard links: %s / %s', async (state, subscriptionID, label) => {
      await seed({ stripe_subscription_state: state, stripe_subscription_id: subscriptionID, stripe_synced_at: 1000 });
      await seedWaiver(await readMember());
      await authenticate();
      for (const path of ['/admin', `/admin/members/${id}`]) {
        const html = await (await api(path, { headers: { Cookie: cookie } })).text();
        expect(html).toContain(`>${label}</span>`);
        if (path === '/admin') expect(html).not.toContain('1970-01-01 00:16:40 UTC');
        else expect(html).toContain('1970-01-01 00:16:40 UTC');
        if (subscriptionID) expect(html).toContain('href="https://dashboard.stripe.com/test/subscriptions/sub_member" target="_blank" rel="noopener noreferrer"');
        else expect(html).not.toContain('dashboard.stripe.com');
      }
      if (subscriptionID) {
        const html = await (await api(`/admin/members/${id}`, { headers: { Cookie: cookie } }, { ...env, STRIPE_SECRET_KEY: 'sk_live_fake' })).text();
        expect(html).toContain('href="https://dashboard.stripe.com/subscriptions/sub_member"');
      }
    });

    it.each([
      { name_override: 'Preferred Name', billing_name: 'Billing Name', expected: 'Preferred Name' },
      { name_override: '', billing_name: 'Billing Name', expected: 'Billing Name' },
      { name_override: ' ', billing_name: ' ', expected: user.username },
    ])('uses the same name precedence in member lists and editor titles: $expected', async ({ expected, ...names }) => {
      await seed(names); await authenticate();
      await seedWaiver(await readMember());
      expect(await (await api('/admin', { headers: { Cookie: cookie } })).text()).toContain(`>${expected}</a>`);
      expect(await (await api(`/admin/members/${id}`, { headers: { Cookie: cookie } })).text()).toContain(`<h1>Edit ${expected}</h1>`);
    });

    it('transfers Discord identity while retaining billing, the stable lock, and automatic subscription selection', async () => {
      const replacement = '555555555555555555';
      await seed({ stripe_subscription_id: 'sub_member', stripe_subscription_state: 'active' });
      await authenticate(); const oldCookie = await loginCookie();
      const before = await readMember();
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${replacement}`, { user: { id: replacement, username: 'new-maker' } });
      mockBilling();
      mockStripe('/subscriptions/sub_member', subscription());
      mockSubs([subscription()]);
      const metadata = options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('metadata[thelab_discord_id]')).toBe(replacement);
        expect(form.get('metadata[thelab_member_id]')).toBe(before.member_id);
        return {};
      };
      mockStripe('/subscriptions/sub_member', metadata, { method: 'POST' });
      mockStripe(`/customers/${customer}`, metadata, { method: 'POST' });
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      const response = await save(fields({ discord_user_id: replacement, stripe_subscription_id: 'sub_member' }));
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toBe(`/admin/members/${replacement}?saved=1`);
      expect(await readMember()).toBeNull();
      const member = await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(replacement).first();
      expect(member).toMatchObject({ member_id: before.member_id, discord_username: 'new-maker', discord_email: '',
        billing_name: 'Billing Maker', billing_email: 'billing@example.com', stripe_customer_id: customer });
      expect(member.auth_version).toBe(before.auth_version + 1);
      expect((await api('/payment/resume', { headers: { Cookie: oldCookie } })).headers.get('Location')).toContain('https://discord.com/oauth2/authorize?');
      mockBilling();
      mockSubs([{ ...subscription(), metadata: { thelab_member_id: before.member_id }, status: 'canceled' },
        { ...subscription('active', 'sub_new'), metadata: { thelab_member_id: before.member_id } }]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${replacement}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
      await processMessage({ member_id: before.member_id }, env);
      expect(await env.DB.prepare('SELECT stripe_subscription_id FROM members WHERE member_id = ?').bind(before.member_id).first())
        .toEqual({ stripe_subscription_id: 'sub_new' });
    });

    it('changes Stripe IDs, fetches billing details, and clears old customer idempotency state', async () => {
      await seed(); await authenticate();
      const stub = await memberStub();
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put('customer', { result: { id: customer } });
      });
      mockStripe('/customers/cus_new', { id: 'cus_new', name: 'New Billing', email: 'new@example.com' });
      mockStripe('/subscriptions/sub_new', { ...subscription('past_due', 'sub_new'), customer: 'cus_new' });
      mockStripe('/subscriptions/sub_new', {}, { method: 'POST' });
      mockStripe('/customers/cus_new', {}, { method: 'POST' });
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      expect((await save(fields({ stripe_customer_id: 'cus_new', stripe_subscription_id: 'sub_new' }))).status).toBe(303);
      expect(await readMember()).toMatchObject({ stripe_customer_id: 'cus_new', stripe_subscription_id: 'sub_new',
        stripe_subscription_state: 'past_due', billing_name: 'New Billing', billing_email: 'new@example.com', stripe_synced_at: null });
      await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.get('customer')).toBeUndefined(); });
    });

    it('rejects duplicate identities and mismatched Stripe subscriptions before changing the member', async () => {
      await seed(); await authenticate();
      const other = '555555555555555555';
      await env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, stripe_customer_id) VALUES (?, ?, ?, ?)')
        .bind(other, 'other', 'other@example.com', 'cus_other').run();
      for (const edit of [{ discord_user_id: other }, { stripe_customer_id: 'cus_other' }]) {
        expect((await save(fields(edit))).status).toBe(409);
      }
      mockBilling();
      mockStripe('/subscriptions/sub_wrong', { ...subscription('active', 'sub_wrong'), customer: 'cus_other' });
      expect((await save(fields({ stripe_subscription_id: 'sub_wrong' }))).status).toBe(400);
      expect(await readMember()).toMatchObject({ metadata_version: 0, stripe_customer_id: customer, stripe_subscription_id: null });
    });

    it('expires open checkout for an identity-only edit and restores the new Discord email at sign-in', async () => {
      const replacement = '555555555555555555';
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_transfer', url: 'https://checkout.stripe.com/c/pay/transfer' }, { method: 'POST' });
      await checkout();
      const member = await readMember();
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${replacement}`, { user: { id: replacement, username: 'new-maker' } });
      mockBilling();
      mockStripe('/checkout/sessions/cs_transfer', { id: 'cs_transfer', status: 'open' });
      mockStripe('/checkout/sessions/cs_transfer/expire', { status: 'expired' }, { method: 'POST' });
      mockSubs();
      mockStripe(`/customers/${customer}`, {}, { method: 'POST' });
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      expect((await save(fields({ discord_user_id: replacement, billing: 'monthly', discount_type: '',
        metadata_version: String(member.metadata_version) }))).status).toBe(303);
      mockSubs([{ ...subscription(), metadata: { thelab_member_id: member.member_id } }]);
      mockStripe('/billing_portal/sessions', { url: 'https://billing.stripe.com/p/session/transferred' }, { method: 'POST' });
      const result = await coordinated(env, member.member_id, 'checkout', {
        user: { id: replacement, username: 'new-maker', email: 'new@example.com' }, annual: false,
      });
      expect(result.url).toContain('billing.stripe.com');
      expect(await env.DB.prepare('SELECT discord_email, member_id FROM members WHERE discord_user_id = ?').bind(replacement).first())
        .toEqual({ discord_email: 'new@example.com', member_id: member.member_id });
    });

    it('clears billing fields and reconciles role removal when Stripe IDs are cleared', async () => {
      await seed({ billing_name: 'Old billing', billing_email: 'old@example.com' }); await authenticate();
      const member = await readMember();
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204).times(2);
      expect((await save(fields({ stripe_customer_id: '' }))).status).toBe(303);
      await processMessage({ member_id: member.member_id }, env);
      expect(await readMember()).toMatchObject({ stripe_customer_id: null, stripe_subscription_id: null, billing_name: '', billing_email: '' });
    });

    it('expires outstanding checkout before changing billing and preserves metadata on Stripe failure', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_admin', url: 'https://checkout.stripe.com/c/pay/admin' }, { method: 'POST' });
      await checkout();
      const version = String((await readMember()).metadata_version);
      mockStripe('/checkout/sessions/cs_admin', { id: 'cs_admin', status: 'open' }).times(2);
      mockStripe('/checkout/sessions/cs_admin/expire', {}, { method: 'POST', status: 500 });
      expect((await save(fields({ metadata_version: version }))).status).toBe(502);
      expect((await readMember()).bill_annually).toBe(0);
      mockStripe('/checkout/sessions/cs_admin', { id: 'cs_admin', status: 'open' });
      mockStripe('/checkout/sessions/cs_admin/expire', { id: 'cs_admin', status: 'expired' }, { method: 'POST' });
      expect((await save(fields({ metadata_version: version }))).status).toBe(303);
      expect((await readMember()).bill_annually).toBe(1);
      const stub = await memberStub();
      await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.get('checkout')).toBeUndefined(); });
    });

    it.each(['student', ''])('expires checkout when an admin changes only the discount to %j', async discount => {
      await seed({ discount_type: discount ? '' : 'student' }); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      if (!discount) mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }], has_more: false });
      mockStripe('/checkout/sessions', { id: 'cs_before', url: 'https://checkout.stripe.com/c/pay/before' }, { method: 'POST' });
      await checkout();
      mockStripe('/checkout/sessions/cs_before', { id: 'cs_before', status: 'open' });
      mockStripe('/checkout/sessions/cs_before/expire', { status: 'expired' }, { method: 'POST' });
      expect((await save(fields({ billing: 'monthly', discount_type: discount, metadata_version: String((await readMember()).metadata_version) }))).status).toBe(303);
      expect((await readMember()).discount_type).toBe(discount);
      mockSubs(); mockPrice(); mockCheckoutEmail();
      if (discount) mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }], has_more: false });
      mockStripe('/checkout/sessions', options => {
        expect(new URLSearchParams(options.body).get('discounts[0][coupon]')).toBe(discount ? 'coupon_student' : null);
        return { id: 'cs_after', url: 'https://checkout.stripe.com/c/pay/after' };
      }, { method: 'POST' });
      expect((await checkout()).url).toContain('/after');
    });

    it('invalidates stale admin forms on member sign-in and preserves the name override', async () => {
      await seed({ name_override: 'Admin name', notes: 'Keep me' }); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_profile', url: 'https://checkout.stripe.com/c/pay/profile' }, { method: 'POST' });
      await checkout();
      expect((await save()).status).toBe(409);
      expect(await readMember()).toMatchObject({ name_override: 'Admin name', notes: 'Keep me', discount_type: '' });
    });

    it('serializes a login profile refresh with a competing stale admin save', async () => {
      await seed();
      const member = await readMember();
      const results = await Promise.allSettled([
        coordinated(env, member.member_id, 'refreshIdentity', { user: { ...user, username: 'fresh-name', email: 'FRESH@example.com' } }),
        coordinated(env, member.member_id, 'updateMetadata', { fields: fields() }),
      ]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('rejected');
      expect(results[1].reason.status).toBe(409);
      expect(await readMember()).toMatchObject({ discord_username: 'fresh-name', discord_email: 'fresh@example.com',
        metadata_version: 1, notes: '', bill_annually: 0 });
    });

    it.each(['checkout', 'refreshIdentity'])('rejects stale Discord identity in %s after resolving a stable member ID', async operation => {
      await seed();
      const member = await readMember();
      const replacement = '555555555555555555';
      await env.DB.prepare('UPDATE members SET discord_user_id = ?, auth_version = auth_version + 1 WHERE member_id = ?')
        .bind(replacement, member.member_id).run();
      await expect(coordinated(env, member.member_id, operation, { user, annual: false }))
        .rejects.toMatchObject({ status: 409 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(await env.DB.prepare('SELECT discord_user_id, metadata_version FROM members WHERE member_id = ?').bind(member.member_id).first())
        .toEqual({ discord_user_id: replacement, metadata_version: 0 });
    });

    it('leaves completed subscriptions and checkout completion safeguards intact', async () => {
      await seed(); await authenticate();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_complete', url: 'https://checkout.stripe.com/c/pay/complete' }, { method: 'POST' });
      await checkout();
      mockStripe('/checkout/sessions/cs_complete', { id: 'cs_complete', status: 'complete', subscription: 'sub_member' });
      expect((await save(fields({ metadata_version: String((await readMember()).metadata_version) }))).status).toBe(303);
      mockSubs().times(2);
      mockStripe('/checkout/sessions/cs_complete', { id: 'cs_complete', status: 'complete', subscription: 'sub_member' });
      await expect(checkout({ annual: true })).rejects.toThrow('previous checkout is being processed');
      expect((await readMember()).bill_annually).toBe(1);
    });

    it('serializes simultaneous admin saves so only one stale-version update wins', async () => {
      await seed(); await authenticate();
      const results = await Promise.all([save(fields({ notes: 'First edit' })), save(fields({ notes: 'Second edit' }))]);
      expect(results.map(result => result.status).sort()).toEqual([303, 409]);
      expect((await readMember()).metadata_version).toBe(1);
    });

    it('logs out without requiring continued role membership', async () => {
      await authenticate();
      const result = await api('/admin/logout', { method: 'POST', headers: { Cookie: cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf: await hash(`admin-csrf:${token}`) }) });
      expect(result.status).toBe(303);
      expect(result.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(result.headers.get('Location')).toBe('/');
      expect((await api('/admin')).headers.get('Location')).toContain('https://discord.com/oauth2/authorize?');
      expect((await api('/admin/logout')).status).toBe(405);
    });
  });

  describe('member history', () => {
    const historyFor = member => queryEvents(env, { memberID: member.member_id });

    it('records registration once and tracks sign-in changes without timestamp/version noise', async () => {
      const member = await registerMember(env, user);
      await registerMember(env, user);
      await coordinated(env, member.member_id, 'refreshIdentity', { user });
      expect((await historyFor(member)).events.map(event => event.event_type)).toEqual(['MemberRegistered']);
      await coordinated(env, member.member_id, 'refreshIdentity', { user: { ...user, username: 'new-maker', email: 'NEW@example.com' } });
      const result = await historyFor(member);
      expect(result.total).toBe(3);
      expect(JSON.parse(result.events.find(event => event.event_type === 'DiscordEmailChanged').details))
        .toEqual({ from: user.email, to: 'new@example.com' });
      await env.DB.prepare('UPDATE members SET discord_last_synced = ?, stripe_synced_at = ?, auth_version = auth_version + 1 WHERE member_id = ?')
        .bind(now(), now(), member.member_id).run();
      expect((await historyFor(member)).events).toEqual(result.events);
    });

    it('records current Stripe state once across duplicate deliveries and captures null transitions', async () => {
      await seed();
      const member = await readMember();
      mockBilling().times(2); mockSubs([subscription()]).times(2);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204).times(2);
      await processMessage({ customer_id: customer }, env);
      const first = await historyFor(member);
      expect(first.events.map(event => event.event_type).sort()).toEqual([
        'BillingEmailChanged', 'BillingNameChanged', 'MemberRegistered', 'StripeSubscriptionChanged', 'SubscriptionStatusChanged',
      ]);
      expect(JSON.parse(first.events.find(event => event.event_type === 'SubscriptionStatusChanged').details)).toEqual({ from: null, to: 'active' });
      await processMessage({ customer_id: customer }, env);
      expect((await historyFor(member)).events).toEqual(first.events);
      mockBilling(); mockSubs();
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage({ customer_id: customer }, env);
      const last = await historyFor(member);
      expect(last.total).toBe(first.total + 2);
      expect(JSON.parse(last.events.find(event => event.event_type === 'SubscriptionStatusChanged').details)).toEqual({ from: 'active', to: null });
    });

    it('rolls back history together with failed database writes', async () => {
      await seed();
      const before = await queryEvents(env);
      await expect(env.DB.batch([
        env.DB.prepare("UPDATE members SET discount_type = 'student' WHERE discord_user_id = ?").bind(id),
        env.DB.prepare("UPDATE members SET bill_annually = 2 WHERE discord_user_id = ?").bind(id),
      ])).rejects.toThrow();
      expect((await readMember()).discount_type).toBe('');
      expect((await queryEvents(env)).events).toEqual(before.events);
    });

    it('follows stable identity transfers, records customer clearing, and retains history after deletion', async () => {
      await seed();
      const member = await readMember(), replacement = '555555555555555555';
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${replacement}`, { user: { id: replacement, username: 'replacement' } });
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      // Exercise the same metadata operation as the admin form, including identity validation.
      await coordinated(env, member.member_id, 'updateMetadata', { fields: {
        discord_user_id: replacement, stripe_customer_id: '', stripe_subscription_id: '', name_override: '', notes: '',
        billing: 'monthly', discount_type: '', metadata_version: '0',
      } });
      const events = (await historyFor(member)).events;
      expect(events.every(event => event.member_id === member.member_id && event.discord_user_id === replacement)).toBe(true);
      expect(JSON.parse(events.find(event => event.event_type === 'DiscordAccountChanged').details)).toEqual({ from: id, to: replacement });
      expect(JSON.parse(events.find(event => event.event_type === 'StripeCustomerChanged').details)).toEqual({ from: customer, to: null });
      await env.DB.prepare('DELETE FROM members WHERE member_id = ?').bind(member.member_id).run();
      expect((await queryEvents(env)).events).toHaveLength(events.length);
      expect((await queryEvents(env)).events.every(event => event.member_id === null)).toBe(true);
    });

    it.each(['/admin/events', `/admin/members/${id}/events`])('requires a valid admin session for %s and preserves OAuth destinations', async path => {
      await seed();
      const destination = `${path}?page=2&event_type=DiscountTypeModified`;
      const redirect = await api(destination);
      expect(redirect.status).toBe(303);
      const claims = await verifyToken(env, new URL(redirect.headers.get('Location')).searchParams.get('state'), 'oauth');
      expect(claims.return_to).toBe(destination);
      const token = await issueToken(env, id, 'admin');
      expect((await api(path, { headers: { Cookie: `thelab_admin=${token}` } })).status).toBe(200);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      const memberToken = await issueToken(env, id, 'member');
      expect((await api(path, { headers: { Cookie: `thelab_admin=${memberToken}` } })).status).toBe(303);
      expect((await api(path, { method: 'POST' })).status).toBe(405);
      for (const query of ['page=0', 'page=1&page=2', 'event_type=bogus', 'event_type=NotesUpdated&event_type=NotesUpdated', 'next=https://evil.example']) {
        expect(loginDestination(`${path}?${query}`, 'admin')).toBe('/admin');
      }
    });

    it('filters and paginates history, escapes values, and shows the latest ten events on member detail', async () => {
      await seed();
      const other = await registerMember(env, { id: '555555555555555555', username: 'Other member', email: 'other@example.com' });
      await env.DB.prepare("UPDATE members SET name_override = 'Unrelated history' WHERE member_id = ?").bind(other.member_id).run();
      for (let index = 0; index < 30; index++) {
        await env.DB.prepare('UPDATE members SET name_override = ? WHERE discord_user_id = ?').bind(`<script>edit-${index}</script>`, id).run();
      }
      const token = await issueToken(env, id, 'admin');
      const get = async path => {
        return api(path, { headers: { Cookie: `thelab_admin=${token}` } });
      };
      const response = await get(`/admin/members/${id}/events?event_type=NameOverrideChanged`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const html = await response.text();
      expect(html).toContain('30 events.');
      expect(html).toContain('Page 1 of 2');
      expect(html).toContain('page=2&amp;event_type=NameOverrideChanged');
      expect(html).toContain('&lt;script&gt;edit-29&lt;/script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('Unrelated history');
      const second = await (await get(`/admin/members/${id}/events?page=2&event_type=NameOverrideChanged`)).text();
      expect(second).toContain('Page 2 of 2');
      expect(second).toContain('&lt;script&gt;edit-0&lt;/script&gt;');
      expect(second.split('<tbody>')[1].split('</tbody>')[0]).not.toContain('edit-29');
      const redirect = await get(`/admin/members/${id}/events?page=999&event_type=NameOverrideChanged`);
      expect(redirect.headers.get('Location')).toBe(`/admin/members/${id}/events?page=2&event_type=NameOverrideChanged`);
      const global = await (await get('/admin/events?event_type=MemberRegistered')).text();
      expect(global).toContain('2 events.');
      expect(global).toContain(`/admin/members/${id}`);
      expect(global).toContain(`/admin/members/${other.discord_user_id}`);
      const prepare = vi.fn(sql => env.DB.prepare(sql));
      const detail = await (await api(`/admin/members/${id}`, { headers: { Cookie: `thelab_admin=${token}` } }, {
        ...env, DB: { prepare },
      })).text();
      // The detail preview stays bounded even when this member has many events.
      expect(prepare).toHaveBeenCalledTimes(3);
      expect(prepare.mock.calls.some(([sql]) => /COUNT\(|JOIN members/i.test(sql))).toBe(false);
      expect(detail).toContain('Recent member history');
      expect(detail).toContain(`/admin/members/${id}/events`);
      expect(detail).toContain('edit-20');
      expect(detail).not.toContain('edit-18');
      expect((await get('/admin/events?event_type=invalid')).status).toBe(400);
      expect((await get('/admin/members/666666666666666666/events')).status).toBe(404);
      expect(await (await get('/admin/events?event_type=NotesUpdated')).text()).toContain('No member history found.');
    });
  });

  describe('billing safeguards', () => {
    it('lets a returning customer choose a billing email independently of Discord', async () => {
      await seed({ billing_email: user.email });
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', options => {
        const form = new URLSearchParams(options.body);
        expect(form.get('customer')).toBe(customer);
        expect(form.has('customer_email')).toBe(false);
        return { id: 'cs_email', url: 'https://checkout.stripe.com/c/pay/email' };
      }, { method: 'POST' });
      expect((await checkout()).url).toContain('checkout.stripe.com');

      mockBilling('Billing Maker', 'preferred@example.com');
      mockSubs([subscription()]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
      await processMessage({ customer_id: customer }, env);
      expect(await readMember()).toMatchObject({ discord_email: user.email, billing_email: 'preferred@example.com' });
    });

    it('does not open checkout if clearing the locked email fails', async () => {
      await seed({ billing_email: user.email });
      mockSubs(); mockPrice();
      mockStripe(`/customers/${customer}`, {}, { method: 'POST', status: 500 });
      await expect(checkout()).rejects.toThrow('Stripe is temporarily unavailable. Please try again.');
      const stub = await memberStub();
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get('checkout')).toBeUndefined();
      });
    });

    it('blocks checkout when the configured recurring price is missing', async () => {
      await seed(); mockSubs();
      mockStripe(/^\/v1\/prices\?/, { data: [], has_more: false });
      await expect(checkout()).rejects.toThrow('Membership checkout is temporarily unavailable. Please contact leadership.');
    });

    it.each([false, true])('automatically applies the admin discount for annual=%s', async annual => {
      await seed({ discount_type: 'student', bill_annually: annual ? 1 : 0 });
      mockSubs();
      mockPrice(annual);
      mockCheckoutEmail();
      mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'Military, STUDENT' } }], has_more: false });
      let form;
      fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
        form = new URLSearchParams(options.body);
        return { id: 'cs_discount', url: 'https://checkout.stripe.com/c/pay/discount' };
      });
      expect((await checkout({ annual: !annual })).url).toContain('checkout.stripe.com');
      expect(form.get('discounts[0][coupon]')).toBe('coupon_student');
      expect(form.get('line_items[0][price]')).toBe(annual ? 'price_yearly' : 'price_monthly');
      expect(form.has('allow_promotion_codes')).toBe(false);
      expect(await readMember()).toMatchObject({ discount_type: 'student', bill_annually: annual ? 1 : 0 });
    });

    it('does not charge full price when an assigned coupon is missing', async () => {
      await seed({ discount_type: 'family' });
      mockSubs(); mockPrice();
      mockStripe(/^\/v1\/coupons\?/, { data: [], has_more: false });
      await expect(checkout()).rejects.toThrow('We couldn’t apply your discount. Please contact leadership before paying.');
    });

    it.each(['', 'family', 'free'])('ignores user-supplied discount %j and preserves the admin category', async discount => {
      await seed({ discount_type: 'student' });
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }], has_more: false });
      mockStripe('/checkout/sessions', options => {
        expect(new URLSearchParams(options.body).get('discounts[0][coupon]')).toBe('coupon_student');
        return { id: 'cs_assigned', url: 'https://checkout.stripe.com/c/pay/assigned' };
      }, { method: 'POST' });
      expect((await checkout({ discount })).url).toContain('checkout.stripe.com');
      expect((await readMember()).discount_type).toBe('student');
    });

    it('cannot assign a discount to a standard-rate member through checkout input', async () => {
      await seed();
      mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', options => {
        expect(new URLSearchParams(options.body).has('discounts[0][coupon]')).toBe(false);
        return { id: 'cs_standard', url: 'https://checkout.stripe.com/c/pay/standard' };
      }, { method: 'POST' });
      await checkout({ discount: 'student', discount_type: 'student' });
      expect((await readMember()).discount_type).toBe('');
    });

    it('serializes concurrent checkout requests and reuses the open session', async () => {
      await seed();
      mockSubs().times(2); mockPrice().times(2);
      mockCheckoutEmail().times(2);
      mockStripe('/checkout/sessions', { id: 'cs_one', url: 'https://checkout.stripe.com/c/pay/one' }, { method: 'POST' });
      mockStripe('/checkout/sessions/cs_one', { id: 'cs_one', status: 'open', url: 'https://checkout.stripe.com/c/pay/one' });
      const results = await Promise.all([checkout(), checkout()]);
      expect(results[0]).toEqual(results[1]);
    });

    it('retries an ambiguous Stripe write with the original idempotency key', async () => {
      await seed();
      mockSubs(); mockPrice();
      mockCheckoutEmail().times(2);
      let firstKey, retryKey;
      fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(500, options => {
        firstKey = new Headers(options.headers).get('Idempotency-Key');
        return {};
      });
      await expect(checkout()).rejects.toThrow('Stripe is temporarily unavailable. Please try again.');
      mockSubs(); mockPrice();
      fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
        retryKey = new Headers(options.headers).get('Idempotency-Key');
        return { id: 'cs_retry', url: 'https://checkout.stripe.com/c/pay/retry' };
      });
      mockStripe('/checkout/sessions/cs_retry', { id: 'cs_retry', status: 'open', url: 'https://checkout.stripe.com/c/pay/retry' });
      await checkout();
      expect(firstKey).toBeTruthy();
      expect(retryKey).toBe(firstKey);
    });

    it('does not replay an ambiguous write after Stripe idempotency expires', async () => {
      await seed();
      const stub = await memberStub();
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.put('checkout', { key: 'old', path: '/checkout/sessions', form: {}, created: now() - 86400 });
      });
      mockSubs();
      await expect(checkout()).rejects.toThrow('needs review');
    });

    it('expires a previous payment link before an admin changes billing frequency', async () => {
      await seed(); mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_old', url: 'https://checkout.stripe.com/c/pay/old' }, { method: 'POST' });
      await checkout();
      mockStripe('/checkout/sessions/cs_old', { id: 'cs_old', status: 'open' });
      mockStripe('/checkout/sessions/cs_old/expire', { id: 'cs_old', status: 'expired' }, { method: 'POST' });
      await assignAnnualBilling();
      mockSubs(); mockPrice(true); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_yearly', url: 'https://checkout.stripe.com/c/pay/yearly' }, { method: 'POST' });
      expect((await checkout()).url).toContain('/yearly');
    });

    it('does not issue a second checkout if payment wins a race against session expiry', async () => {
      await seed(); mockSubs(); mockPrice(); mockCheckoutEmail();
      mockStripe('/checkout/sessions', { id: 'cs_race', url: 'https://checkout.stripe.com/c/pay/race' }, { method: 'POST' });
      await checkout();
      mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'open' });
      mockStripe('/checkout/sessions/cs_race/expire', {}, { method: 'POST', status: 400 });
      mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'complete', subscription: 'sub_member' });
      await expect(assignAnnualBilling()).rejects.toThrow('Stripe is temporarily unavailable. Please try again.');
      expect(await readMember()).toMatchObject({ bill_annually: 0 });
    });

    it('sends an existing past-due subscriber to the portal rather than charging again', async () => {
      await seed(); mockSubs([subscription('past_due')]);
      mockStripe('/billing_portal/sessions', { url: 'https://billing.stripe.com/p/session/test' }, { method: 'POST' });
      expect((await checkout()).url).toContain('billing.stripe.com');
    });

    it('allows rejoining after a completed checkout subscription was canceled', async () => {
      await seed(); mockSubs(); mockPrice(); mockCheckoutEmail().times(2);
      mockStripe('/checkout/sessions', { id: 'cs_old', url: 'https://checkout.stripe.com/c/pay/old' }, { method: 'POST' });
      await checkout();
      mockSubs([subscription('canceled')]).times(2);
      mockStripe('/checkout/sessions/cs_old', { id: 'cs_old', status: 'complete', subscription: 'sub_member' });
      mockPrice();
      mockStripe('/checkout/sessions', { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/new' }, { method: 'POST' });
      expect((await checkout()).url).toContain('/new');
    });
  });

  describe('payment confirmation', () => {
    it.each(['unpaid', 'paid'])('checks payment status before showing welcome (%s)', async paymentStatus => {
      await seed();
      const cookie = await loginCookie();
      mockStripe('/checkout/sessions/cs_member', { mode: 'subscription', customer, client_reference_id: id, metadata: { thelab_discord_id: id }, status: 'complete', payment_status: paymentStatus, subscription: 'sub_member' });
      const send = vi.fn().mockResolvedValue(undefined);
      if (paymentStatus === 'paid') mockStripe('/subscriptions/sub_member', subscription());
      const response = await api('/payment/success?session_id=cs_member', { headers: { Cookie: cookie } }, { ...env, MEMBERSHIP_QUEUE: { send } });
      expect(response.status).toBe(paymentStatus === 'paid' ? 303 : 409);
      if (paymentStatus === 'paid') expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/welcome`);
      expect(send).toHaveBeenCalledTimes(paymentStatus === 'paid' ? 1 : 0);
    });

    it('rejects a checkout belonging to another Discord identity', async () => {
      await seed();
      mockStripe('/checkout/sessions/cs_other', { mode: 'subscription', customer, client_reference_id: '444444444444444444', status: 'complete', payment_status: 'paid' });
      expect((await api('/payment/success?session_id=cs_other', { headers: { Cookie: await loginCookie() } })).status).toBe(403);
    });
  });

  describe('webhooks and queued Discord reconciliation', () => {
    it.each([id, null])('preserves a linked legacy subscription on renewal with Discord identity %s', async discordID => {
      await seed({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: 'active', discord_user_id: discordID });
      const member = await env.DB.prepare('SELECT * FROM members WHERE stripe_customer_id = ?').bind(customer).first();
      const before = await queryEvents(env, { memberID: member.member_id });
      const legacy = { ...subscription('active', 'sub_legacy'), metadata: { etag: 'legacy-etag' },
        items: { data: [{ price: { active: false, unit_amount: 4000 } }] } };
      const send = vi.fn().mockResolvedValue(undefined);
      expect((await api('/webhooks/stripe', await signedEvent('customer.subscription.updated', 'evt_renewal', legacy),
        { ...env, MEMBERSHIP_QUEUE: { send } })).status).toBe(204);
      expect(send).toHaveBeenCalledWith({ customer_id: customer });
      mockBilling('', 'billing@example.com').times(2);
      mockSubs([legacy]).times(2);
      if (discordID) mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${discordID}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204).times(2);
      for (let delivery = 0; delivery < 2; delivery++) await processMessage(send.mock.calls[0][0], env);
      expect(await env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(member.member_id).first())
        .toMatchObject({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: 'active', billing_email: 'billing@example.com' });
      const after = await queryEvents(env, { memberID: member.member_id });
      expect(after.total).toBe(before.total + 1);
      expect(after.events[0].event_type).toBe('BillingEmailChanged');
    });

    it.each(['past_due', 'canceled'])('updates a linked legacy subscription to its current %s status', async status => {
      await seed({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: 'active' });
      mockBilling();
      mockSubs([{ ...subscription(status, 'sub_legacy'), metadata: {} }]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage({ customer_id: customer }, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: status });
    });

    it.each([
      { thelab_member_id: 'another-member', thelab_discord_id: id },
      { thelab_discord_id: '555555555555555555' },
    ])('does not override conflicting ownership on a linked subscription: %j', async metadata => {
      await seed({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: 'active' });
      mockBilling();
      mockSubs([{ ...subscription('active', 'sub_legacy'), metadata }]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage({ customer_id: customer }, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_id: null, stripe_subscription_state: null });
    });

    it('routes a linked legacy subscriber to the billing portal instead of another checkout', async () => {
      await seed({ stripe_subscription_id: 'sub_legacy', stripe_subscription_state: 'active' });
      mockSubs([{ ...subscription('active', 'sub_legacy'), metadata: {} }]);
      mockStripe('/billing_portal/sessions', { url: 'https://billing.stripe.com/p/session/legacy' }, { method: 'POST' });
      const response = await api('/payment/resume', { headers: { Cookie: await loginCookie() } });
      expect(response.headers.get('Location')).toBe('https://billing.stripe.com/p/session/legacy');
    });

    it('rejects a customer mapping changed after queue routing', async () => {
      await seed();
      const member = await readMember();
      await env.DB.prepare('UPDATE members SET stripe_customer_id = ? WHERE member_id = ?').bind('cus_replacement', member.member_id).run();
      await expect(coordinated(env, member.member_id, 'sync', { customer_id: customer })).rejects.toMatchObject({ status: 409 });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it.each([
      { statuses: ['active', 'trialing', 'past_due', 'canceled'], expected: 'trialing', method: 'PUT' },
      { statuses: ['past_due', 'unpaid', 'canceled'], expected: 'unpaid', method: 'DELETE' },
      { statuses: ['canceled', 'incomplete_expired'], expected: 'incomplete_expired', method: 'DELETE' },
    ])('selects $expected by eligibility before recency during reconciliation', async ({ statuses, expected, method }) => {
      await seed();
      mockBilling();
      mockSubs(statuses.map((status, index) => ({ ...subscription(status, `sub_${index}`), created: 1000 + index })));
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, method, 204);
      await processMessage({ customer_id: customer }, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_state: expected, stripe_subscription_id: `sub_${statuses.indexOf(expected)}` });
    });

    it('queues customer updates using the Customer ID', async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      const response = await api('/webhooks/stripe', await signedEvent('customer.updated', 'evt_customer', { id: customer, name: 'Billing Name' }),
        { ...env, MEMBERSHIP_QUEUE: { send } });
      expect(response.status).toBe(204);
      expect(send).toHaveBeenCalledWith({ customer_id: customer });
    });

    it('rejects a tampered signed event and ignores valid unrelated event types', async () => {
      const send = vi.fn();
      const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
      const signed = await signedEvent();
      signed.body = signed.body.replace('cus_member', 'cus_attacker');
      expect((await api('/webhooks/stripe', signed, bindings)).status).toBe(400);
      expect((await api('/webhooks/stripe', await signedEvent('payment_intent.succeeded'), bindings)).status).toBe(204);
      expect(send).not.toHaveBeenCalled();
    });
    it('rejects unsigned and stale webhooks without queueing', async () => {
      const send = vi.fn();
      const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
      expect((await api('/webhooks/stripe', { method: 'POST', body: '{}' }, bindings)).status).toBe(400);
      expect((await api('/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': 't=1,v1=' + '0'.repeat(64) } }, bindings)).status).toBe(400);
      expect(send).not.toHaveBeenCalled();
    });

    it('acknowledges Stripe only after a successful queue send, including redelivery', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const send = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
      const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
      expect((await api('/webhooks/stripe', await signedEvent(), bindings)).status).toBe(500);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'request.failed', path: '/webhooks/stripe',
        error: { message: 'queue unavailable' } });
      expect((await api('/webhooks/stripe', await signedEvent(), bindings)).status).toBe(204);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith({ customer_id: customer });
    });

    it('reconciles current state for delayed cancellation events and duplicate deliveries', async () => {
      await seed();
      const send = vi.fn().mockResolvedValue(undefined);
      const response = await api('/webhooks/stripe', await signedEvent('customer.subscription.deleted', 'evt_oldCancellation', subscription('canceled', 'sub_old')),
        { ...env, MEMBERSHIP_QUEUE: { send } });
      expect(response.status).toBe(204);
      const message = send.mock.calls[0][0];
      mockBilling().times(2);
      mockSubs([subscription('active', 'sub_replacement'), subscription('canceled', 'sub_old')]).times(2);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204).times(2);
      await processMessage(message, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_id: 'sub_replacement', stripe_subscription_state: 'active' });
      await processMessage(message, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_id: 'sub_replacement', stripe_subscription_state: 'active' });
      mockBilling('Updated billing name', 'updated@example.com');
      mockSubs([subscription('canceled', 'sub_replacement')]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage(message, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_state: 'canceled', billing_name: 'Updated billing name', billing_email: 'updated@example.com' });
    });

    it('retains the role through cancel-at-period-end and removes it for past-due state', async () => {
      await seed();
      mockBilling().times(2);
      mockSubs([{ ...subscription(), cancel_at_period_end: true }]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
      await processMessage({ customer_id: customer }, env);
      mockSubs([subscription('past_due')]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage({ customer_id: customer }, env);
    });

    it('syncs each customer once per batch without swallowing invalid operator messages', async () => {
      await seed();
      await env.DB.prepare('INSERT INTO members (stripe_customer_id) VALUES (?)').bind('cus_other').run();
      const messages = [
        { customer_id: customer }, { customer_id: 'cus_other' },
        { customer_id: customer, type: 'invalid' }, { customer_id: customer }, { customer_id: 'cus_other' },
      ].map((body, i) => ({ id: `message-${i}`, body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
      mockBilling();
      mockSubs([subscription()]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, () => {
        expect(messages[0].ack).not.toHaveBeenCalled();
        expect(messages[3].ack).not.toHaveBeenCalled();
        return {};
      }, 'PUT', 204);
      mockStripe('/customers/cus_other', { id: 'cus_other', name: 'Other Member' });
      mockSubs([]);
      await worker.queue({ messages }, env);
      for (const message of messages.filter(message => message.body.type === undefined)) {
        expect(message.ack).toHaveBeenCalledOnce();
        expect(message.retry).not.toHaveBeenCalled();
      }
      expect(messages[2].ack).not.toHaveBeenCalled();
      expect(messages[2].retry).toHaveBeenCalledWith({ delaySeconds: 30 });
      expect(globalThis.fetch).toHaveBeenCalledTimes(5);
      expect(await readMember()).toMatchObject({ stripe_subscription_state: 'active', discord_last_synced: expect.any(Number) });
      expect(await env.DB.prepare('SELECT billing_name FROM members WHERE stripe_customer_id = ?').bind('cus_other').first())
        .toEqual({ billing_name: 'Other Member' });
    });

    it('retries every grouped message on Discord rate limits even when Stripe state is saved', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await seed();
      mockBilling().times(2);
      mockSubs([subscription()]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, { retry_after: 120 }, 'PUT', 429);
      const message = { id: 'queue-message', body: { customer_id: customer }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      const duplicate = { ...message, id: 'duplicate-message', attempts: 4, ack: vi.fn(), retry: vi.fn() };
      const unrelated = { ...message, id: 'unrelated-message', body: { customer_id: 'cus_unrelated' }, ack: vi.fn(), retry: vi.fn() };
      await worker.queue({ messages: [message, unrelated, duplicate] }, env);
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
      expect(duplicate.ack).not.toHaveBeenCalled();
      expect(duplicate.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
      expect(unrelated.ack).toHaveBeenCalledOnce();
      expect(unrelated.retry).not.toHaveBeenCalled();
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
      const providerError = entries.find(entry => entry.event === 'provider.failed');
      expect(providerError).toMatchObject({ service: 'Discord', failure: 'http', provider_status: 429, retry_after: 120 });
      expect(entries.find(entry => entry.event === 'queue.failed')).toMatchObject({ message_id: 'queue-message',
        attempt: 1, retry_delay_seconds: 120, error_id: providerError.error_id });
      expect(await readMember()).toMatchObject({ stripe_subscription_state: 'active', stripe_synced_at: expect.any(Number), discord_last_synced: null });
      mockSubs([subscription()]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
      await worker.queue({ messages: [{ ...message, attempts: 2 }, { ...duplicate, attempts: 5 }] }, env);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(duplicate.ack).toHaveBeenCalledOnce();
      expect(await readMember()).toMatchObject({ stripe_subscription_state: 'active', discord_last_synced: expect.any(Number) });
    });

    it('ignores unrelated customers and unrelated subscriptions on a mapped customer', async () => {
      await processMessage({ customer_id: 'cus_unrelated' }, env);
      await seed();
      mockBilling();
      mockSubs([{ ...subscription(), metadata: {} }]);
      mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
      await processMessage({ customer_id: customer }, env);
      expect(await readMember()).toMatchObject({ stripe_subscription_state: null });
    });
  });

  describe('provider failures and diagnostics', () => {
    it.each([301, 302, 303, 307, 308])('rejects HTTP %s without following redirects or forwarding credentials', async status => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetch = vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, {
        status, headers: { Location: 'https://unexpected.example/?access_token=private-token' },
      }));
      await expect(provider('https://discord.com/api/v10/oauth2/token', {
        method: 'POST', body: 'code=private-code', headers: { Authorization: 'Bearer private-token' },
      }, 'Discord', env)).rejects.toThrow('Discord is temporarily unavailable. Please try again.');
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1].redirect).toBe('manual');
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'provider.failed', service: 'Discord',
        path: '/api/v10/oauth2/token', method: 'POST', provider_status: status, failure: 'redirect' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    });

    it.each(['TypeError', 'TimeoutError'])('preserves %s diagnostics and redacts credentials', async name => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const cause = new Error(`Transport failed ${env.DISCORD_CLIENT_SECRET} Bearer private-token code=private-code https://discord.com/api?state=private-state`);
      cause.name = name;
      vi.mocked(globalThis.fetch).mockRejectedValueOnce(cause);
      await expect(provider('https://discord.com/api/v10/oauth2/token', {
        method: 'POST', body: 'code=private-code', headers: { Authorization: 'Bearer private-token' },
      }, 'Discord', env)).rejects.toThrow('temporarily unavailable');
      const entry = JSON.parse(log.mock.calls[0][0]);
      expect(entry).toMatchObject({ event: 'provider.failed', failure: 'transport', error: { cause: { name } } });
      expect(entry.error.cause.stack).toContain('membership.test.js');
      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(entry)).not.toContain('private-');
      expect(JSON.stringify(entry)).not.toContain(env.DISCORD_CLIENT_SECRET);
    });

    it.each(['<html>private-provider-body</html>', 'null', '[]'])('logs invalid responses without parser/body leaks: %s', async body => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(body, { status: 502 }));
      await expect(provider('https://discord.com/api/v10/users/@me', {}, 'Discord', env)).rejects.toThrow('Discord is temporarily unavailable. Please try again.');
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ failure: 'invalid_response', provider_status: 502 });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-provider-body');
    });

    it('logs unexpected Durable Object errors before returning a safe correlated failure', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      await seed();
      const member = await readMember();
      const stub = await memberStub();
      await runInDurableObject(stub, async instance => {
        vi.spyOn(instance, 'checkout').mockRejectedValueOnce(new Error('storage unavailable'));
        const result = await instance.execute({ member_id: member.member_id, operation: 'checkout', input: { user } });
        expect(result).toMatchObject({ ok: false, status: 500 });
        expect(result.error).toBe('Membership operation failed.');
        expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'membership.failed', error_id: result.error_id,
          member_id: member.member_id, operation: 'checkout', error: { message: 'storage unavailable' } });
      });
    });
  });

  describe('deployed asset routing', () => {
    it('routes admin navigation through authorization and serves admin styling', async () => {
      for (const path of ['/admin', '/admin/', `/admin/members/${id}`]) {
        const response = await SELF.fetch(`${env.SITE_URL}${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' });
        expect(response.status).toBe(303);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Location')).toContain('https://discord.com/oauth2/authorize?');
      }
      const stylesheet = await SELF.fetch(`${env.SITE_URL}/style.css`);
      expect(stylesheet.status).toBe(200);
      expect(await stylesheet.text()).toContain('.admin-page');
    });

    it('serves the static welcome page and routes signup navigation through the Worker', async () => {
      for (const path of ['/welcome']) {
        const response = await SELF.fetch(`${env.SITE_URL}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain('/style.css');
      }
      const response = await SELF.fetch(`${env.SITE_URL}/signup`, { headers: { 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('Location')).toContain('discord.com/oauth2/authorize');
    });
  });
});

describe('Waivers', () => {
  const user = { id: '333333333333333333', username: 'maker', email: 'maker@example.com' };
  const api = (path, init, bindings = env) => worker.fetch(new Request(`${env.SITE_URL}${path}`, init), bindings);
  const members = () => env.DB.prepare('SELECT * FROM members').all();
  const waivers = () => env.DB.prepare('SELECT * FROM waivers').all();
  let http;
  beforeEach(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    http = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => { throw new Error(`Unexpected provider call: ${url}`); });
  });
  afterEach(() => vi.restoreAllMocks());

  function human(result = {}, status = 200) {
    http.mockImplementationOnce(async (url, init) => {
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      const form = new URLSearchParams(init.body);
      expect(form.get('secret')).toBe(env.TURNSTILE_SECRET_KEY);
      expect(form.get('response')).toBe('human-token');
      return Response.json({ success: true, hostname: 'thelab.example', action: 'waiver', ...result }, { status });
    });
  }

  async function form(path = '/waiver', login = '', bindings = env) {
    const response = await api(path, { headers: { Cookie: login } }, bindings);
    expect(response.status).toBe(200);
    const html = await response.text();
    const fields = { csrf: html.match(/name="csrf" value="([^"]+)"/)[1], version: html.match(/name="version" value="([^"]+)"/)[1], revision: html.match(/name="revision" value="([^"]+)"/)[1],
      name: 'Public Maker', email: 'maker@example.com', agree0: 'on', agree1: 'on', 'cf-turnstile-response': 'human-token' };
    const cookie = [response.headers.get('Set-Cookie').split(';')[0], login].filter(Boolean).join('; ');
    return { html, fields, cookie, path, bindings };
  }
  const submit = (f, fields = {}, headers = {}) => api(f.path, { method: 'POST', body: new URLSearchParams({ ...f.fields, ...fields }),
    headers: { Cookie: f.cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }, f.bindings);

  describe('public liability waivers', () => {
    it('serves the public route through the Worker asset binding', async () => {
      const response = await SELF.fetch(`${env.SITE_URL}/waiver`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('cf-turnstile');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    });

    it('signs without login, normalizes email, and preserves the actual text and agreements', async () => {
      const f = await form();
      expect(f.html).toContain('No Discord login is needed');
      human();
      const result = await submit(f, { name: '<Maker & Friend>', email: '  MAKER@Example.COM  ' });
      expect(result.status).toBe(200);
      expect(await result.text()).toContain('&lt;Maker &amp; Friend&gt;');
      const [member] = (await members()).results, [signed] = (await waivers()).results;
      expect(member).toMatchObject({ discord_user_id: null, email: user.email, waiver_name: '<Maker & Friend>' });
      expect(signed).toMatchObject({ member_id: member.member_id, name: '<Maker & Friend>', email: user.email, version: 2 });
      expect(JSON.parse(signed.agreements)).toEqual((await currentWaiver(env)).agreements);
      expect(signed.content).toBe((await currentWaiver()).content);
      expect(signed.created).toBeGreaterThan(0);
      expect((await env.DB.prepare("SELECT * FROM member_events WHERE event_type = 'WaiverSigned'").all()).results).toHaveLength(1);
      await expect(env.DB.prepare("UPDATE waivers SET name = 'Changed'").run()).rejects.toThrow('immutable');
      await expect(env.DB.prepare('DELETE FROM waivers').run()).rejects.toThrow('retained');
    });

    it.each([
      [{ name: '' }, 400], [{ email: 'bad-email' }, 400], [{ agree1: '' }, 400], [{ version: '99' }, 409],
      [{ csrf: 'bad' }, 403], [{ 'cf-turnstile-response': '' }, 400], [{ revision: 'old-content-hash' }, 409],
    ])('rejects invalid submissions before provider calls: %j', async (fields, status) => {
      expect((await submit(await form(), fields)).status).toBe(status);
      expect(http).not.toHaveBeenCalled();
      expect((await members()).results).toHaveLength(0);
      expect((await waivers()).results).toHaveLength(0);
    });

    it.each([{ success: false }, { action: 'login' }, { hostname: 'evil.example' }])('rejects invalid human verification: %j', async result => {
      human(result);
      expect((await submit(await form())).status).toBe(400);
      expect((await members()).results).toHaveLength(0);
    });

    it.each([
      { TURNSTILE_SITE_KEY: '', TURNSTILE_SECRET_KEY: '' },
      { TURNSTILE_SITE_KEY: '' }, { TURNSTILE_SECRET_KEY: '' },
    ])('allows signing the actual waiver without complete Turnstile configuration: %j', async missing => {
      const f = await form('/waiver', '', { ...env, ...missing });
      expect(f.html).toContain('TheLab Liability Waiver');
      expect(f.html).toContain('INCLUDING NEGLIGENCE AND GROSS NEGLIGENCE');
      expect(f.html).toContain('all of my future participation in TheLab.');
      expect(f.html).not.toContain('cf-turnstile');
      expect(f.html).not.toContain('turnstile/v0/api.js');
      expect((await submit(f, { agree1: '' })).status).toBe(400);
      expect((await submit(f, { 'cf-turnstile-response': '' })).status).toBe(200);
      expect((await waivers()).results).toHaveLength(1);
      expect(http).not.toHaveBeenCalled();
    });

    it('fails closed on configured provider outages and replayed Turnstile tokens', async () => {
      const f = await form();
      human({}, 503);
      expect((await submit(f)).status).toBe(502);
      expect((await members()).results).toHaveLength(0);
      human();
      expect((await submit(f)).status).toBe(200);
      human({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      expect((await submit(f)).status).toBe(400);
      expect((await waivers()).results).toHaveLength(1);
    });

    it.each([null, 'null', 'https://alternate.example'])('accepts a valid waiver regardless of Origin: %s', async origin => {
      const f = await form();
      const headers = new Headers({ Cookie: f.cookie, 'Content-Type': 'application/x-www-form-urlencoded' });
      if (origin !== null) headers.set('Origin', origin);
      human();
      const response = await api('/waiver', { method: 'POST', headers, body: new URLSearchParams(f.fields) });
      expect(response.status).toBe(200);
      expect((await waivers()).results).toHaveLength(1);
    });

    it('rejects missing form cookies and duplicate fields', async () => {
      const f = await form();
      expect((await submit(f, {}, { Cookie: '' })).status).toBe(403);
      expect((await api('/waiver', { method: 'POST', body: new URLSearchParams(f.fields).toString() + '&email=other@example.com',
        headers: { Cookie: f.cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(403);
      expect(http).not.toHaveBeenCalled();
    });

    it('associates public signatures with matching members even if another member is logged in', async () => {
      const target = await registerMember(env, user);
      const other = await registerMember(env, { ...user, id: '555555555555555555', email: 'other@example.com' });
      const f = await form('/waiver', `thelab_member=${await memberToken(env, other)}`);
      human();
      expect((await submit(f)).status).toBe(200);
      expect((await waivers()).results[0].member_id).toBe(target.member_id);
      expect((await members()).results).toHaveLength(2);
    });

    it('claims a waiver-only member on first login and keeps its discounts and history', async () => {
      human();
      await submit(await form());
      const original = (await members()).results[0];
      await env.DB.prepare("UPDATE members SET discount_type = 'student' WHERE member_id = ?").bind(original.member_id).run();
      const linked = await registerMember(env, { ...user, email: 'MAKER@example.com' });
      expect(linked).toMatchObject({ member_id: original.member_id, discord_user_id: user.id, discount_type: 'student', email: user.email });
      expect((await waivers()).results[0].member_id).toBe(linked.member_id);
      await expect(registerMember(env, { ...user, id: '555555555555555555' })).rejects.toThrow('already linked');
      expect((await members()).results).toHaveLength(1);
    });

    it('serializes simultaneous public signatures and first logins into one member', async () => {
      const a = await form(), b = await form();
      human(); human();
      const responses = await Promise.all([submit(a), submit(b), registerMember(env, user), registerMember(env, user)]);
      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);
      expect((await members()).results).toHaveLength(1);
      expect((await waivers()).results).toHaveLength(2);
      expect(new Set((await waivers()).results.map(w => w.member_id)).size).toBe(1);
    });

  });

  describe('signup waiver gate', () => {
    it('gates checkout, preserves admin-assigned annual billing, and resumes after signing with a different email', async () => {
      const member = await registerMember(env, user);
      await env.DB.prepare('UPDATE members SET bill_annually = 1 WHERE member_id = ?').bind(member.member_id).run();
      const result = await coordinated(env, member.member_id, 'checkout', { user, annual: false });
      expect(result.url).toBe(`${env.SITE_URL}/waiver?signup=1`);
      expect(http).not.toHaveBeenCalled();
      const login = `thelab_member=${await memberToken(env, member)}`;
      const f = await form('/waiver?signup=1', login);
      expect(f.html).toContain(`value="${user.email}"`);
      human();
      const response = await submit(f, { email: 'different@example.com' });
      expect(response.headers.get('Location')).toBe('/payment/resume');
      expect((await members()).results).toHaveLength(1);
      expect((await waivers()).results[0]).toMatchObject({ member_id: member.member_id, email: 'different@example.com' });
      http.mockImplementation(async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/v1/prices') {
          expect(new URL(url).searchParams.get('lookup_keys[]')).toBe('yearly');
          return Response.json({ data: [{ id: 'price_yearly', type: 'recurring', product: 'prod_lab', recurring: { interval: 'year', interval_count: 1 } }] });
        }
        if (path === '/v1/customers') return Response.json({ id: 'cus_test' });
        if (path === '/v1/customers/cus_test') return Response.json({ id: 'cus_test' });
        if (path === '/v1/checkout/sessions') {
          expect(new URLSearchParams(init.body).get('line_items[0][price]')).toBe('price_yearly');
          return Response.json({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/test' });
        }
        throw new Error(`Unexpected provider call ${url}`);
      });
      expect((await api('/payment/resume', { headers: { Cookie: login } })).headers.get('Location')).toContain('checkout.stripe.com');
    });

    it('restores the waiver after login and rejects expired or switched-account submissions', async () => {
      const response = await api('/waiver?signup=1');
      const state = new URL(response.headers.get('Location')).searchParams.get('state');
      expect(await verifyToken(env, state, 'oauth')).toMatchObject({ return_to: '/waiver?signup=1' });
      const member = await registerMember(env, user);
      const f = await form('/waiver?signup=1', `thelab_member=${await memberToken(env, member)}`);
      expect((await submit(f, {}, { Cookie: f.cookie.split(';')[0] })).status).toBe(401);
      const other = await registerMember(env, { ...user, id: '555555555555555555', email: 'other@example.com' });
      expect((await submit(f, {}, { Cookie: `${f.cookie.split(';')[0]}; thelab_member=${await memberToken(env, other)}` })).status).toBe(403);
      expect((await waivers()).results).toHaveLength(0);
      expect(http).not.toHaveBeenCalled();
    });

    it('redirects a first signup callback to the waiver with monthly billing despite a yearly signup parameter', async () => {
      const start = await api('/signup?billing=yearly');
      const state = new URL(start.headers.get('Location')).searchParams.get('state');
      http.mockImplementation(async url => {
        if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'token', token_type: 'Bearer' });
        if (url.endsWith('/users/@me')) return Response.json({ ...user, verified: true });
        if (url.includes('/guilds/')) return Response.json({ user });
        throw new Error(`Unexpected provider call ${url}`);
      });
      const response = await api(`/login/discord/callback?code=test&state=${state}`, { headers: { Cookie: start.headers.get('Set-Cookie').split(';')[0] } });
      expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/waiver?signup=1`);
      expect(response.headers.get('Set-Cookie')).toContain('thelab_member=');
      expect((await members()).results[0].bill_annually).toBe(0);
      expect(http).toHaveBeenCalledTimes(3);
    });
  });

  describe('waiver administration', () => {
    async function admin() {
      const token = await issueToken(env, user.id, 'admin');
      http.mockImplementation(async url => {
        expect(url).toContain(`/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
        return Response.json({ roles: [env.DISCORD_ADMIN_ROLE_ID] });
      });
      return { Cookie: `thelab_admin=${token}`, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', csrf: await hash(`admin-csrf:${token}`) };
    }

    it('lists, searches, edits, and shows history/evidence for waiver-only members', async () => {
      human(); await submit(await form());
      const member = (await members()).results[0], headers = await admin();
      const list = await (await api('/admin?q=Public&discord=unlinked', { headers })).text();
      expect(list).toContain(`/admin/members/${member.member_id}`);
      expect(list).toContain('Waiver signed');
      const detail = await (await api(`/admin/members/${member.member_id}`, { headers })).text();
      expect(detail).toContain('Signature #1');
      expect(detail).toContain('TheLab Liability Waiver');
      expect(detail).not.toContain('Deleted member');
      const save = await api(`/admin/members/${member.member_id}`, { method: 'POST', headers, body: new URLSearchParams({ csrf: headers.csrf,
        metadata_version: String(member.metadata_version), discord_user_id: '', stripe_customer_id: '', stripe_subscription_id: '',
        name_override: 'Preferred', notes: 'Visitor', billing: 'monthly', discount_type: 'student' }) });
      expect(save.status).toBe(303);
      expect((await members()).results[0]).toMatchObject({ name_override: 'Preferred', discount_type: 'student', discord_user_id: null });
      const history = await (await api(`/admin/members/${member.member_id}/events`, { headers })).text();
      expect(history).toContain('Waiver signed');
      expect(history).toContain('Signature #1, waiver version 2');
    });

    it('retains signed text independently of current source and has no publishing route', async () => {
      human(); await submit(await form());
      const headers = await admin();
      for (const method of ['GET', 'POST']) expect((await api('/admin/waiver', { method, headers })).status).toBe(404);
      await expect(env.DB.prepare("UPDATE waivers SET content = 'Changed'").run()).rejects.toThrow('immutable');
      const member = (await members()).results[0];
      await env.DB.prepare(`INSERT INTO waivers (member_id, version, content, name, email, agreements)
        VALUES (?, 0, '# Historical waiver\n\nOriginal terms', 'Original Name', 'old@example.com', '["Original agreement"]')`).bind(member.member_id).run();
      const detail = await (await api(`/admin/members/${member.member_id}`, { headers })).text();
      expect(detail).toContain('Original terms');
      expect(detail).toContain('Original agreement');
      expect(detail).toContain('TheLab Liability Waiver');
    });
  });
});

describe('Admin browser behavior', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each([false, true])('requires browser confirmation before deletion (confirmed: %s)', async confirmed => {
    vi.resetModules();
    const form = Object.assign(new EventTarget(), { dataset: { confirm: 'Delete Maker? This cannot be undone.' } });
    const button = { disabled: true };
    const confirm = vi.fn(() => confirmed);
    vi.stubGlobal('document', { getElementById: id => id === 'delete-member' ? form : null, querySelector: () => button });
    vi.stubGlobal('window', { confirm });
    await import('../static/script.js');
    expect(button.disabled).toBe(false);
    const event = new Event('submit', { cancelable: true });
    form.dispatchEvent(event);
    expect(confirm).toHaveBeenCalledWith(form.dataset.confirm);
    expect(event.defaultPrevented).toBe(!confirmed);
  });
});
