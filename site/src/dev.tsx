// Local development sign-in. Enabled only when DEV_AUTH=1 (set in .dev.vars;
// left empty in production). It never contacts Discord.
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import { HttpError, redirect, safeNext, readSession, sessionCookie, type Member } from './lib.ts';

// A stand-in for a Discord account. Access fields apply only when the local
// member row is first created, so edits made through the admin pages persist.
interface DevUser {
	key: string;
	name: string;
	username: string;
	email: string;
	discordID: string;
	admin: boolean;
	non_billable?: 0 | 1;
	waiver_signed?: 0 | 1;
	stripe_subscription_state?: string;
}

const users: readonly DevUser[] = [
	{
		key: 'admin',
		name: 'Dev Admin',
		username: 'dev_admin',
		email: 'dev-admin@example.com',
		discordID: '900000000000000001',
		admin: true,
		non_billable: 1,
		waiver_signed: 1,
	},
	{
		key: 'member',
		name: 'Dev Member',
		username: 'dev_member',
		email: 'dev-member@example.com',
		discordID: '900000000000000002',
		admin: false,
		stripe_subscription_state: 'active',
		waiver_signed: 1,
	},
	{
		key: 'new',
		name: 'Dev New Member',
		username: 'dev_new',
		email: 'dev-new@example.com',
		discordID: '900000000000000003',
		admin: false,
	},
];

export const devAuth = (env: Env) => env.DEV_AUTH === '1';

// Reuses an existing member linked by email; otherwise creates one. Later sign-ins
// keep the current row, including any changes made in the admin pages.
async function ensureDevMember(env: Env, user: DevUser) {
	const existing = await env.DB.prepare('SELECT member_id FROM members WHERE discord_user_id = ?')
		.bind(user.discordID)
		.first();
	if (existing) {
		await env.DB.prepare('UPDATE members SET discord_username = ?, discord_email = ? WHERE discord_user_id = ?')
			.bind(user.username, user.email, user.discordID)
			.run();
		return;
	}
	const linked =
		await env.DB.prepare(`UPDATE members SET discord_user_id = ?1, discord_username = ?2, discord_email = ?3
    WHERE email = ?4 AND discord_user_id IS NULL RETURNING member_id`)
			.bind(user.discordID, user.username, user.email, user.email)
			.first();
	if (linked) return;
	// A pre-registered member with this email may belong to another account.
	const email = (await env.DB.prepare('SELECT 1 FROM members WHERE email = ?').bind(user.email).first())
		? null
		: user.email;
	const created = await env.DB.prepare(`INSERT INTO members
    (discord_user_id, discord_username, discord_email, email, name_override, non_billable, waiver_signed, stripe_subscription_state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING member_id`)
		.bind(
			user.discordID,
			user.username,
			user.email,
			email,
			user.name,
			user.non_billable ?? 0,
			user.waiver_signed ?? 0,
			user.stripe_subscription_state ?? null,
		)
		.first();
	if (!created) throw new Error('Development member registration returned no row.');
}

function chooser(env: Env, next: string, current: Member | null) {
	const href = (user: DevUser) => {
		const params = new URLSearchParams({ user: user.key });
		if (next !== '/') params.set('next', next);
		return `/dev/login?${params}`;
	};
	const currentID = current?.discord_user_id;
	return page(
		'Development sign-in',
		<>
			<p role="status">Discord sign-in is replaced by local accounts. Choose who to sign in as.</p>
			{current && (
				<p>
					Currently signed in as{' '}
					<strong>{current.name_override || current.discord_username || current.email || 'Member'}</strong>.
				</p>
			)}
			<div class="membership-actions">
				{users.map(user => (
					<a class={`btn ${user.admin ? 'btn-primary' : 'btn-outline'}`} href={href(user)}>
						{user.name}
						{user.discordID === currentID ? ' (current)' : ''}
					</a>
				))}
			</div>
			<p class="card-desc">
				New accounts are created in the local database on first sign-in. <strong>DEV_AUTH</strong> comes from{' '}
				<strong>.dev.vars</strong> and stays empty in production.
			</p>
			<p class="card-desc">
				{env.SITE_URL} · <a href="/">Back to TheLab</a>
			</p>
		</>,
	);
}

export async function devLogin(request: Request, env: Env) {
	if (!devAuth(env)) throw new HttpError(404, 'Page not found.');
	const url = new URL(request.url);
	const next = safeNext(url.searchParams.get('next'));
	const key = url.searchParams.get('user');
	const session = await readSession(request, env);
	if (!key) {
		const current = session
			? await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(session.sub).first<Member>()
			: null;
		return chooser(env, next, current ?? null);
	}
	const user = users.find(candidate => candidate.key === key);
	if (!user) throw new HttpError(404, 'Unknown development user.');
	await ensureDevMember(env, user);
	const response = redirect(next);
	response.headers.append('Set-Cookie', await sessionCookie(env, user.discordID, user.admin));
	return response;
}
