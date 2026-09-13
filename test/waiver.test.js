import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { coordinated, registerMember } from '../src/membership.js';
import { hash } from '../src/http.js';
import { issueToken, memberToken, verifyToken } from '../src/auth.js';
import { currentWaiver } from '../src/waiver.js';

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

async function form(path = '/waiver', login = '') {
  const response = await api(path, { headers: { Cookie: login } });
  expect(response.status).toBe(200);
  const html = await response.text();
  const fields = { csrf: html.match(/name="csrf" value="([^"]+)"/)[1], version: html.match(/name="version" value="([^"]+)"/)[1], revision: html.match(/name="revision" value="([^"]+)"/)[1],
    name: 'Public Maker', email: 'maker@example.com', agree0: 'on', agree1: 'on', 'cf-turnstile-response': 'human-token' };
  const cookie = [response.headers.get('Set-Cookie').split(';')[0], login].filter(Boolean).join('; ');
  return { html, fields, cookie, path };
}
const submit = (f, fields = {}, headers = {}) => api(f.path, { method: 'POST', body: new URLSearchParams({ ...f.fields, ...fields }),
  headers: { Cookie: f.cookie, Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });

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
    expect(signed).toMatchObject({ member_id: member.member_id, name: '<Maker & Friend>', email: user.email, version: 1 });
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

  it('fails closed on outages, missing configuration, and replayed Turnstile tokens', async () => {
    const f = await form();
    human({}, 503);
    expect((await submit(f)).status).toBe(502);
    expect((await members()).results).toHaveLength(0);
    expect((await api('/waiver', undefined, { ...env, TURNSTILE_SECRET_KEY: '' })).status).toBe(503);
    human();
    expect((await submit(f)).status).toBe(200);
    human({ success: false, 'error-codes': ['timeout-or-duplicate'] });
    expect((await submit(f)).status).toBe(400);
    expect((await waivers()).results).toHaveLength(1);
  });

  it('rejects cross-site forms and duplicate fields', async () => {
    const f = await form();
    expect((await submit(f, {}, { Origin: 'https://evil.example' })).status).toBe(403);
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
  it('gates checkout, saves annual billing, signs with a different email, and resumes to Stripe', async () => {
    const member = await registerMember(env, user);
    const result = await coordinated(env, member.member_id, 'checkout', { user, annual: true });
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

  it('redirects a first signup callback to the waiver with a member cookie and preserved selection', async () => {
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
    expect((await members()).results[0].bill_annually).toBe(1);
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
    const list = await (await api('/admin?q=Public', { headers })).text();
    expect(list).toContain(`/admin/members/${member.member_id}`);
    expect(list).toContain('Waiver signed');
    const detail = await (await api(`/admin/members/${member.member_id}`, { headers })).text();
    expect(detail).toContain('Signature #1');
    expect(detail).toContain('sample liability waiver');
    expect(detail).not.toContain('Deleted member');
    const save = await api(`/admin/members/${member.member_id}`, { method: 'POST', headers, body: new URLSearchParams({ csrf: headers.csrf,
      metadata_version: String(member.metadata_version), discord_user_id: '', stripe_customer_id: '', stripe_subscription_id: '',
      name_override: 'Preferred', notes: 'Visitor', billing: 'monthly', discount_type: 'student' }) });
    expect(save.status).toBe(303);
    expect((await members()).results[0]).toMatchObject({ name_override: 'Preferred', discount_type: 'student', discord_user_id: null });
    const history = await (await api(`/admin/members/${member.member_id}/events`, { headers })).text();
    expect(history).toContain('Waiver signed');
    expect(history).toContain('Signature #1, waiver version 1');
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
    expect(detail).toContain('sample liability waiver');
  });
});
