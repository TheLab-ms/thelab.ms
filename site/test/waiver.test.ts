import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../src/lib.ts';
import { call, count, insertMember, mockFetch, post, quiet, resetDB, session } from './helpers.ts';

const siteverify = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const verified = (overrides = {}) => ({ success: true, hostname: 'thelab.example', action: 'waiver', ...overrides });
const fields = (overrides = {}) => ({
  agree_signature: 'on', agree_terms: 'on', name: ' Maker Person ', email: ' Maker@Example.com ', 'cf-turnstile-response': 'token', ...overrides,
});
const waivers = async () => (await env.DB.prepare('SELECT member_id, name, email FROM waivers ORDER BY id').all()).results;

describe('Waiver signing', () => {
  beforeEach(resetDB);
  afterEach(() => vi.restoreAllMocks());

  it('records a public signature, creating a pre-registered member by email', async () => {
    const calls = mockFetch([['POST', siteverify, verified()]]);
    const response = await call('/waiver/sign', post(fields()));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Thanks, Maker Person. Your waiver has been recorded.');
    const member = (await env.DB.prepare('SELECT * FROM members').first<Member>())!;
    expect(member).toMatchObject({ email: 'maker@example.com', waiver_name: 'Maker Person' });
    expect(await waivers()).toEqual([{ member_id: member.member_id, name: 'Maker Person', email: 'maker@example.com' }]);
    expect(Object.fromEntries(new URLSearchParams(calls[0].body))).toMatchObject({ secret: env.TURNSTILE_SECRET_KEY, response: 'token' });
  });

  it('links to the member whose Discord email matches, but never guesses between two', async () => {
    mockFetch([['POST', siteverify, verified()]]);
    const linked = await insertMember({ discord_user_id: '333333333333333333', discord_email: 'maker@example.com' });
    expect((await call('/waiver/sign', post(fields()))).status).toBe(200);
    expect((await waivers())[0].member_id).toBe(linked.member_id);
    quiet();
    await insertMember({ email: 'maker@example.com' });
    const response = await call('/waiver/sign', post(fields()));
    expect(response.status).toBe(409);
    expect(await waivers()).toHaveLength(1);
  });

  it('links signed-in members to their own membership and continues to checkout when unpaid', async () => {
    mockFetch([['POST', siteverify, verified()]]);
    const member = await insertMember({ discord_user_id: '333333333333333333', email: 'member@example.com' });
    const cookie = await session(member.discord_user_id!);
    let response = await call('/waiver/sign', post(fields({ email: 'other@example.com' }), { Cookie: cookie }));
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/checkout');
    expect((await waivers())[0]).toMatchObject({ member_id: member.member_id, email: 'other@example.com' });
    await env.DB.prepare("UPDATE members SET stripe_subscription_state = 'active'").run();
    response = await call('/waiver/sign', post(fields(), { Cookie: cookie }));
    expect(response.status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(1);
  });

  it.each([
    ['a missing agreement', { agree_terms: '' }, 400, 'You must agree'],
    ['a missing name', { name: ' ' }, 400, 'Enter your legal name'],
    ['an invalid email', { email: 'maker' }, 400, 'Enter a valid email'],
    ['a missing verification token', { 'cf-turnstile-response': '' }, 400, 'complete the human verification'],
  ])('rejects %s', async (_name, overrides, status, message) => {
    quiet();
    mockFetch([['POST', siteverify, verified()]]);
    const response = await call('/waiver/sign', post(fields(overrides)));
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(message);
    expect(await waivers()).toEqual([]);
  });

  it.each([{ success: false }, { hostname: 'evil.example' }, { action: 'login' }])('rejects failed human verification: %o', async result => {
    quiet();
    mockFetch([['POST', siteverify, verified(result)]]);
    expect((await call('/waiver/sign', post(fields()))).status).toBe(400);
    expect(await waivers()).toEqual([]);
  });

  it('rejects cross-origin submissions before reading them', async () => {
    quiet();
    const calls = mockFetch();
    expect((await call('/waiver/sign', post(fields(), { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
