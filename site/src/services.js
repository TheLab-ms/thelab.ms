// Shared services and policy. This module also runs in Node bootstrap tools.

// ────────────────────────────────────────────────────────────────────────
// HTTP responses, cookies, and bounded input
// ────────────────────────────────────────────────────────────────────────

export const now = () => Math.floor(Date.now() / 1000);
export const opaque = /^[a-f0-9]{64}$/;
export const discordID = /^[1-9][0-9]{16,19}$/;
const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(status, message, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}

export async function hash(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

export function origin(env) {
  const url = new URL(env.SITE_URL);
  if (url.origin !== env.SITE_URL || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new HttpError(503, 'Membership services are temporarily unavailable. Please contact leadership.');
  }
  return url.origin;
}

export function cookie(request, name) {
  return (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function cookieHeader(env, name, value, age) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
}

export function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

export function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function errorPage(error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof HttpError ? error.message : 'Membership signup is temporarily unavailable. Please try again.';
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Membership signup | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Source+Code+Pro:wght@400;500;600;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"></head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1 class="section-title">Let’s try that again.</h1><div class="section-line"></div><p>${escapeHTML(message)}</p><div class="membership-actions"><a class="btn btn-primary" href="/#membership">Back to signup</a><a class="btn btn-outline" href="https://discord.thelab.ms">Join our Discord</a></div><p class="card-desc">Need a hand? <a href="mailto:leadership@thelab.ms">Contact leadership</a>.</p></section></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function boundedText(message, limit = 1024 * 1024) {
  return new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(message, limit));
}

export async function boundedBytes(message, limit = 1024 * 1024) {
  if (Number(message.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Request too large.');
  const reader = message.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────────
// Token encoding
// ────────────────────────────────────────────────────────────────────────

export const encodeBase64URL = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const decodeBase64URL = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const encodeJSON = value => encodeBase64URL(encoder.encode(JSON.stringify(value)));

// ────────────────────────────────────────────────────────────────────────
// Structured, redacted diagnostics
// ────────────────────────────────────────────────────────────────────────

// Log only explicit context, never request headers, query strings, or bodies.
function redact(value, env) {
  let text = String(value);
  for (const [key, secret] of Object.entries(env)) {
    if (/secret|token|password|key/i.test(key) && typeof secret === 'string' && secret) {
      text = text.replaceAll(secret, '[redacted]');
    }
  }
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, url => url.split(/[?#]/)[0])
    .replace(/\b(Bearer|Bot)\s+[^\s,;"']+/gi, '$1 [redacted]')
    .replace(/\b(code|state|access_token|refresh_token|client_secret|csrf|thelab_\w+)\s*[=:]\s*[^\s&,;"']+/gi, '$1=[redacted]')
    .slice(0, 4000);
}

function details(error, env, depth = 0) {
  if (!(error instanceof Error)) return { name: 'NonErrorThrown' };
  return {
    name: redact(error.name, env),
    message: redact(error.message, env),
    stack: typeof error.stack === 'string' ? redact(error.stack, env) : undefined,
    ...(depth < 3 && error.cause ? { cause: details(error.cause, env, depth + 1) } : {}),
  };
}

export function requestContext(request) {
  return { request_id: crypto.randomUUID(), method: request.method, path: new URL(request.url).pathname };
}

export function logError(event, error, context = {}, env = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const errorID = error?.errorId || crypto.randomUUID();
  if (error instanceof Error) error.errorId = errorID;
  const entry = { event, ...context, error_id: errorID, status, retry_after: error?.retryAfter || 0, error: details(error, env) };
  // JSON gives both Wrangler tail and Workers Logs searchable, consistent fields.
  console[status >= 500 ? 'error' : 'warn'](JSON.stringify(entry));
  return errorID;
}

// ────────────────────────────────────────────────────────────────────────
// Billing and door-access policy
// ────────────────────────────────────────────────────────────────────────

export const discounts = ['', 'military', 'retired', 'firstResponder', 'student', 'family'];

export const grantsMembership = status => ['active', 'trialing'].includes(status);
export const isOngoingSubscription = status => !['canceled', 'incomplete_expired'].includes(status);

export function selectCurrentSubscription(subscriptions) {
  const priority = sub => grantsMembership(sub.status) ? 2 : isOngoingSubscription(sub.status) ? 1 : 0;
  return subscriptions.toSorted((a, b) => priority(b) - priority(a) || b.created - a.created)[0];
}

// Shared by edge goal selection and the admin's saved fob status. The outer
// query must use the members table so linked waivers resolve to that member.
export const waiverSignedSQL = `(members.legacy_waiver_signed = 1
  OR EXISTS (SELECT 1 FROM waivers WHERE waivers.member_id = members.member_id))`;

export const memberAccessSQL = `(members.non_billable = 1
  OR ((members.legacy_billing = 1 OR members.stripe_subscription_state IN ('active', 'trialing'))
    AND ${waiverSignedSQL}))`;

export const fobEnabledSQL = `members.fob_id IS NOT NULL AND ${memberAccessSQL}`;

// ────────────────────────────────────────────────────────────────────────
// Member identity and metadata validation
// ────────────────────────────────────────────────────────────────────────

export const memberName = member => member.name_override?.trim() || member.billing_name?.trim() || member.discord_username || member.waiver_name || member.email || 'Member';
export const memberPath = member => `/admin/members/${member.discord_user_id || member.member_id}`;

export function validateMetadata(input) {
  const invalid = message => { throw new HttpError(400, message); };
  const text = (key, max, required = false) => {
    const value = input[key];
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`Invalid ${key.replaceAll('_', ' ')} (maximum ${max} characters).`);
    return value.trim();
  };
  if (!input || typeof input !== 'object') invalid('Invalid member metadata.');
  const value = {
    discord_user_id: text('discord_user_id', 20) || null,
    stripe_customer_id: text('stripe_customer_id', 255) || null,
    stripe_subscription_id: text('stripe_subscription_id', 255) || null,
    name_override: text('name_override', 160),
    notes: text('notes', 5000),
  };
  for (const key of ['non_billable', 'legacy_billing']) {
    if (Object.hasOwn(input, key) && input[key] !== 'on') invalid(`Invalid ${key.replaceAll('_', ' ')} selection.`);
    value[key] = input[key] === 'on' ? 1 : 0;
  }
  if (Object.hasOwn(input, 'fob_id')) {
    const fob = text('fob_id', 10);
    if (fob && (!/^[1-9]\d{0,9}$/.test(fob) || Number(fob) > 4294967295)) invalid('Enter a fob ID from 1 through 4294967295, or leave blank.');
    value.fob_id = fob ? Number(fob) : null;
  }
  if (value.discord_user_id && !discordID.test(value.discord_user_id)) invalid('Enter a valid Discord ID.');
  if (value.stripe_customer_id && !/^cus_[A-Za-z0-9]+$/.test(value.stripe_customer_id)) invalid('Enter a valid Stripe customer ID.');
  if (value.stripe_subscription_id && (!value.stripe_customer_id || !/^sub_[A-Za-z0-9]+$/.test(value.stripe_subscription_id))) invalid('A valid Stripe subscription ID requires a Stripe customer ID.');
  if (!['monthly', 'yearly'].includes(input.billing)) invalid('Choose monthly or yearly billing.');
  if (!discounts.includes(input.discount_type)) invalid('Choose standard rate or a valid discount category.');
  if (!/^(0|[1-9]\d{0,14})$/.test(input.metadata_version || '')) invalid('Invalid member version. Reload the member before saving.');
  return { ...value, bill_annually: input.billing === 'yearly' ? 1 : 0, discount_type: input.discount_type,
    metadata_version: Number(input.metadata_version) };
}

// ────────────────────────────────────────────────────────────────────────
// Member search parameters
// ────────────────────────────────────────────────────────────────────────

export const MAX_SEARCH_LENGTH = 254;
export const memberFilters = [
  { name: 'waiver', label: 'Waiver status', defaultValue: 'signed', choices: [['all', 'Any waiver status'], ['signed', 'Waiver signed'], ['unsigned', 'Waiver not signed']] },
  { name: 'discord', label: 'Discord status', defaultValue: 'linked', choices: [['all', 'Any Discord status'], ['linked', 'Discord linked'], ['unlinked', 'Discord not linked']] },
  { name: 'payment', label: 'Payment status', defaultValue: 'all', choices: [['all', 'Any payment status'], ['inactive', 'Inactive'], ['non_billable', 'Non-billable'], ['legacy_billing', 'Legacy billing'], ['stripe_active', 'Stripe active']] },
];
export const defaultMemberFilters = Object.fromEntries(memberFilters.map(({ name, defaultValue }) => [name, defaultValue]));

export function memberListParams(params) {
  const raw = params.get('page') || '1';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  const query = (params.get('q') || '').trim();
  if (params.getAll('q').length > 1 || query.length > MAX_SEARCH_LENGTH) throw new HttpError(400, `Enter a single search of at most ${MAX_SEARCH_LENGTH} characters.`);
  const filters = Object.fromEntries(memberFilters.map(({ name, defaultValue, choices }) => {
    const value = params.get(name) ?? defaultValue;
    if (params.getAll(name).length > 1 || !choices.some(([key]) => key === value)) throw new HttpError(400, `Invalid ${name} filter.`);
    return [name, value];
  }));
  return { current: Number(raw), query, filters };
}

export function memberListURL(current, query, filters = defaultMemberFilters) {
  const params = new URLSearchParams({ page: String(current) });
  if (query) params.set('q', query);
  for (const { name, defaultValue } of memberFilters) {
    if (filters[name] !== defaultValue) params.set(name, filters[name]);
  }
  return `/admin?${params}`;
}

// ────────────────────────────────────────────────────────────────────────
// Member history queries
// ────────────────────────────────────────────────────────────────────────

export const eventTypes = {
  ConwayEvent: 'Conway event',
  FobChanged: 'Fob assignment changed',
  NonBillableChanged: 'Non-billable changed',
  LegacyBillingChanged: 'Legacy billing changed',
  FobSwipe: 'Fob swipe',
  MemberRegistered: 'Member registered',
  WaiverSigned: 'Waiver signed',
  DiscordAccountChanged: 'Discord account changed',
  DiscordUsernameChanged: 'Discord username changed',
  DiscordEmailChanged: 'Discord email changed',
  BillingNameChanged: 'Billing name changed',
  BillingEmailChanged: 'Billing email changed',
  NameOverrideChanged: 'Name override changed',
  NotesUpdated: 'Notes updated',
  BillingCycleChanged: 'Billing cycle changed',
  DiscountTypeModified: 'Discount changed',
  StripeCustomerChanged: 'Stripe customer changed',
  StripeSubscriptionChanged: 'Stripe subscription changed',
  SubscriptionStatusChanged: 'Subscription status changed',
};

export function eventListParams(params) {
  const raw = params.get('page') || '1';
  const type = params.get('event_type') || '';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  if (params.getAll('event_type').length > 1 || (type && !Object.hasOwn(eventTypes, type))) throw new HttpError(400, 'Invalid event type.');
  if ([...params.keys()].some(key => !['page', 'event_type'].includes(key))) throw new HttpError(400, 'Invalid history parameters.');
  return { current: Number(raw), type };
}

export function eventListURL(path, current, type = '') {
  const params = new URLSearchParams({ page: String(current) });
  if (type) params.set('event_type', type);
  return `${path}?${params}`;
}

// The editor needs only a bounded preview, without pagination totals or member names.
export async function recentMemberEvents(env, memberID) {
  const { results } = await env.DB.prepare(`SELECT * FROM member_events WHERE member_id = ?
    ORDER BY created DESC, id DESC LIMIT 10`).bind(memberID).all();
  return results;
}

export async function queryEvents(env, { memberID, type = '', current = 1, limit = 25 } = {}) {
  const clauses = [], values = [];
  if (memberID) { clauses.push('e.member_id = ?'); values.push(memberID); }
  if (type) { clauses.push('e.event_type = ?'); values.push(type); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM member_events e${where}`).bind(...values),
    env.DB.prepare(`SELECT e.*, m.discord_user_id, m.discord_username, m.billing_name, m.name_override, m.email, m.waiver_name
      FROM member_events e LEFT JOIN members m ON m.member_id = e.member_id${where}
      ORDER BY e.created DESC, e.id DESC LIMIT ? OFFSET ?`).bind(...values, limit, (current - 1) * limit),
  ]);
  const total = count.results[0].total;
  return { events: rows.results, total, current, pages: Math.max(1, Math.ceil(total / limit)), type };
}

// ────────────────────────────────────────────────────────────────────────
// Member/admin sessions and Discord OAuth state
// ────────────────────────────────────────────────────────────────────────

export const TOKEN_AGE = { member: 86400, admin: 8 * 3600, oauth: 600 };

function configured(env) {
  if (typeof env.AUTH_SECRET !== 'string' || encoder.encode(env.AUTH_SECRET).length < 32) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
}

function key(env) {
  configured(env);
  return crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function issueToken(env, subject, audience, claims = {}) {
  const issued = now();
  const data = `${encodeJSON({ alg: 'HS256', typ: 'JWT' })}.${encodeJSON({ ...claims, sub: subject, iss: origin(env), aud: audience, iat: issued, exp: issued + TOKEN_AGE[audience], jti: randomToken() })}`;
  return `${data}.${encodeBase64URL(new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(data))))}`;
}

export async function verifyToken(env, token, audience) {
  const signingKey = await key(env), issuer = origin(env);
  if (!Object.hasOwn(TOKEN_AGE, audience) || typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const [header, payload, signature] = token.split('.');
    const metadata = JSON.parse(new TextDecoder().decode(decodeBase64URL(header)));
    if (metadata.alg !== 'HS256' || metadata.typ !== 'JWT' || metadata.crit) return null;
    if (!await crypto.subtle.verify('HMAC', signingKey, decodeBase64URL(signature), encoder.encode(`${header}.${payload}`))) return null;
    const claims = JSON.parse(new TextDecoder().decode(decodeBase64URL(payload)));
    if (claims.iss !== issuer || claims.aud !== audience || typeof claims.sub !== 'string' || !(audience === 'oauth' ? opaque : discordID).test(claims.sub)
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

export function finishLogin(env, destination, audience, token) {
  const response = redirect(destination);
  response.headers.append('Set-Cookie', cookieHeader(env, `thelab_${audience}`, token, TOKEN_AGE[audience]));
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_oauth', '', 0));
  return response;
}

// Only known GET destinations can survive the OAuth round-trip.
export function loginDestination(value, purpose) {
  if (purpose === 'admin') {
    if (value === '/admin/members/new') return value;
    if (/^\/admin\/members\/(?:[1-9][0-9]{16,19}|[a-f0-9]{32})$/.test(value)) return value;
    if (/^\/admin(?:\/members\/(?:[1-9][0-9]{16,19}|[a-f0-9]{32}))?\/events(?:\?[^#]*)?$/.test(value)) {
      try {
        eventListParams(new URLSearchParams(value.split('?')[1]));
        return value;
      } catch { /* Invalid history parameters fall back to members. */ }
    }
    if (/^\/admin\/?(?:\?[^#]*)?$/.test(value)) {
      const params = new URLSearchParams(value.split('?')[1]);
      try {
        memberListParams(params);
        if ([...params.keys()].every(key => key === 'page' || key === 'q' || memberFilters.some(filter => filter.name === key))) return value;
      } catch { /* Invalid list parameters fall back to the first page. */ }
    }
    return '/admin';
  }
  if (purpose === 'member' && value === '/waiver?signup=1') return value;
  if (purpose === 'member' && /^\/keyfob\/bind\?token=[a-f0-9]{64}$/.test(value)) return value;
  return /^\/payment\/success\?session_id=cs_[A-Za-z0-9_]+$/.test(value) ? value : '/payment/resume';
}

export async function verifyOAuthState(env, state, browser) {
  if (typeof browser !== 'string' || !opaque.test(browser)) return null;
  const claims = await verifyToken(env, state, 'oauth');
  // The subject binds this handshake to a nonce held only in the browser cookie.
  if (!claims || claims.sub !== await hash(browser) || !['signup', 'admin', 'member'].includes(claims.purpose)
    || typeof claims.return_to !== 'string' || claims.return_to !== loginDestination(claims.return_to, claims.purpose)) return null;
  return claims;
}

export async function startLogin(request, env, purpose = 'signup') {
  configured(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
  const url = new URL(request.url), browser = randomToken();
  const destination = loginDestination(url.pathname + url.search, purpose);
  const state = await issueToken(env, await hash(browser), 'oauth', {
    purpose, return_to: destination,
  });
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify email', prompt: 'none', redirect_uri: `${origin(env)}/login/discord/callback`, state }).toString();
  const response = redirect(target.href);
  response.headers.set('Set-Cookie', cookieHeader(env, 'thelab_oauth', browser, TOKEN_AGE.oauth));
  return response;
}

// ────────────────────────────────────────────────────────────────────────
// Worker-to-edge signing and public keys
// ────────────────────────────────────────────────────────────────────────

const signingKeys = new WeakMap();

async function publicJWK(key) {
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(key.x || '')) throw new Error('Invalid public key');
  const publicKey = { crv: 'Ed25519', kty: 'OKP', x: key.x };
  // RFC 7638 thumbprint: stable across deployments and independent of key labels.
  const kid = encodeBase64URL(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicKey)))));
  await crypto.subtle.importKey('jwk', publicKey, 'Ed25519', false, ['verify']);
  return { ...publicKey, kid, alg: 'EdDSA', use: 'sig' };
}

async function signingKey(env) {
  const cached = signingKeys.get(env);
  if (cached?.secret === env.EDGE_JWT_PRIVATE_KEY) return cached.value;
  try {
    const bytes = Uint8Array.from(atob(env.EDGE_JWT_PRIVATE_KEY), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', true, ['sign']);
    const publicKey = await publicJWK(await crypto.subtle.exportKey('jwk', key));
    const value = { key, publicKey };
    signingKeys.set(env, { secret: env.EDGE_JWT_PRIVATE_KEY, value });
    return value;
  } catch {
    throw new HttpError(503, 'Edge signing key is not configured.');
  }
}

export async function edgeToken(env) {
  const { key, publicKey } = await signingKey(env);
  const issued = now();
  const data = `${encodeJSON({ alg: 'EdDSA', typ: 'JWT', kid: publicKey.kid })}.${encodeJSON({
    iss: origin(env), aud: env.EDGE_URL, sub: 'edge-sync', scope: 'edge:api', iat: issued, exp: issued + 60,
  })}`;
  return `${data}.${encodeBase64URL(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(data))))}`;
}

export async function edgeJWKS(_request, env) {
  const { publicKey } = await signingKey(env);
  let additional;
  try {
    additional = JSON.parse(env.EDGE_JWT_PUBLIC_KEYS || '[]');
    if (!Array.isArray(additional) || additional.length > 7) throw new Error('Invalid key set');
    additional = await Promise.all(additional.map(publicJWK));
  } catch {
    throw new HttpError(503, 'Edge public keys are not configured correctly.');
  }
  const keys = [...new Map([publicKey, ...additional].map(key => [key.kid, key])).values()];
  return Response.json({ keys }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

// ────────────────────────────────────────────────────────────────────────
// Stripe, Discord, and verification provider clients
// ────────────────────────────────────────────────────────────────────────


export async function provider(url, init, service, env = {}) {
  const endpoint = new URL(url);
  const context = { service, method: init?.method || 'GET', host: endpoint.hostname, path: endpoint.pathname };
  const started = Date.now();
  const authorization = new Headers(init?.headers).get('Authorization');
  const secrets = { ...env, PROVIDER_TOKEN: authorization?.replace(/^(Bearer|Bot) /i, '') };
  if (typeof init?.body === 'string') {
    for (const key of ['code', 'client_secret', 'access_token', 'refresh_token']) {
      secrets[`PROVIDER_SECRET_${key}`] = new URLSearchParams(init.body).get(key);
    }
  }
  const fail = (error, failure, cause) => {
    if (cause) error.cause = cause;
    error.providerStatus = response?.status;
    logError('provider.failed', error, { ...context, failure, provider_status: response?.status,
      duration_ms: Date.now() - started }, secrets);
    // The transport cause is logged here with provider-specific redaction.
    // Callers retain the error ID without re-logging potentially secret data.
    delete error.cause;
    return error;
  };
  let response;
  try {
    // workerd supports manual/follow, but rejects redirect: 'error'. Manual also
    // prevents credentials from being forwarded to an unexpected redirect target.
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch (cause) {
    throw fail(new HttpError(502, `${service} is temporarily unavailable. Please try again.`), 'transport', cause);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw fail(new HttpError(502, `${service} is temporarily unavailable. Please try again.`), 'redirect');
  }
  let data;
  try {
    const text = await boundedText(response, 2 * 1024 * 1024);
    data = text ? JSON.parse(text) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider payload');
  } catch {
    // JSON parser errors may include provider body fragments; never log them.
    throw fail(new HttpError(502, `${service} is temporarily unavailable. Please try again.`), 'invalid_response');
  }
  if (!response.ok) {
    const delay = Number(response.headers.get('Retry-After') || data.retry_after || 0);
    // Never log provider bodies, OAuth codes, or tokens.
    throw fail(new HttpError(502, `${service} is temporarily unavailable. Please try again.`, Number.isFinite(delay) ? Math.min(43200, Math.max(0, Math.ceil(delay))) : 0), 'http');
  }
  return data;
}

export function stripe(env, path, form, key) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Billing is temporarily unavailable. Please contact leadership.');
  return provider(`https://api.stripe.com/v1${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  }, 'Stripe', env);
}

export async function stripeList(env, path, params = {}) {
  const all = [];
  const query = new URLSearchParams({ ...params, limit: '100' });
  for (let page = 0; page < 100; page++) {
    const result = await stripe(env, `${path}?${query}`);
    if (!Array.isArray(result.data)) throw new HttpError(502, 'Billing is temporarily unavailable. Please try again.');
    all.push(...result.data);
    if (!result.has_more) return all;
    if (!result.data.length) break;
    query.set('starting_after', result.data.at(-1).id);
  }
  throw new HttpError(502, 'Billing is temporarily unavailable. Please try again.');
}

export function discord(env, path, method = 'GET') {
  if (!env.DISCORD_BOT_TOKEN || !discordID.test(env.DISCORD_GUILD_ID) || !discordID.test(env.DISCORD_ROLE_ID)) {
    throw new HttpError(503, 'Discord membership services are temporarily unavailable. Please contact leadership.');
  }
  return provider(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }, 'Discord', env);
}

export async function discordIdentity(env, code) {
  const token = await provider('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code, redirect_uri: `${origin(env)}/login/discord/callback` }).toString(),
  }, 'Discord', env);
  if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+-]{1,2048}$/.test(token.access_token) || token.token_type?.toLowerCase() !== 'bearer') throw new HttpError(502, 'Discord sign-in failed. Please try again.');
  const user = await provider('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } }, 'Discord', env);
  if (!discordID.test(user.id || '') || typeof user.id !== 'string' || typeof user.username !== 'string' || !user.username.trim() || user.username.length > 80 || user.bot === true) throw new HttpError(502, 'Discord sign-in failed. Please try again.');
  if (user.verified !== true || typeof user.email !== 'string' || user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw new HttpError(403, 'Please verify your email in Discord before signing up.');
  return { id: user.id, username: user.username, email: user.email };
}

export async function verifyStripe(request, env, text) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhooks are not configured.');
  const parts = (request.headers.get('Stripe-Signature') || '').split(',').map(s => s.trim());
  const timestamps = parts.filter(s => s.startsWith('t='));
  const timestamp = timestamps[0]?.slice(2) || '';
  if (timestamps.length !== 1 || !/^\d+$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 300) throw new HttpError(400, 'Invalid Stripe signature.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const part of parts) {
    if (!/^v1=[a-f0-9]{64}$/i.test(part)) continue;
    const signature = Uint8Array.from(part.slice(3).match(/../g), s => parseInt(s, 16));
    if (await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${timestamp}.${text}`))) return;
  }
  throw new HttpError(400, 'Invalid Stripe signature.');
}
