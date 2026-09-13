import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { issueToken, loginDestination, memberToken, verifyOAuthState, verifyToken } from '../src/auth.js';
import { hash, now, randomToken } from '../src/http.js';
import { coordinated } from '../src/membership.js';
import { requireKioskNetwork } from '../src/kiosk-network.js';
import { cleanupFobClaims } from '../src/kiosk.js';

let config, fetchSpy;
const onsite = { 'CF-Connecting-IP': '192.0.2.10' };
const api = (path, options = {}, bindings = config) => worker.fetch(new Request(`${bindings.SITE_URL}${path}`, options), bindings);
const scan = (fob = 123) => api('/kiosk/claims', { method: 'POST', headers: { ...onsite, Origin: config.SITE_URL, 'Content-Type': 'application/json' }, body: JSON.stringify({ fob_id: fob }) });
async function claim(fob = 123) {
  const response = await scan(fob);
  expect(response.status).toBe(201);
  return response.json();
}
async function member(id = '333333333333333333', fob = null) {
  const m = await env.DB.prepare('INSERT INTO members(discord_user_id, discord_username, fob_id) VALUES (?, ?, ?) RETURNING *').bind(id, 'Maker', fob).first();
  const token = await memberToken(config, m);
  return { ...m, token, cookie: `thelab_member=${token}` };
}
const readMember = m => env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(m.member_id).first();
async function bind(c, m, headers = {}, csrf) {
  return api(`/keyfob/bind?token=${c.token}`, { method: 'POST', headers: { Cookie: m.cookie, Origin: config.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ csrf: csrf ?? await hash(`fob-csrf:${m.token}:${c.token}`) }) });
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  config = { ...env, KIOSK_HOSTNAME: `space-${randomToken().slice(0, 16)}.example`, KIOSK_SKIP_IP_CHECK: '' };
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new URL(url).origin).toBe('https://cloudflare-dns.com');
    expect(init.redirect).toBe('manual');
    // Exercise workerd's Request option validation, even with HTTP mocked.
    new Request(url, init);
    const type = Number(new URL(url).searchParams.get('type'));
    return Response.json({ Status: 0, Answer: [{ type, TTL: 60, data: type === 1 ? '192.0.2.10' : '2001:db8::10' }] });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

it('gates the kiosk, issuance and polling; ignores forwarding headers and production bypass', async () => {
  const c = await claim();
  for (const path of ['/kiosk', `/kiosk/claims?token=${c.token}`]) {
    expect((await api(path, { headers: onsite })).status).toBe(200);
    for (const headers of [{}, { 'X-Forwarded-For': '192.0.2.10' }, { 'CF-Connecting-IP': '198.51.100.1' }]) {
      expect((await api(path, { headers }, { ...config, KIOSK_SKIP_IP_CHECK: 'true' })).status).toBe(403);
    }
  }
  expect((await api('/kiosk', { headers: { 'CF-Connecting-IP': '2001:0db8:0:0:0:0:0:10' } })).status).toBe(200);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  expect((await api('/kiosk/claims', { method: 'POST' })).status).toBe(403);
  for (const fob of [0, 4294967296, '123', 1.5, null]) expect((await scan(fob)).status).toBe(400);
  expect((await api('/kiosk/claims', { method: 'POST', headers: onsite })).status).toBe(403);
});

it('allows only the explicit localhost dev bypass and still requires signed claims and Discord', async () => {
  for (const hostname of ['localhost', '127.0.0.1']) {
    const local = { ...config, SITE_URL: `http://${hostname}:8787`, KIOSK_SKIP_IP_CHECK: 'true' };
    expect((await api('/kiosk', {}, local)).status).toBe(200);
    for (const flag of ['', 'false', 'TRUE', true]) expect((await api('/kiosk', {}, { ...local, KIOSK_SKIP_IP_CHECK: flag })).status).toBe(403);
    expect((await api('/keyfob/bind?token=fake', {}, local)).status).toBe(410);
    const response = await api('/kiosk/claims', { method: 'POST', headers: { Origin: local.SITE_URL, 'Content-Type': 'application/json' }, body: '{"fob_id":123}' }, local);
    const c = await response.json();
    expect((await api(`/keyfob/bind?token=${c.token}`, {}, local)).status).toBe(303);
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});

it.each([301, 302, 303, 307, 308])('denies DNS redirects (%s) without following them', async status => {
  fetchSpy.mockImplementation(async (_url, init) => {
    expect(init.redirect).toBe('manual');
    return new Response(null, { status, headers: { Location: 'https://unexpected.example/dns' } });
  });
  expect((await api('/kiosk', { headers: onsite })).status).toBe(503);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
});

it('refreshes DNS at the shortest TTL and fails closed after address changes or lookup failure', async () => {
  const start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  fetchSpy.mockImplementation(async () => Response.json({ Status: 0, Answer: [{ type: 5, TTL: 2, data: 'egress.example.' }, { type: 1, TTL: 600, data: '192.0.2.10' }] }));
  const request = new Request(config.SITE_URL, { headers: onsite });
  await requireKioskNetwork(request, config);
  clock.mockReturnValue(start + 1999);
  await requireKioskNetwork(request, config);
  expect(fetchSpy).toHaveBeenCalledTimes(2);
  clock.mockReturnValue(start + 2001);
  fetchSpy.mockImplementation(async () => Response.json({ Status: 0, Answer: [{ type: 1, TTL: 0, data: '192.0.2.11' }] }));
  await expect(requireKioskNetwork(request, config)).rejects.toMatchObject({ status: 403 });
  fetchSpy.mockRejectedValue(new Error('DNS unavailable'));
  await expect(requireKioskNetwork(request, config)).rejects.toMatchObject({ status: 503 });
  expect((await api('/kiosk', { headers: onsite }, { ...config, KIOSK_HOSTNAME: '' })).status).toBe(503);
});

it('issues a local QR with a five-minute audience-isolated signed token', async () => {
  const c = await claim(4294967295), claims = await verifyToken(config, c.token, 'fob');
  expect(claims.fob_id).toBe(4294967295);
  expect(claims.exp - claims.iat).toBe(300);
  expect(c.expires).toBe(claims.exp);
  expect(c.url).toBe(`${config.SITE_URL}/keyfob/bind?token=${c.token}`);
  expect(atob(c.qr.split(',')[1])).toContain('<svg');
  for (const audience of ['member', 'oauth', 'admin']) expect(await verifyToken(config, c.token, audience)).toBeNull();
  expect(loginDestination(`/keyfob/bind?token=${c.token}`, 'member')).toBe(`/keyfob/bind?token=${c.token}`);
  expect(loginDestination(`/keyfob/bind?token=${c.token}&next=https://evil.example`, 'member')).toBe('/payment/resume');
});

it('preserves the claim through browser-bound Discord OAuth and never links on GET', async () => {
  const c = await claim(), m = await member(), path = `/keyfob/bind?token=${c.token}`;
  const start = await api(path);
  expect(start.status).toBe(303);
  const target = new URL(start.headers.get('Location')), state = target.searchParams.get('state');
  const browserCookie = start.headers.get('Set-Cookie').split(';')[0];
  expect(await verifyOAuthState(config, state, browserCookie.split('=')[1])).toMatchObject({ purpose: 'member', return_to: path });
  fetchSpy.mockImplementation(async url => {
    if (String(url).endsWith('/oauth2/token')) return Response.json({ access_token: 'opaque', token_type: 'Bearer' });
    if (String(url).endsWith('/users/@me')) return Response.json({ id: m.discord_user_id, username: 'Maker', email: 'maker@example.com', verified: true });
    if (String(url).includes('/members/')) return Response.json({ roles: [] });
    throw new Error('Unexpected fetch');
  });
  const callback = await api(`/login/discord/callback?code=test&state=${state}`, { headers: { Cookie: browserCookie } });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('Location')).toBe(c.url);
  const response = await api(path, { headers: { Cookie: m.cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.text()).toContain('Link fob');
  expect((await readMember(m)).fob_id).toBeNull();
});

it('rejects missing auth, cross-origin and wrong-CSRF posts, tampering and wrong audiences', async () => {
  const c = await claim(), m = await member();
  expect((await bind(c, m, { Cookie: '' })).status).toBe(401);
  expect((await bind(c, m, { Origin: 'https://evil.example' })).status).toBe(403);
  expect((await bind(c, m, {}, 'wrong')).status).toBe(403);
  const [header, payload, signature] = c.token.split('.');
  const altered = btoa(JSON.stringify({ ...JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))), fob_id: 999 })).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
  for (const token of [`${header}.${altered}.${signature}`, m.token, await issueToken(config, randomToken(), 'oauth'), await issueToken(config, randomToken(), 'fob', { fob_id: 123 })]) {
    expect((await bind({ token }, m)).status).toBe(410);
  }
  expect((await readMember(m)).fob_id).toBeNull();
});

it('replaces an existing fob from cellular, records history and blocks replay', async () => {
  const c = await claim(), m = await member(undefined, 99);
  expect(await (await api(`/keyfob/bind?token=${c.token}`, { headers: { Cookie: m.cookie } })).text()).toContain('replaces fob <strong>99');
  const response = await bind(c, m);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('Fob linked');
  expect(await readMember(m)).toMatchObject({ fob_id: 123, metadata_version: m.metadata_version + 1 });
  const event = await env.DB.prepare("SELECT details FROM member_events WHERE member_id = ? AND event_type = 'FobChanged'").bind(m.member_id).first();
  expect(JSON.parse(event.details)).toEqual({ from: 99, to: 123 });
  expect(await env.DB.prepare('SELECT ended FROM fob_assignments WHERE fob = 99').first()).toMatchObject({ ended: expect.any(Number) });
  expect(await (await api(`/kiosk/claims?token=${c.token}`, { headers: onsite })).json()).toMatchObject({ claimed: true });
  expect((await bind(c, m)).status).toBe(409);
});

it('rejects ownership conflicts without consuming the claim', async () => {
  const c = await claim(), owner = await member(undefined, 123), other = await member('555555555555555555', 456);
  expect((await bind(c, other)).status).toBe(409);
  expect((await readMember(other)).fob_id).toBe(456);
  expect((await env.DB.prepare('SELECT claimed_by FROM fob_claims').first()).claimed_by).toBeNull();
  expect((await bind(c, owner)).status).toBe(200);
});

it('allows exactly one winner for concurrent redemption and concurrent same-fob claims', async () => {
  const a = await member(), b = await member('555555555555555555'), c = await claim();
  expect((await Promise.all([bind(c, a), bind(c, b)])).map(r => r.status).sort()).toEqual([200, 409]);
  const c1 = await claim(789), c2 = await claim(789);
  expect((await Promise.all([bind(c1, a), bind(c2, b)])).map(r => r.status).sort()).toEqual([200, 409]);
  const rows = await env.DB.prepare('SELECT claimed_by FROM fob_claims WHERE fob_id = 789').all();
  expect(rows.results.filter(r => r.claimed_by !== null)).toHaveLength(1);
});

it('rechecks identity in the lock and rejects expired claims', async () => {
  const c = await claim(), m = await member();
  await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1 WHERE member_id = ?').bind(m.member_id).run();
  await expect(coordinated(config, m.member_id, 'linkFob', { token: c.token, discord_user_id: m.discord_user_id, auth_version: m.auth_version })).rejects.toMatchObject({ status: 401 });
  vi.spyOn(Date, 'now').mockReturnValue((c.expires + 1) * 1000);
  expect((await api(`/keyfob/bind?token=${c.token}`, { headers: { Cookie: m.cookie } })).status).toBe(410);
  await cleanupFobClaims(config);
  expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
});

it('rate limits issuance atomically', async () => {
  await env.DB.prepare(`INSERT INTO fob_claims(id, fob_id, created, expires)
    WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<30)
    SELECT printf('%064d', n), n, ?, ? FROM seq`).bind(now(), now() + 300).run();
  expect((await scan()).status).toBe(429);
});

it('synchronizes replacement immediately and retains the commit when edge delivery fails', async () => {
  const m = await member(undefined, 99);
  await env.DB.prepare('UPDATE members SET non_billable = 1 WHERE member_id = ?').bind(m.member_id).run();
  const edgeConfig = { ...config, EDGE_URL: 'https://edge.example', EDGE_ACCESS_CLIENT_ID: 'client', EDGE_ACCESS_CLIENT_SECRET: 'secret' };
  await runInDurableObject(env.MEMBERS.get(env.MEMBERS.idFromName(m.member_id)), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
  await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
  const c = await claim(), next = await claim(456), writes = [];
  fetchSpy.mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://edge.example/api/goal');
    if (init.method === 'GET') return new Response(null, { status: 503 });
    writes.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  expect((await bind(c, m)).status).toBe(200);
  expect(writes).toEqual([{ version: expect.any(Number), fobs: [123] }]);
  fetchSpy.mockRejectedValue(new Error('Edge offline'));
  expect((await bind(next, m)).status).toBe(200);
  expect((await readMember(m)).fob_id).toBe(456);
  await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).not.toBeNull(); });
});
