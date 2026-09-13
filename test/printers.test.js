import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { loginDestination, memberToken, verifyToken } from '../src/auth.js';

const id = '333333333333333333';
const state = 'a'.repeat(64);
let bindings, publicKey;
const request = (path, cookie = '') => worker.fetch(new Request(`${env.SITE_URL}${path}`, { headers: { Cookie: cookie } }), bindings);
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  publicKey = pair.publicKey;
  bindings = { ...env, PRINTER_EDGE_URL: 'https://edge.example', PRINTER_JWT_PRIVATE_KEY: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))) };
});

afterEach(() => vi.restoreAllMocks());

async function memberCookie(status) {
  const member = await env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, stripe_subscription_state) VALUES (?, ?, ?, ?) RETURNING *')
    .bind(id, 'maker', 'maker@example.com', status).first();
  return `thelab_member=${await memberToken(env, member)}`;
}

it('starts the nonce handoff and preserves its destination through member OAuth', async () => {
  expect((await request('/machines')).headers.get('Location')).toBe('https://edge.example/machines/login');
  const response = await request(`/machines?state=${state}`);
  const oauth = new URL(response.headers.get('Location')).searchParams.get('state');
  expect(await verifyToken(env, oauth, 'oauth')).toMatchObject({ purpose: 'member', return_to: `/machines?state=${state}` });
  expect(loginDestination('/machines?state=https://evil.example', 'member')).toBe('/payment/resume');
  expect(loginDestination(`/machines?state=${state}`, 'admin')).toBe('/admin');
});

it('completes Discord sign-in and returns to the nonce-bound printer authorization route', async () => {
  await memberCookie('active');
  const start = await request(`/machines?state=${state}`);
  const oauth = new URL(start.headers.get('Location')).searchParams.get('state');
  const oauthCookie = start.headers.get('Set-Cookie').split(';')[0];
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const path = new URL(input).pathname;
    if (path === '/api/v10/oauth2/token') return Response.json({ access_token: 'discord-access', token_type: 'Bearer' });
    if (path === '/api/v10/users/@me') return Response.json({ id, username: 'maker', email: 'maker@example.com', verified: true });
    if (path === `/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${id}`) return Response.json({ user: { id }, roles: [] });
    throw new Error(`Unexpected provider request: ${path}`);
  });
  const callback = await request(`/login/discord/callback?code=test-code&state=${oauth}`, oauthCookie);
  expect(callback.status).toBe(303);
  expect(callback.headers.get('Location')).toBe(`${env.SITE_URL}/machines?state=${state}`);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('thelab_member=')).split(';')[0];
  const access = await request(`/machines?state=${state}`, cookie);
  expect(access.status).toBe(303);
  expect(access.headers.get('Location')).toContain('https://edge.example/machines/callback#token=');
});

it.each(['active', 'trialing'])('issues a verifiable, scoped five-minute JWT for %s members', async status => {
  const response = await request(`/machines?state=${state}`, await memberCookie(status));
  expect(response.status).toBe(303);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const target = new URL(response.headers.get('Location'));
  expect(target.origin + target.pathname).toBe('https://edge.example/machines/callback');
  expect(target.search).toBe('');
  const [header, payload, signature] = new URLSearchParams(target.hash.slice(1)).get('token').split('.');
  expect(JSON.parse(new TextDecoder().decode(decode(header)))).toEqual({ alg: 'EdDSA', typ: 'JWT' });
  expect(await crypto.subtle.verify('Ed25519', publicKey, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
  expect(claims).toMatchObject({ iss: env.SITE_URL, aud: bindings.PRINTER_EDGE_URL, sub: id, active_member: true, scope: 'printers:read', state });
  expect(claims.exp - claims.iat).toBe(300);
});

it.each([null, 'past_due', 'canceled', 'unpaid', 'incomplete', 'paused'])('denies %s membership', async status => {
  const response = await request(`/machines?state=${state}`, await memberCookie(status));
  expect(response.status).toBe(403);
  expect(response.headers.get('Location')).toBeNull();
});

it('rechecks database membership and session revocation on renewal', async () => {
  const cookie = await memberCookie('active');
  expect((await request(`/machines?state=${state}`, cookie)).status).toBe(303);
  await env.DB.prepare("UPDATE members SET stripe_subscription_state = 'canceled'").run();
  expect((await request(`/machines?state=${state}`, cookie)).status).toBe(403);
  await env.DB.prepare('UPDATE members SET auth_version = auth_version + 1').run();
  expect((await request(`/machines?state=${state}`, cookie)).headers.get('Location')).toContain('https://discord.com/oauth2/authorize');
});

it('rejects malformed state and unsafe or incomplete configuration', async () => {
  for (const query of ['?state=bad', `?state=${state}&state=${state}`, `?state=${state}&return_to=https://evil.example`]) {
    expect((await request(`/machines${query}`)).status).toBe(400);
  }
  const cookie = await memberCookie('active');
  bindings.PRINTER_JWT_PRIVATE_KEY = 'invalid';
  expect((await request(`/machines?state=${state}`, cookie)).status).toBe(503);
  for (const origin of ['', 'http://edge.example', 'https://edge.example/path', 'https://user:password@edge.example']) {
    bindings.PRINTER_EDGE_URL = origin;
    expect((await request('/machines')).status).toBe(503);
  }
});
