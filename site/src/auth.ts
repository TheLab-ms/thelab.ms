// Discord sign-in. One session cookie serves members and admins.
import {
  HttpError, ProviderError, discord, discordID, getCookie, grantsMembership, isRecord, provider, randomToken, origin, redirect,
  sessionCookie, setCookie, validEmail,
  type GuildMember, type Member,
} from './lib.ts';
import { syncDiscordRole } from './billing.ts';

const callbackURL = (env: Env) => `${origin(env)}/login/callback`;
// Only same-site paths survive the OAuth round trip. Browsers drop tabs and
// newlines from redirect URLs, so "/\t/evil.example" would become "//evil.example".
const safeNext = (value: unknown) => typeof value === 'string' && /^\/(?![/\\])[^\x00-\x1f\x7f]*$/.test(value) ? value : '/';

export function login(request: Request, env: Env) {
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
  const state = randomToken();
  const next = safeNext(new URL(request.url).searchParams.get('next'));
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify email', prompt: 'none',
    redirect_uri: callbackURL(env), state,
  }).toString();
  const response = redirect(target.href);
  response.headers.append('Set-Cookie', setCookie(env, 'thelab_oauth', encodeURIComponent(JSON.stringify({ state, next })), 600));
  return response;
}

export interface DiscordIdentity { id: string; username: string; email: string }

async function discordIdentity(env: Env, code: string): Promise<DiscordIdentity> {
  const token = await provider<{ access_token?: unknown }>('Discord', 'https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: callbackURL(env),
    }).toString(),
  });
  if (typeof token.access_token !== 'string') throw new HttpError(502, 'Discord sign-in failed. Please try again.');
  const user = await provider<Partial<Record<'id' | 'username' | 'email' | 'verified' | 'bot', unknown>>>(
    'Discord', 'https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (typeof user.id !== 'string' || !discordID.test(user.id) || typeof user.username !== 'string' || !user.username || user.bot) throw new HttpError(502, 'Discord sign-in failed. Please try again.');
  if (user.verified !== true || typeof user.email !== 'string' || !validEmail(user.email)) throw new HttpError(403, 'Please verify your email in Discord before signing in.');
  return { id: user.id, username: user.username, email: user.email.trim().toLowerCase() };
}

// Links a pre-registered member by email, or creates a new member, then
// refreshes the Discord identity. A linked account is never moved by email.
export async function registerMember(env: Env, user: DiscordIdentity) {
  const [, , refreshed] = await env.DB.batch<Member>([
    env.DB.prepare(`UPDATE members SET discord_user_id = ?1, metadata_version = metadata_version + 1
      WHERE email = ?2 AND discord_user_id IS NULL AND NOT EXISTS (SELECT 1 FROM members WHERE discord_user_id = ?1)`)
      .bind(user.id, user.email),
    env.DB.prepare(`INSERT INTO members (discord_user_id, email)
      SELECT ?1, CASE WHEN EXISTS (SELECT 1 FROM members WHERE email = ?2) THEN NULL ELSE ?2 END
      WHERE NOT EXISTS (SELECT 1 FROM members WHERE discord_user_id = ?1)`).bind(user.id, user.email),
    env.DB.prepare('UPDATE members SET discord_username = ?, discord_email = ? WHERE discord_user_id = ? RETURNING *')
      .bind(user.username, user.email, user.id),
  ]);
  const member = refreshed?.results[0];
  if (!member) throw new Error('Member registration returned no row.');
  return member;
}

export async function callback(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip && !(await env.LOGIN_LIMITER.limit({ key: ip })).success) throw new HttpError(429, 'Too many sign-in attempts. Please wait a minute and try again.');
  const url = new URL(request.url);
  let saved: unknown;
  try { saved = JSON.parse(decodeURIComponent(getCookie(request, 'thelab_oauth') || '')); } catch { /* Rejected below. */ }
  if (!isRecord(saved) || !saved.state || url.searchParams.get('state') !== saved.state) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const code = url.searchParams.get('code');
  if (!code) throw new HttpError(400, 'Discord sign-in was not authorized. Please start again.');
  const user = await discordIdentity(env, code);
  let guildMember;
  try {
    guildMember = await discord<GuildMember>(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
  } catch (error) {
    if (error instanceof ProviderError && error.providerStatus === 404) throw new HttpError(403, 'Please join TheLab’s Discord server, then sign in again.');
    throw error;
  }
  const roles = Array.isArray(guildMember.roles) ? guildMember.roles : [];
  const member = await registerMember(env, user);
  // Shared checkout can precede Discord linking, and rejoining loses guild roles.
  if (grantsMembership(member.stripe_subscription_state) && !roles.includes(env.DISCORD_ROLE_ID)) {
    await syncDiscordRole(env, member.member_id);
  }
  const admin = roles.includes(env.DISCORD_ADMIN_ROLE_ID);
  const response = redirect(safeNext(saved.next));
  response.headers.append('Set-Cookie', await sessionCookie(env, user.id, admin));
  response.headers.append('Set-Cookie', setCookie(env, 'thelab_oauth', '', 0));
  return response;
}

export function logout(_request: Request, env: Env) {
  const response = redirect('/');
  response.headers.append('Set-Cookie', setCookie(env, 'thelab_session', '', 0));
  return response;
}
