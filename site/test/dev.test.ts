import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Member } from '../src/lib.ts';
import { call, mockFetch, quiet, resetDB } from './helpers.ts';

const devEnv: Env = { ...env, DEV_AUTH: '1' };
const adminID = '900000000000000001';
const memberID = '900000000000000002';
const newID = '900000000000000003';

const setCookies = (response: Response) => response.headers.getSetCookie();
const sessionCookie = (response: Response) =>
	setCookies(response)
		.find(cookie => cookie.startsWith('thelab_session='))!
		.split(';')[0]!;
const memberRow = (discordID: string) =>
	env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(discordID).first<Member>();

describe('Development sign-in', () => {
	beforeEach(resetDB);
	afterEach(() => vi.restoreAllMocks());

	it('is unavailable unless DEV_AUTH is enabled', async () => {
		quiet();
		const calls = mockFetch();
		expect((await call('/dev/login')).status).toBe(404);
		expect((await call('/dev/login?user=admin')).status).toBe(404);
		expect((await call('/login?next=/wallet')).headers.get('Location')).toMatch(/^https:\/\/discord\.com\//);
		expect(calls).toHaveLength(0);
	});

	it('lists the local accounts without contacting Discord', async () => {
		const calls = mockFetch();
		const response = await call('/login?next=/wallet', {}, devEnv);
		expect(response.status).toBe(200);
		const html = await response.text();
		for (const name of ['Dev Admin', 'Dev Member', 'Dev New Member']) expect(html).toContain(name);
		expect(html).toContain('user=admin');
		expect(html).toContain('next=%2Fwallet');
		expect(calls).toHaveLength(0);
	});

	it('signs in an admin and creates the default member', async () => {
		const calls = mockFetch();
		const response = await call('/dev/login?user=admin&next=/admin', {}, devEnv);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/admin');
		expect(setCookies(response)[0]).toMatch(/^thelab_session=[\w-]+\.[\w-]+; .*Max-Age=86400/);
		expect((await call('/admin', { headers: { Cookie: sessionCookie(response) } }, devEnv)).status).toBe(200);
		expect(await memberRow(adminID)).toMatchObject({
			name_override: 'Dev Admin',
			discord_username: 'dev_admin',
			non_billable: 1,
			waiver_signed: 1,
		});
		expect(calls).toHaveLength(0);
	});

	it('creates a non-admin member with an active membership', async () => {
		const response = await call('/dev/login?user=member', {}, devEnv);
		const cookie = sessionCookie(response);
		expect(await memberRow(memberID)).toMatchObject({
			name_override: 'Dev Member',
			stripe_subscription_state: 'active',
			waiver_signed: 1,
			non_billable: 0,
		});
		expect((await call('/admin', { headers: { Cookie: cookie } }, devEnv)).status).toBe(403);
		expect((await call('/wallet', { headers: { Cookie: cookie } }, devEnv)).status).toBe(200);
	});

	it('creates a member without waiver or membership access', async () => {
		quiet();
		const response = await call('/dev/login?user=new', {}, devEnv);
		const cookie = sessionCookie(response);
		expect(await memberRow(newID)).toMatchObject({
			name_override: 'Dev New Member',
			stripe_subscription_state: null,
			waiver_signed: 0,
			non_billable: 0,
		});
		expect((await call('/machines/data', { headers: { Cookie: cookie } }, devEnv)).status).toBe(403);
	});

	it('switches accounts and keeps existing member changes', async () => {
		const admin = sessionCookie(await call('/dev/login?user=admin', {}, devEnv));
		await env.DB.prepare('UPDATE members SET notes = ? WHERE discord_user_id = ?').bind('kept', adminID).run();

		const switched = await call('/dev/login?user=member', { headers: { Cookie: admin } }, devEnv);
		const cookie = sessionCookie(switched);
		expect(cookie).not.toBe(admin);
		expect((await call('/admin', { headers: { Cookie: cookie } }, devEnv)).status).toBe(403);

		await call('/dev/login?user=admin', { headers: { Cookie: cookie } }, devEnv);
		expect(await memberRow(adminID)).toMatchObject({ notes: 'kept' });
	});

	it('rejects unknown accounts and unsafe destinations', async () => {
		quiet();
		expect((await call('/dev/login?user=nobody', {}, devEnv)).status).toBe(404);
		const response = await call('/dev/login?user=admin&next=//evil.example', {}, devEnv);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/');
	});

	it('sends logout back to the account chooser', async () => {
		const cookie = sessionCookie(await call('/dev/login?user=admin', {}, devEnv));
		const response = await call(
			'/logout',
			{ method: 'POST', headers: { Cookie: cookie, Origin: env.SITE_URL } },
			devEnv,
		);
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('/dev/login');
	});
});
