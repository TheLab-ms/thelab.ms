import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../src/lib.ts';
import { call, count, edgeEnv, insertMember, mockFetch, quiet, readMember, resetDB, session } from './helpers.ts';

const user = { id: '333333333333333333', username: 'maker', email: 'Maker@Example.com', verified: true };
const oauthCookie = (state = 'state-1', next = '/machines') => `thelab_oauth=${encodeURIComponent(JSON.stringify({ state, next }))}`;
const setCookies = (response: Response) => response.headers.getSetCookie();

function discordMocks({ me = user, roles = [] as string[], guild = true } = {}) {
  return mockFetch([
    ['POST', 'https://discord.com/api/v10/oauth2/token', { access_token: 'access', token_type: 'Bearer' }],
    ['GET', 'https://discord.com/api/v10/users/@me', me],
    ['GET', `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${me.id}`,
      guild ? { user: { id: me.id, username: me.username }, roles } : new Response('{}', { status: 404 })],
    ['PUT', `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${me.id}/roles/${env.DISCORD_ROLE_ID}`, new Response(null, { status: 204 })],
  ]);
}

describe('Sign-in', () => {
  beforeEach(resetDB);
  afterEach(() => vi.restoreAllMocks());

  it('starts Discord OAuth with a browser-bound state and a same-site destination', async () => {
    for (const [next, expected] of [['/keyfob/bind?token=abc', '/keyfob/bind?token=abc'], ['//evil.example', '/'], ['https://evil.example', '/'], ['/\\evil.example', '/'], ['/\t/evil.example', '/'], [null, '/']]) {
      const response = await call(`/login${next === null ? '' : `?next=${encodeURIComponent(next)}`}`);
      expect(response.status).toBe(303);
      const target = new URL(response.headers.get('Location')!);
      expect(target.origin + target.pathname).toBe('https://discord.com/oauth2/authorize');
      expect(target.searchParams.get('redirect_uri')).toBe(`${env.SITE_URL}/login/callback`);
      const cookie = setCookies(response)[0];
      expect(cookie).toMatch(/^thelab_oauth=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
      const saved = JSON.parse(decodeURIComponent(cookie.split(';')[0].slice('thelab_oauth='.length)));
      expect(saved).toEqual({ state: target.searchParams.get('state'), next: expected });
    }
  });

  it('rejects callbacks without the matching browser state', async () => {
    quiet();
    const calls = mockFetch();
    for (const [query, cookie] of [['?state=state-1&code=c', ''], ['?state=other&code=c', oauthCookie()], ['?code=c', oauthCookie()]]) {
      const response = await call(`/login/callback${query}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain('Invalid or expired Discord sign-in');
    }
    expect(calls).toHaveLength(0);
  });

  it('rate limits callbacks per client IP before contacting Discord', async () => {
    quiet();
    const calls = mockFetch();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await call('/login/callback?state=state-1&code=c', { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(statuses[10]).toBe(429);
    expect((await call('/login/callback?state=state-1&code=c', { headers: { 'CF-Connecting-IP': '203.0.113.8' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('registers the member, refreshes the identity, and sets one session cookie', async () => {
    const calls = discordMocks();
    const response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/machines');
    const [sessionCookie, cleared] = setCookies(response);
    expect(sessionCookie).toMatch(/^thelab_session=[\w-]+\.[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure$/);
    expect(cleared).toMatch(/^thelab_oauth=; .*Max-Age=0/);
    expect(new URLSearchParams(calls[0].body).get('redirect_uri')).toBe(`${env.SITE_URL}/login/callback`);
    const member = (await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(user.id).first<Member>())!;
    expect(member).toMatchObject({ discord_username: 'maker', discord_email: 'maker@example.com', email: 'maker@example.com' });

    // A later login refreshes the username without creating another member.
    vi.restoreAllMocks();
    discordMocks({ me: { ...user, username: 'renamed' } });
    await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(await readMember(member.member_id)).toMatchObject({ discord_username: 'renamed' });
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(1);
  });

  it('links a pre-registered member by email but never moves a linked account', async () => {
    const pending = await insertMember({ email: 'maker@example.com' });
    discordMocks();
    await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(await readMember(pending.member_id)).toMatchObject({ discord_user_id: user.id, metadata_version: 1 });

    vi.restoreAllMocks();
    const other = { ...user, id: '555555555555555555' };
    discordMocks({ me: other });
    const response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(response.status).toBe(303);
    expect(await readMember(pending.member_id)).toMatchObject({ discord_user_id: user.id });
    expect(await env.DB.prepare('SELECT email, discord_email FROM members WHERE discord_user_id = ?').bind(other.id).first())
      .toEqual({ email: null, discord_email: 'maker@example.com' });
  });

  it('grants admin from the Discord role at sign-in', async () => {
    discordMocks({ roles: [env.DISCORD_ADMIN_ROLE_ID] });
    const response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie('state-1', '/admin') } });
    const cookie = setCookies(response)[0].split(';')[0];
    vi.restoreAllMocks();
    expect((await call('/admin', { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it.each(['active', 'trialing'])('grants the member role when linking an already %s membership', async state => {
    const pending = await insertMember({ email: 'maker@example.com', stripe_customer_id: 'cus_paid', stripe_subscription_state: state });
    const calls = discordMocks();
    const response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(response.status).toBe(303);
    expect(await readMember(pending.member_id)).toMatchObject({ discord_user_id: user.id, stripe_subscription_state: state });
    expect(calls.filter(c => c.method === 'PUT').map(c => c.url)).toEqual([
      `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}/roles/${env.DISCORD_ROLE_ID}`,
    ]);
  });

  it('restores a paid member’s role after rejoining Discord and skips an existing role', async () => {
    await insertMember({ discord_user_id: user.id, stripe_subscription_state: 'active' });
    let calls = discordMocks();
    expect((await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } })).status).toBe(303);
    expect(calls.some(c => c.method === 'PUT')).toBe(true);
    vi.restoreAllMocks();
    calls = discordMocks({ roles: [env.DISCORD_ROLE_ID] });
    expect((await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } })).status).toBe(303);
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('requires Discord server membership and a verified email', async () => {
    quiet();
    discordMocks({ guild: false });
    let response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('join TheLab’s Discord server');
    vi.restoreAllMocks();
    quiet();
    discordMocks({ me: { ...user, verified: false } });
    response = await call('/login/callback?state=state-1&code=c', { headers: { Cookie: oauthCookie() } });
    expect(response.status).toBe(403);
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(0);
  });

  it('ignores tampered and expired sessions', async () => {
    quiet();
    await env.DB.prepare("INSERT INTO members (discord_user_id, non_billable) VALUES (?, 1)").bind(user.id).run();
    const valid = await session(user.id);
    expect((await call('/machines/data', { headers: { Cookie: valid } }, edgeEnv)).status).toBe(200);
    const [payload, signature] = valid.slice('thelab_session='.length).split('.');
    const forged = btoa(JSON.stringify({ sub: user.id, admin: true, exp: 9e9 })).replace(/=+$/, '');
    for (const cookie of [`thelab_session=${forged}.${signature}`, `thelab_session=${payload}.${signature}x`, `thelab_session=${payload}`]) {
      expect((await call('/machines/data', { headers: { Cookie: cookie } })).status).toBe(401);
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86401000);
    expect((await call('/machines/data', { headers: { Cookie: valid } })).status).toBe(401);
  });

  it('logs out only from same-origin forms', async () => {
    quiet();
    const cookie = await session(user.id);
    expect((await call('/logout', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
    const response = await call('/logout', { method: 'POST', headers: { Cookie: cookie, Origin: env.SITE_URL } });
    expect(response.status).toBe(303);
    expect(setCookies(response)[0]).toMatch(/^thelab_session=; .*Max-Age=0/);
  });
});
