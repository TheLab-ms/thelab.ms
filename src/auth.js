import { cookie, cookieHeader, discordID, hash, HttpError, now, origin, randomToken, redirect } from './http.js';

export const TOKEN_AGE = { member: 86400, admin: 8 * 3600 };
const encoder = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const json = value => encode(encoder.encode(JSON.stringify(value)));

function configured(env) {
  if (typeof env.AUTH_SECRET !== 'string' || encoder.encode(env.AUTH_SECRET).length < 32) throw new HttpError(503, 'Sign-in is not configured. Set AUTH_SECRET to a random secret of at least 32 bytes.');
}

function key(env) {
  configured(env);
  return crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueToken(env, subject, audience, claims = {}) {
  const issued = now();
  const data = `${json({ alg: 'HS256', typ: 'JWT' })}.${json({ ...claims, sub: subject, iss: origin(env), aud: audience, iat: issued, exp: issued + TOKEN_AGE[audience], jti: randomToken() })}`;
  return `${data}.${encode(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(data))))}`;
}

export async function verifyToken(env, token, audience) {
  const signingKey = await key(env), issuer = origin(env);
  if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const [header, payload, signature] = token.split('.');
    const metadata = JSON.parse(new TextDecoder().decode(decode(header)));
    if (metadata.alg !== 'HS256' || metadata.typ !== 'JWT' || metadata.crit) return null;
    if (!await crypto.subtle.verify('HMAC', signingKey, decode(signature), encoder.encode(`${header}.${payload}`))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    if (claims.iss !== issuer || claims.aud !== audience || typeof claims.sub !== 'string' || !discordID.test(claims.sub)
      || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || claims.iat > now() || claims.exp <= now()
      || claims.exp <= claims.iat || claims.exp - claims.iat > TOKEN_AGE[audience]) return null;
    return claims;
  } catch { return null; }
}

export async function signedInMember(request, env) {
  const claims = await verifyToken(env, cookie(request, 'thelab_member'), 'member');
  if (!claims || typeof claims.member_id !== 'string' || !Number.isInteger(claims.auth_version)) return null;
  return env.DB.prepare('SELECT * FROM members WHERE member_id = ? AND discord_user_id = ? AND auth_version = ?')
    .bind(claims.member_id, claims.sub, claims.auth_version).first();
}

export function memberToken(env, member) {
  return issueToken(env, member.discord_user_id, 'member', { member_id: member.member_id, auth_version: member.auth_version });
}

// Only known GET destinations can survive the OAuth round-trip.
export function loginDestination(value, purpose) {
  if (purpose === 'admin') return /^\/admin\/?(?:\?page=[1-9]\d{0,7})?$/.test(value) || /^\/admin\/members\/[1-9][0-9]{16,19}$/.test(value) ? value : '/admin';
  return /^\/payment\/success\?session_id=cs_[A-Za-z0-9_]+$/.test(value) ? value : '/payment/resume';
}

export async function startLogin(request, env, purpose = 'signup', selection = {}) {
  configured(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) throw new HttpError(503, 'Discord sign-in is not configured yet. Please contact leadership.');
  const url = new URL(request.url), state = randomToken(), browser = randomToken();
  const destination = loginDestination(url.pathname + url.search, purpose);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires <= ?').bind(now()),
    env.DB.prepare('INSERT INTO oauth_states (state_hash, browser_hash, bill_annually, discount_type, expires, purpose, return_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await hash(state), await hash(browser), selection.annual ? 1 : 0, selection.discount || '', now() + 600, purpose, destination),
  ]);
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify email', redirect_uri: `${origin(env)}/login/discord/callback`, state }).toString();
  const response = redirect(target.href);
  response.headers.set('Set-Cookie', cookieHeader(env, 'thelab_oauth', browser, 600));
  return response;
}
