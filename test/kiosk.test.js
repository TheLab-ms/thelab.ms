import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { issueToken, loginDestination, memberToken, verifyOAuthState, verifyToken } from '../src/auth.js';
import { hash, now, randomToken } from '../src/http.js';
import { coordinated } from '../src/membership.js';
import { cleanupFobClaims, fobClaim } from '../src/fob-claims.js';
import { testEdgePrivateKey } from './edge-auth-helpers.js';

let config, fetchSpy, edgeClaims;
const api = (path, options = {}, bindings = config) => worker.fetch(new Request(`${bindings.SITE_URL}${path}`, options), bindings);
async function claim(fob = 123) {
  const token = randomToken(), expires = now() + 300;
  edgeClaims.set(token, { id: token, fob_id: fob, created: now(), expires });
  return { token, expires, url: `${config.SITE_URL}/keyfob/bind?token=${token}` };
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
  config = { ...env, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
  edgeClaims = new Map();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new URL(url).origin).toBe(config.EDGE_URL);
    expect(new URL(url).pathname).toBe('/api/kiosk/claim');
    expect(init.redirect).toBe('manual');
    expect(init.headers.Authorization).toMatch(/^Bearer /);
    new Request(url, init);
    const claim = edgeClaims.get(new URL(url).searchParams.get('token'));
    return claim ? Response.json(claim) : new Response(null, { status: 410 });
  });
});
afterEach(() => { vi.restoreAllMocks(); });

it('redirects the kiosk to the LAN hostname without network authentication', async () => {
  const response = await api('/kiosk', {}, { ...config, EDGE_URL: '' });
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('https://edge.thelab.ms/kiosk');
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('validates an opaque edge claim once and preserves it through Discord login', async () => {
  const c = await claim(4294967295);
  expect(await fobClaim(config, c.token)).toMatchObject({ id: c.token, fob_id: 4294967295, expires: c.expires, claimed_by: null });
  await fobClaim(config, c.token);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  for (const audience of ['member', 'oauth', 'admin']) expect(await verifyToken(config, c.token, audience)).toBeNull();
  expect(loginDestination(`/keyfob/bind?token=${c.token}`, 'member')).toBe(`/keyfob/bind?token=${c.token}`);
  expect(loginDestination(`/keyfob/bind?token=${c.token}&next=https://evil.example`, 'member')).toBe('/payment/resume');
});

it.each([301, 302, 303, 307, 308, 401, 500])('rejects unsuccessful edge lookups (%s) without following redirects', async status => {
  const c = await claim();
  fetchSpy.mockImplementation(async (_url, init) => {
    expect(init.redirect).toBe('manual');
    return new Response(null, { status, headers: { Location: 'https://unexpected.example/claim' } });
  });
  expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
  expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
});

it('rejects unavailable or malformed edge claims', async () => {
  const c = await claim();
  for (const invalid of [{ id: randomToken() }, { fob_id: 0 }, { fob_id: '123' }, { expires: c.expires + 1 }, { created: now() + 10 }]) {
    fetchSpy.mockResolvedValueOnce(Response.json({ ...edgeClaims.get(c.token), ...invalid }));
    expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
  }
  fetchSpy.mockResolvedValueOnce(Response.json({ ...edgeClaims.get(c.token), created: now() - 301, expires: now() - 1 }));
  expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(410);
  fetchSpy.mockRejectedValue(new Error('Edge unavailable'));
  expect((await api(`/keyfob/bind?token=${c.token}`)).status).toBe(503);
  expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
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
  for (const token of [`${c.token}x`, m.token, await issueToken(config, randomToken(), 'oauth'), randomToken()]) {
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
  await fobClaim(config, c.token);
  await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1 WHERE member_id = ?').bind(m.member_id).run();
  await expect(coordinated(config, m.member_id, 'linkFob', { token: c.token, discord_user_id: m.discord_user_id, auth_version: m.auth_version })).rejects.toMatchObject({ status: 401 });
  vi.spyOn(Date, 'now').mockReturnValue((c.expires + 1) * 1000);
  expect((await api(`/keyfob/bind?token=${c.token}`, { headers: { Cookie: m.cookie } })).status).toBe(410);
  await cleanupFobClaims(config);
  expect(await env.DB.prepare('SELECT count(*) n FROM fob_claims').first()).toEqual({ n: 0 });
});

it('synchronizes replacement immediately and retains the commit when edge delivery fails', async () => {
  const m = await member(undefined, 99);
  await env.DB.prepare('UPDATE members SET non_billable = 1 WHERE member_id = ?').bind(m.member_id).run();
  const edgeConfig = { ...config, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
  await runInDurableObject(env.MEMBERS.get(env.MEMBERS.idFromName(m.member_id)), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
  await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), instance => { instance.env = { ...instance.env, ...edgeConfig }; });
  const c = await claim(), next = await claim(456), writes = [];
  await fobClaim(config, c.token);
  await fobClaim(config, next.token);
  fetchSpy.mockImplementation(async (url, init) => {
    expect(String(url)).toBe('https://edge.example/api/goal');
    if (init.method === 'GET') return new Response(null, { status: 503 });
    writes.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  expect((await bind(c, m)).status).toBe(200);
  expect(writes).toEqual([{ version: expect.any(Number), fobs: [123], event_signing_key: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).toBeNull(); });
  fetchSpy.mockRejectedValue(new Error('Edge offline'));
  expect((await bind(next, m)).status).toBe(200);
  expect((await readMember(m)).fob_id).toBe(456);
  await runInDurableObject(env.EDGE_SYNC.get(env.EDGE_SYNC.idFromName('edge')), async (_instance, ctx) => { expect(await ctx.storage.getAlarm()).not.toBeNull(); });
});
