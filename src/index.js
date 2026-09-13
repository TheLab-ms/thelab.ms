import { boundedText, cookie, cookieHeader, discord, discordID, discounts, errorPage, hash, HttpError, json, now, opaque, origin, provider, randomToken, redirect, stripe, verifyStripe } from './http.js';
import { coordinated } from './membership.js';
export { Membership } from './membership.js';

const OAUTH_AGE = 600;
const SESSION_AGE = 86400;
const events = new Set([
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'invoice.paid', 'invoice.payment_failed',
]);

function configured(env) {
  origin(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || !env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Membership signup is not configured yet. Please contact leadership.');
}

async function signup(request, env) {
  configured(env);
  const url = new URL(request.url);
  const frequency = url.searchParams.get('billing') || 'monthly';
  const discount = url.searchParams.get('discount') || '';
  if (!['monthly', 'yearly'].includes(frequency) || !discounts.includes(discount) || url.searchParams.getAll('billing').length > 1 || url.searchParams.getAll('discount').length > 1) throw new HttpError(400, 'Invalid membership selection.');
  const state = randomToken(), browser = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM oauth_states WHERE expires <= ?').bind(now()),
    env.DB.prepare('DELETE FROM sessions WHERE expires <= ?').bind(now()),
    env.DB.prepare('INSERT INTO oauth_states (state_hash, browser_hash, bill_annually, discount_type, expires) VALUES (?, ?, ?, ?, ?)')
      .bind(await hash(state), await hash(browser), frequency === 'yearly' ? 1 : 0, discount, now() + OAUTH_AGE),
  ]);
  const target = new URL('https://discord.com/oauth2/authorize');
  target.search = new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, response_type: 'code', scope: 'identify email', redirect_uri: `${origin(env)}/login/discord/callback`, state }).toString();
  const response = redirect(target.href);
  response.headers.set('Set-Cookie', cookieHeader(env, 'thelab_oauth', browser, OAUTH_AGE));
  return response;
}

async function resume(request, env) {
  const token = cookie(request, 'thelab_session');
  const member = opaque.test(token || '') && await env.DB.prepare(`SELECT m.bill_annually, m.discount_type FROM sessions s
    JOIN members m ON m.discord_user_id = s.discord_user_id WHERE s.token_hash = ? AND s.expires > ?`)
    .bind(await hash(token), now()).first();
  if (!member) throw new HttpError(401, 'Please return to signup and select the same billing frequency and discount category to check your approval.');
  const params = new URLSearchParams({ billing: member.bill_annually ? 'yearly' : 'monthly', discount: member.discount_type });
  return redirect(`${origin(env)}/signup?${params}`);
}

async function callback(request, env) {
  configured(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state'), browser = cookie(request, 'thelab_oauth');
  if (!opaque.test(state || '') || !opaque.test(browser || '') || url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const pending = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? AND browser_hash = ? AND expires > ? RETURNING bill_annually, discount_type')
    .bind(await hash(state), await hash(browser), now()).first();
  if (!pending) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || !code || code.length > 2048 || /[^\x21-\x7e]/.test(code) || url.searchParams.getAll('code').length !== 1) throw new HttpError(400, 'Discord sign-in was not authorized. Please start again.');
  const token = await provider('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${origin(env)}/login/discord/callback` }).toString(),
  }, 'Discord');
  if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+-]{1,2048}$/.test(token.access_token) || token.token_type?.toLowerCase() !== 'bearer') throw new HttpError(502, 'Discord returned an invalid sign-in token.');
  const user = await provider('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } }, 'Discord');
  if (!discordID.test(user.id || '') || typeof user.id !== 'string' || typeof user.username !== 'string' || !user.username.trim() || user.username.length > 80 || user.bot === true) throw new HttpError(502, 'Discord returned an invalid user identity.');
  if (user.verified !== true || typeof user.email !== 'string' || user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw new HttpError(403, 'Please verify your email in Discord before signing up.');
  try {
    await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
  } catch (error) {
    if (error.message.includes('HTTP 404')) throw new HttpError(403, 'Please join TheLab’s Discord server using the link below, then return to signup.');
    throw error;
  }
  const result = await coordinated(env, user.id, '/checkout', { user: { id: user.id, username: user.username, email: user.email }, annual: Boolean(pending.bill_annually), discount: pending.discount_type });
  const session = randomToken();
  const old = cookie(request, 'thelab_session');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions (token_hash, discord_user_id, expires) VALUES (?, ?, ?)').bind(await hash(session), user.id, now() + SESSION_AGE),
    env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hash(old || '')),
  ]);
  const response = redirect(result.url);
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_session', session, SESSION_AGE));
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_oauth', '', 0));
  return response;
}

async function success(request, env) {
  const url = new URL(request.url), token = cookie(request, 'thelab_session');
  const sessionID = url.searchParams.get('session_id');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionID || '') || url.searchParams.getAll('session_id').length !== 1) throw new HttpError(400, 'Invalid checkout session.');
  if (!opaque.test(token || '')) throw new HttpError(401, 'Your sign-in has expired. Sign in again to manage your membership.');
  const member = await env.DB.prepare(`SELECT m.* FROM sessions s JOIN members m ON m.discord_user_id = s.discord_user_id WHERE s.token_hash = ? AND s.expires > ?`)
    .bind(await hash(token), now()).first();
  if (!member) throw new HttpError(401, 'Your sign-in has expired. Sign in again to manage your membership.');
  const session = await stripe(env, `/checkout/sessions/${encodeURIComponent(sessionID)}`);
  if (session.mode !== 'subscription' || session.customer !== member.stripe_customer_id || session.client_reference_id !== member.discord_user_id || session.metadata?.thelab_discord_id !== member.discord_user_id) throw new HttpError(403, 'This checkout does not belong to your membership.');
  if (session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)) throw new HttpError(409, 'Your payment is not complete yet. Please finish Stripe Checkout or contact leadership.');
  const subscriptionID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionID || '')) throw new HttpError(409, 'Stripe is still setting up your membership. Please try again shortly.');
  const subscription = await stripe(env, `/subscriptions/${subscriptionID}`);
  if (subscription.customer !== member.stripe_customer_id || subscription.metadata?.thelab_discord_id !== member.discord_user_id) throw new HttpError(403, 'This subscription does not belong to your membership.');
  if (!['active', 'trialing'].includes(subscription.status)) throw new HttpError(409, 'Your membership payment is still being processed. Please try again shortly.');
  await env.MEMBERSHIP_QUEUE.send({ customer_id: member.stripe_customer_id });
  return redirect(`${origin(env)}/welcome`);
}

async function webhook(request, env) {
  const text = await boundedText(request);
  await verifyStripe(request, env, text);
  let event;
  try { event = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid Stripe event.'); }
  if (!event || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || typeof event.type !== 'string' || !event.data?.object) throw new HttpError(400, 'Invalid Stripe event.');
  if (!events.has(event.type)) return new Response(null, { status: 204 });
  const object = event.data.object;
  const customer = typeof object.customer === 'string' ? object.customer : object.customer?.id;
  if (!/^cus_[A-Za-z0-9]+$/.test(customer || '')) throw new HttpError(400, 'Stripe event has no customer.');
  // No pre-enqueue deduplication: a failed send must be retried by Stripe.
  await env.MEMBERSHIP_QUEUE.send({ event_id: event.id, customer_id: customer });
  return new Response(null, { status: 204 });
}

export async function processMessage(body, env) {
  if (!body || !/^cus_[A-Za-z0-9]+$/.test(body.customer_id || '') || (body.event_id !== undefined && !/^evt_[A-Za-z0-9_]+$/.test(body.event_id))) throw new HttpError(400, 'Invalid queue message.');
  const member = await env.DB.prepare('SELECT discord_user_id FROM members WHERE stripe_customer_id = ?').bind(body.customer_id).first();
  // Other Stripe customers (e.g. donations or Conway) are outside this app.
  if (!member) return;
  await coordinated(env, member.discord_user_id, '/sync', { ...body, discord_user_id: member.discord_user_id });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const routes = new Map([
      ['/signup', ['GET', signup]],
      ['/login/discord/callback', ['GET', callback]],
      ['/payment/success', ['GET', success]],
      ['/payment/resume', ['GET', resume]],
      ['/webhooks/stripe', ['POST', webhook]],
    ]);
    const route = routes.get(path);
    if (!route) return env.ASSETS.fetch(request);
    if (request.method !== route[0]) return new Response('Method not allowed', { status: 405, headers: { Allow: route[0], 'Cache-Control': 'no-store' } });
    try {
      if (new URL(request.url).origin !== origin(env)) throw new HttpError(400, 'Please use the configured membership site address.');
      return await route[1](request, env);
    } catch (error) {
      console.error('Membership request failed', path, error instanceof HttpError ? error.message : 'Internal error');
      if (path === '/webhooks/stripe') return json({ error: 'Webhook could not be accepted.' }, error instanceof HttpError ? error.status : 500);
      const response = errorPage(error);
      if (path === '/login/discord/callback') {
        // Clearing an OAuth cookie must still work when SITE_URL itself is invalid.
        response.headers.append('Set-Cookie', `thelab_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.url.startsWith('https:') ? '; Secure' : ''}`);
      }
      return response;
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Membership queue delivery failed', message.id, error instanceof HttpError ? error.message : 'Internal error');
        message.retry({ delaySeconds: Math.min(43200, Math.max(error.retryAfter || 0, 30 * 2 ** Math.min(message.attempts - 1, 10))) });
      }
    }
  },
};
