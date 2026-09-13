import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { processMessage } from '../src/index.js';
import { coordinated, registerMember } from '../src/membership.js';
import { hash, now } from '../src/http.js';
import { provider } from '../src/providers.js';
import { issueToken, memberToken, verifyToken } from '../src/auth.js';

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
  return coordinated(env, member.member_id, 'checkout', { user, annual: false, ...input });
};
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

  it.each(['/admin/members/333333333333333333', '/admin?page=2', '/payment/resume', '/payment/success?session_id=cs_member'])('enters OAuth directly and restores %s', async path => {
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
  it('binds billing to the browser cookie and ignores signup and callback discount inputs', async () => {
    const { target, state, cookie } = await start('?billing=yearly&discount=student');
    expect(target.origin).toBe('https://discord.com');
    expect(target.searchParams.get('scope')).toBe('identify email');
    expect(target.searchParams.get('redirect_uri')).toBe(`${env.SITE_URL}/login/discord/callback`);
    const claims = await verifyToken(env, state, 'oauth');
    expect(claims).toMatchObject({ sub: await hash(cookie.split('=')[1]), purpose: 'signup', bill_annually: 1, return_to: '/payment/resume' });
    expect(claims).not.toHaveProperty('discount_type');
    expect(claims.exp - claims.iat).toBe(600);
    expect((await api(`/login/discord/callback?code=hello&state=${state}`)).status).toBe(400);
    oauthMock();
    mockPrice(true); mockCheckoutEmail();
    mockStripe('/customers', { id: customer }, { method: 'POST' });
    mockStripe('/checkout/sessions', options => {
      const form = new URLSearchParams(options.body);
      expect(form.get('line_items[0][price]')).toBe('price_yearly');
      expect(form.has('discounts[0][coupon]')).toBe(false);
      return { id: 'cs_signup', url: 'https://checkout.stripe.com/c/pay/signup' };
    }, { method: 'POST' });
    const response = await api(`/login/discord/callback?code=hello&state=${state}&discount=`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/signup');
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(await readMember()).toMatchObject({ bill_annually: 1, discount_type: '', stripe_customer_id: customer });
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
    { purpose: 'unknown' }, { purpose: null }, { bill_annually: '1' }, { bill_annually: 2 },
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

  it('redirects a standard signup directly to Stripe and persists stable ownership', async () => {
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

  it.each(['signup', 'resume'])('uses the latest admin discount during %s despite user-supplied discount parameters', async flow => {
    await seed({ discount_type: 'family', bill_annually: 1 });
    const login = flow === 'signup' ? await start('?billing=yearly&discount=student') : null;
    // An admin edit during OAuth must take effect at checkout.
    await env.DB.prepare("UPDATE members SET discount_type = 'retired' WHERE discord_user_id = ?").bind(id).run();
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
      ? await api(`/login/discord/callback?state=${login.state}&code=test&discount=student`, { headers: { Cookie: login.cookie } })
      : await api('/payment/resume?discount=student', { headers: { Cookie: await loginCookie() } });
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
  const role = (roles = [env.DISCORD_ADMIN_ROLE_ID]) => mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}`, { roles });
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

  it('rejects anonymous, expired, unconfigured, and revoked access to reads and writes', async () => {
    expect((await api('/admin')).headers.get('Location')).toContain('https://discord.com/oauth2/authorize?');
    expect((await save()).status).toBe(303);
    await seed();
    expect((await api('/admin', { headers: { Cookie: await loginCookie() } })).status).toBe(303);
    await authenticate();
    expect((await api('/admin', { headers: { Cookie: cookie } }, { ...env, DISCORD_ADMIN_ROLE_ID: '' })).status).toBe(503);
    role([]);
    expect((await api('/admin', { headers: { Cookie: cookie } })).status).toBe(403);
    role([]);
    expect((await save()).status).toBe(403);
    expect((await readMember()).discord_username).toBe('maker');
    vi.spyOn(Date, 'now').mockReturnValue((now() + 8 * 3600) * 1000);
    expect((await api(`/admin/members/${id}`, { headers: { Cookie: cookie } })).status).toBe(303);
  });

  it('logs unexpected admin database errors with context and keeps details out of HTML', async () => {
    await authenticate(); role();
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

  it('paginates all members with deterministic ordering and handles empty/invalid pages', async () => {
    await authenticate();
    role();
    expect(await (await api('/admin', { headers: { Cookie: cookie } })).text()).toContain('No members have registered yet.');
    await env.DB.batch(Array.from({ length: 26 }, (_, i) => env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, created) VALUES (?, ?, ?, ?)')
      .bind(String(BigInt(id) + BigInt(i)), `maker-${i}`, `maker${i}@example.com`, 1000)));
    role();
    const first = await api('/admin', { headers: { Cookie: cookie } });
    const html = await first.text();
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('26 registered members');
    expect(html).toContain('Page 1 of 2');
    expect(html.match(/href="\/admin\/members\//g)).toHaveLength(25);
    expect(html).toContain('>maker-25</a>');
    expect(html).not.toContain('>maker-0</a>');
    role();
    const second = await (await api('/admin?page=2', { headers: { Cookie: cookie } })).text();
    expect(second.match(/href="\/admin\/members\//g)).toHaveLength(1);
    expect(second).toContain('>maker-0</a>');
    role();
    expect((await api('/admin?page=3', { headers: { Cookie: cookie } })).headers.get('Location')).toBe('/admin?page=2');
    role();
    expect((await api('/admin?page=-1', { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it('saves editable metadata without changing Stripe state, escapes HTML, and rejects stale forms', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed({ stripe_subscription_id: 'sub_member', stripe_subscription_state: 'active' });
    await authenticate();
    role();
    const result = await save(fields({ notes: '<script>alert(1)</script>', stripe_subscription_id: 'sub_member', stripe_subscription_state: 'canceled',
      discord_username: 'forged', discord_email: 'forged@example.com', billing_name: 'forged', billing_email: 'forged@example.com' }));
    expect(result.status).toBe(303);
    expect(await readMember()).toMatchObject({ discord_username: user.username, discord_email: user.email, name_override: 'Maker Name', billing_name: '', billing_email: '',
      bill_annually: 1, discount_type: 'student', metadata_version: 1,
      stripe_customer_id: customer, stripe_subscription_state: 'active', stripe_subscription_id: 'sub_member' });
    role();
    const view = await api(`/admin/members/${id}?saved=1`, { headers: { Cookie: cookie } });
    const html = await view.text();
    expect(html).toContain('Member metadata saved.');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('custom_metadata');
    expect(html).not.toContain('contact_name');
    expect(html).not.toContain('discount_status');
    for (const name of ['discord_username', 'discord_email', 'billing_name', 'billing_email']) {
      expect(html).toMatch(new RegExp(`<input id="${name}"[^>]+ readonly>`));
    }
    expect(html).toContain(await hash(`admin-csrf:${token}`));
    expect(view.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    role();
    const stale = await save(fields({ notes: 'Stale notes' }));
    expect(stale.status).toBe(409);
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    const operation = entries.find(entry => entry.event === 'membership.failed');
    expect(operation).toMatchObject({ status: 409, operation: 'updateMetadata' });
    expect(entries.find(entry => entry.event === 'admin.save_failed')).toMatchObject({ status: 409, error_id: operation.error_id });
    expect(await stale.text()).toContain('Stale notes');
    expect((await readMember()).notes).toBe('<script>alert(1)</script>');
  });

  it('rejects cross-site and malformed saves before changing data', async () => {
    await seed(); await authenticate();
    expect((await save(fields(), { Origin: 'https://elsewhere.example' })).status).toBe(403);
    expect((await save({ ...fields(), csrf: 'wrong' })).status).toBe(403);
    expect((await save(fields(), { 'Content-Type': 'application/json' })).status).toBe(415);
    for (const invalid of [{ discount_type: 'free' }, { billing: 'weekly' }, { discord_user_id: 'invalid' }, { stripe_customer_id: 'bad' },
      { stripe_subscription_id: 'bad' }, { stripe_customer_id: '', stripe_subscription_id: 'sub_member' }, { name_override: 'x'.repeat(161) }, { notes: 'x'.repeat(5001) }]) {
      role();
      expect((await save(fields(invalid))).status).toBe(400);
    }
    expect((await readMember()).metadata_version).toBe(0);
    role();
    expect((await api('/admin/members/999999999999999999', { headers: { Cookie: cookie } })).status).toBe(404);
  });

  it.each([
    ['active', 'sub_member', 'Active — active'],
    ['trialing', 'sub_member', 'Active — trialing'],
    ['past_due', 'sub_member', 'Inactive — past_due'],
    ['canceled', 'sub_member', 'Inactive — canceled'],
    [null, 'sub_member', 'Unknown — not yet synced'],
    [null, null, 'No subscription'],
  ])('shows stored subscription status and dashboard links: %s / %s', async (state, subscriptionID, label) => {
    await seed({ stripe_subscription_state: state, stripe_subscription_id: subscriptionID, stripe_synced_at: 1000 });
    await authenticate();
    for (const path of ['/admin', `/admin/members/${id}`]) {
      role();
      const html = await (await api(path, { headers: { Cookie: cookie } })).text();
      expect(html).toContain(label);
      expect(html).toContain('1970-01-01 00:16:40 UTC');
      if (subscriptionID) expect(html).toContain('href="https://dashboard.stripe.com/test/subscriptions/sub_member" target="_blank" rel="noopener noreferrer"');
      else expect(html).not.toContain('dashboard.stripe.com');
    }
    if (subscriptionID) {
      role();
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
    role();
    expect(await (await api('/admin', { headers: { Cookie: cookie } })).text()).toContain(`>${expected}</a>`);
    role();
    expect(await (await api(`/admin/members/${id}`, { headers: { Cookie: cookie } })).text()).toContain(`<h1>Edit ${expected}</h1>`);
  });

  it('transfers Discord identity while retaining billing, the stable lock, and automatic subscription selection', async () => {
    const replacement = '555555555555555555';
    await seed({ stripe_subscription_id: 'sub_member', stripe_subscription_state: 'active' });
    await authenticate(); const oldCookie = await loginCookie();
    const before = await readMember();
    role();
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
    role();
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
      role();
      expect((await save(fields(edit))).status).toBe(409);
    }
    role(); mockBilling();
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
    role();
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
    role();
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
    role();
    mockStripe('/checkout/sessions/cs_admin', { id: 'cs_admin', status: 'open' }).times(2);
    mockStripe('/checkout/sessions/cs_admin/expire', {}, { method: 'POST', status: 500 });
    expect((await save(fields({ metadata_version: version }))).status).toBe(502);
    expect((await readMember()).bill_annually).toBe(0);
    role();
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
    role();
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
    role();
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
    role();
    mockStripe('/checkout/sessions/cs_complete', { id: 'cs_complete', status: 'complete', subscription: 'sub_member' });
    expect((await save(fields({ metadata_version: String((await readMember()).metadata_version) }))).status).toBe(303);
    mockSubs().times(2);
    mockStripe('/checkout/sessions/cs_complete', { id: 'cs_complete', status: 'complete', subscription: 'sub_member' });
    await expect(checkout({ annual: true })).rejects.toThrow('previous checkout is being processed');
    expect((await readMember()).bill_annually).toBe(1);
  });

  it('serializes simultaneous admin saves so only one stale-version update wins', async () => {
    await seed(); await authenticate();
    role().times(2);
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
    await expect(checkout()).rejects.toThrow('HTTP 500');
    const stub = await memberStub();
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('checkout')).toBeUndefined();
    });
  });

  it('blocks checkout when the configured recurring price is missing', async () => {
    await seed(); mockSubs();
    mockStripe(/^\/v1\/prices\?/, { data: [], has_more: false });
    await expect(checkout()).rejects.toThrow('price is not configured');
  });

  it.each([false, true])('automatically applies the admin discount for annual=%s', async annual => {
    await seed({ discount_type: 'student' });
    mockSubs();
    mockPrice(annual);
    mockCheckoutEmail();
    mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'Military, STUDENT' } }], has_more: false });
    let form;
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
      form = new URLSearchParams(options.body);
      return { id: 'cs_discount', url: 'https://checkout.stripe.com/c/pay/discount' };
    });
    expect((await checkout({ annual })).url).toContain('checkout.stripe.com');
    expect(form.get('discounts[0][coupon]')).toBe('coupon_student');
    expect(form.get('line_items[0][price]')).toBe(annual ? 'price_yearly' : 'price_monthly');
    expect(form.has('allow_promotion_codes')).toBe(false);
    expect((await readMember()).discount_type).toBe('student');
  });

  it('does not charge full price when an assigned coupon is missing', async () => {
    await seed({ discount_type: 'family' });
    mockSubs(); mockPrice();
    mockStripe(/^\/v1\/coupons\?/, { data: [], has_more: false });
    await expect(checkout()).rejects.toThrow('no valid Stripe coupon');
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
    await expect(checkout()).rejects.toThrow('HTTP 500');
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

  it('expires a previous payment link before changing billing frequency', async () => {
    await seed(); mockSubs(); mockPrice(); mockCheckoutEmail();
    mockStripe('/checkout/sessions', { id: 'cs_old', url: 'https://checkout.stripe.com/c/pay/old' }, { method: 'POST' });
    await checkout();
    mockSubs();
    mockStripe('/checkout/sessions/cs_old', { id: 'cs_old', status: 'open' });
    mockStripe('/checkout/sessions/cs_old/expire', { id: 'cs_old', status: 'expired' }, { method: 'POST' });
    mockPrice(true); mockCheckoutEmail();
    mockStripe('/checkout/sessions', { id: 'cs_yearly', url: 'https://checkout.stripe.com/c/pay/yearly' }, { method: 'POST' });
    expect((await checkout({ annual: true })).url).toContain('/yearly');
  });

  it('does not issue a second checkout if payment wins a race against session expiry', async () => {
    await seed(); mockSubs(); mockPrice(); mockCheckoutEmail();
    mockStripe('/checkout/sessions', { id: 'cs_race', url: 'https://checkout.stripe.com/c/pay/race' }, { method: 'POST' });
    await checkout();
    mockSubs();
    mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'open' });
    mockStripe('/checkout/sessions/cs_race/expire', {}, { method: 'POST', status: 400 });
    mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'complete', subscription: 'sub_member' });
    await expect(checkout({ annual: true })).rejects.toThrow('HTTP 400');
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

  it('retries Discord rate limits even when the Stripe state is already saved', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seed();
    mockBilling().times(2);
    mockSubs([subscription()]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, { retry_after: 120 }, 'PUT', 429);
    const message = { id: 'queue-message', body: { customer_id: customer }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] }, env);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    const entries = log.mock.calls.map(([entry]) => JSON.parse(entry));
    const providerError = entries.find(entry => entry.event === 'provider.failed');
    expect(providerError).toMatchObject({ service: 'Discord', failure: 'http', provider_status: 429, retry_after: 120 });
    expect(entries.find(entry => entry.event === 'queue.failed')).toMatchObject({ message_id: 'queue-message',
      attempt: 1, retry_delay_seconds: 120, error_id: providerError.error_id });
    expect(await readMember()).toMatchObject({ stripe_subscription_state: 'active', stripe_synced_at: expect.any(Number), discord_last_synced: null });
    mockSubs([subscription()]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
    await worker.queue({ messages: [{ ...message, attempts: 2 }] }, env);
    expect(message.ack).toHaveBeenCalledOnce();
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
    }, 'Discord', env)).rejects.toThrow('unexpected redirect');
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
    await expect(provider('https://discord.com/api/v10/users/@me', {}, 'Discord', env)).rejects.toThrow('invalid response');
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
    expect((await SELF.fetch(`${env.SITE_URL}/admin.css`)).status).toBe(200);
  });

  it('serves the static welcome page and routes signup navigation through the Worker', async () => {
    for (const path of ['/welcome']) {
      const response = await SELF.fetch(`${env.SITE_URL}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('/membership.css');
    }
    const response = await SELF.fetch(`${env.SITE_URL}/signup`, { headers: { 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('discord.com/oauth2/authorize');
  });
});
