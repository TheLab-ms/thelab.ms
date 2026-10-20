// Shared HTTP helpers, sessions, provider clients, and access policy.

export const now = () => Math.floor(Date.now() / 1000);
export const discordID = /^[1-9][0-9]{16,19}$/;
const encoder = new TextEncoder();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const base64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64url = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const encodeJSON = value => base64url(encoder.encode(JSON.stringify(value)));

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const e = escapeHTML;

export const origin = env => new URL(env.SITE_URL).origin;

export function logError(event, error, context = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  console[status >= 500 ? 'error' : 'warn'](JSON.stringify({
    event, ...context, status, provider_status: error?.providerStatus, message: String(error?.message ?? error),
    ...(error?.cause ? { cause: String(error.cause.message ?? error.cause) } : {}),
    ...(status >= 500 && error?.stack ? { stack: error.stack } : {}),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Responses and cookies
// ────────────────────────────────────────────────────────────────────────

const htmlHeaders = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  // no-referrer can turn the Origin of a native form POST into "null".
  'Referrer-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export function page(title, body, { status = 200, admin = false } = {}) {
  const content = admin
    ? `<header class="admin-header"><a class="membership-brand" href="/">TheLab</a><nav aria-label="Admin navigation"><a href="/admin">Members</a><a href="/admin/events">Events</a></nav><div class="admin-toolbar-actions"><form method="post" action="/logout"><button class="btn btn-outline" type="submit">Log Out</button></form></div></header><h1>${e(title)}</h1>${body}`
    : `<a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1>${e(title)}</h1>${body}</section>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css">${admin ? '<script src="/admin.js" defer></script>' : ''}</head><body class="membership-page${admin ? ' admin-page' : ''}"><main class="container membership-main${admin ? ' admin-main' : ''}">${content}</main></body></html>`, { status, headers: htmlHeaders });
}

export const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export const redirect = location => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });

export const loginRedirect = next => redirect(`/login?next=${encodeURIComponent(next)}`);

export function getCookie(request, name) {
  return (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function setCookie(env, name, value, maxAge) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
}

export async function readForm(request) {
  try { return Object.fromEntries(await request.formData()); }
  catch { throw new HttpError(400, 'Submit the form again.'); }
}

// ────────────────────────────────────────────────────────────────────────
// Sessions: one signed cookie keyed by Discord account
// ────────────────────────────────────────────────────────────────────────

const SESSION_AGE = 86400;

function authKey(env) {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
  return crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sessionCookie(env, discordUserID, admin) {
  const payload = encodeJSON({ sub: discordUserID, admin, exp: now() + SESSION_AGE });
  const signature = base64url(await crypto.subtle.sign('HMAC', await authKey(env), encoder.encode(payload)));
  return setCookie(env, 'thelab_session', `${payload}.${signature}`, SESSION_AGE);
}

export async function readSession(request, env) {
  const parts = (getCookie(request, 'thelab_session') || '').split('.');
  if (parts.length !== 2) return null;
  const key = await authKey(env);
  try {
    if (!await crypto.subtle.verify('HMAC', key, fromBase64url(parts[1]), encoder.encode(parts[0]))) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    return session.exp > now() && discordID.test(session.sub) ? session : null;
  } catch { return null; }
}

// Callers may select access policy alongside identity in one query.
export async function currentMember(request, env, columns = '*') {
  const session = await readSession(request, env);
  if (!session) return null;
  return env.DB.prepare(`SELECT ${columns} FROM members WHERE discord_user_id = ?`).bind(session.sub).first();
}

// ────────────────────────────────────────────────────────────────────────
// Stripe and Discord clients
// ────────────────────────────────────────────────────────────────────────

export async function provider(service, url, init = {}) {
  const unavailable = () => new HttpError(502, `${service} is temporarily unavailable. Please try again.`);
  let response;
  try {
    // Manual redirects keep credentials from being forwarded elsewhere.
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch (cause) {
    throw Object.assign(unavailable(), { cause });
  }
  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch { /* Reported below. */ }
  if (!response.ok || !data || typeof data !== 'object') throw Object.assign(unavailable(), { providerStatus: response.status, providerCode: data?.code });
  return data;
}

export function stripe(env, path, form, idempotencyKey) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Billing is temporarily unavailable. Please contact leadership.');
  return provider('Stripe', `https://api.stripe.com/v1${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
}

export async function stripeList(env, path, params = {}) {
  const all = [];
  const query = new URLSearchParams({ ...params, limit: '100' });
  for (;;) {
    const result = await stripe(env, `${path}?${query}`);
    all.push(...result.data);
    if (!result.has_more || !result.data.length) return all;
    query.set('starting_after', result.data.at(-1).id);
  }
}

export function discord(env, path, method = 'GET') {
  if (!env.DISCORD_BOT_TOKEN) throw new HttpError(503, 'Discord is temporarily unavailable. Please contact leadership.');
  return provider('Discord', `https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
}

// Returns a validated, non-bot guild member's username.
export async function guildUsername(env, id) {
  const account = await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${id}`);
  if (account.user?.id !== id || !account.user.username || account.user.bot) throw new HttpError(400, 'Choose a valid Discord member account.');
  return account.user.username;
}

export async function verifyStripe(request, env, text) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhooks are not configured.');
  const parts = (request.headers.get('Stripe-Signature') || '').split(',').map(s => s.trim());
  const timestamp = parts.find(s => s.startsWith('t='))?.slice(2) || '';
  if (!/^\d+$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 300) throw new HttpError(400, 'Invalid Stripe signature.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const part of parts) {
    if (!/^v1=[a-f0-9]{64}$/i.test(part)) continue;
    const signature = Uint8Array.from(part.slice(3).match(/../g), s => parseInt(s, 16));
    if (await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${timestamp}.${text}`))) return;
  }
  throw new HttpError(400, 'Invalid Stripe signature.');
}

// ────────────────────────────────────────────────────────────────────────
// Membership and door-access policy
// ────────────────────────────────────────────────────────────────────────

export const grantsMembership = status => ['active', 'trialing'].includes(status);
export const isOngoingSubscription = status => !['canceled', 'incomplete_expired'].includes(status);

export function selectCurrentSubscription(subscriptions) {
  const priority = sub => grantsMembership(sub.status) ? 2 : isOngoingSubscription(sub.status) ? 1 : 0;
  return subscriptions.toSorted((a, b) => priority(b) - priority(a) || b.created - a.created)[0];
}

export const memberAccessSQL = `(members.non_billable = 1
  OR ((members.legacy_billing = 1 OR members.stripe_subscription_state IN ('active', 'trialing'))
    AND members.waiver_signed = 1))`;

export const fobEnabledSQL = `members.fob_id IS NOT NULL AND ${memberAccessSQL}`;

export const memberName = member => member.name_override?.trim() || member.billing_name?.trim() || member.discord_username || member.waiver_name || member.email || 'Member';
export const memberPath = member => `/admin/members/${member.member_id}`;
export const validEmail = email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
