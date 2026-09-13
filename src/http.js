import { logError } from './logging.js';

export const now = () => Math.floor(Date.now() / 1000);
export const opaque = /^[a-f0-9]{64}$/;
export const discordID = /^[1-9][0-9]{16,19}$/;
export const discounts = ['', 'military', 'retired', 'firstResponder', 'student', 'family'];
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
    throw new HttpError(503, 'The membership site URL is not configured correctly.');
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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Membership signup | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Source+Code+Pro:wght@400;500;600;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"></head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1 class="section-title">Let’s try that again.</h1><div class="section-line"></div><p>${escapeHTML(message)}</p><div class="membership-actions"><a class="btn btn-primary" href="/#membership">Back to signup</a><a class="btn btn-outline" href="https://discord.thelab.ms">Join our Discord</a></div><p class="card-desc">Need a hand? <a href="mailto:leadership@thelab.ms">Contact leadership</a>.</p></section></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
  });
}

export async function boundedText(message, limit = 1024 * 1024) {
  if (Number(message.headers.get('Content-Length')) > limit) throw new HttpError(413, 'Request too large.');
  const reader = message.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

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
    throw fail(new HttpError(502, `${service} returned an unexpected redirect. Please try again.`), 'redirect');
  }
  let data;
  try {
    const text = await boundedText(response, 2 * 1024 * 1024);
    data = text ? JSON.parse(text) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider payload');
  } catch {
    // JSON parser errors may include provider body fragments; never log them.
    throw fail(new HttpError(502, `${service} returned an invalid response. Please try again.`), 'invalid_response');
  }
  if (!response.ok) {
    const delay = Number(response.headers.get('Retry-After') || data.retry_after || 0);
    // Never log provider bodies, OAuth codes, or tokens.
    throw fail(new HttpError(502, `${service} request failed (HTTP ${response.status}). Please try again.`, Number.isFinite(delay) ? Math.min(43200, Math.max(0, Math.ceil(delay))) : 0), 'http');
  }
  return data;
}

export function stripe(env, path, form, key) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Stripe is not configured.');
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
    if (!Array.isArray(result.data)) throw new HttpError(502, 'Stripe returned an invalid list.');
    all.push(...result.data);
    if (!result.has_more) return all;
    if (!result.data.length) break;
    query.set('starting_after', result.data.at(-1).id);
  }
  throw new HttpError(502, 'Stripe pagination could not be completed.');
}

export function discord(env, path, method = 'GET') {
  if (!env.DISCORD_BOT_TOKEN || !discordID.test(env.DISCORD_GUILD_ID) || !discordID.test(env.DISCORD_ROLE_ID)) {
    throw new HttpError(503, 'Discord membership is not configured.');
  }
  return provider(`https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }, 'Discord', env);
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
