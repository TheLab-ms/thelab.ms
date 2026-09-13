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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Membership signup | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Source+Code+Pro:wght@400;500;600;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"></head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1 class="section-title">Let’s try that again.</h1><div class="section-line"></div><p>${escapeHTML(message)}</p><div class="membership-actions"><a class="btn btn-primary" href="/#membership">Back to signup</a><a class="btn btn-outline" href="https://discord.thelab.ms">Join our Discord</a></div><p class="card-desc">Need a hand? <a href="mailto:leadership@thelab.ms">Contact leadership</a>.</p></section></main></body></html>`, {
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
