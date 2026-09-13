import { logError } from './logging.js';
import { boundedText, discordID, HttpError, now, origin } from './http.js';

const encoder = new TextEncoder();

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
