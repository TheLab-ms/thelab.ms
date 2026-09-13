import { boundedText, cookie, cookieHeader, discord, discordID, discounts, errorPage, HttpError, json, origin, provider, redirect, stripe, verifyStripe } from './http.js';
import { loginDestination, memberToken, signedInMember, startLogin, TOKEN_AGE, verifyOAuthState } from './auth.js';
import { coordinated } from './membership.js';
import { adminConfigured, adminRequest, finishAdminLogin } from './admin.js';
import { logError, requestContext } from './logging.js';
import { printerAccess } from './printers.js';
export { Membership } from './membership.js';

const events = new Set([
  'customer.updated',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'invoice.paid', 'invoice.payment_failed',
]);

function configured(env, admin = false) {
  origin(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || (!admin && !env.STRIPE_SECRET_KEY)) throw new HttpError(503, 'Discord sign-in or membership signup is not configured yet. Please contact leadership.');
}

async function signup(request, env, admin = false) {
  configured(env, admin);
  if (admin) adminConfigured(env);
  const url = new URL(request.url);
  const frequency = url.searchParams.get('billing') || 'monthly';
  const discount = url.searchParams.get('discount') || '';
  if (!['monthly', 'yearly'].includes(frequency) || !discounts.includes(discount) || url.searchParams.getAll('billing').length > 1 || url.searchParams.getAll('discount').length > 1) throw new HttpError(400, 'Invalid membership selection.');
  return startLogin(request, env, admin ? 'admin' : 'signup', { annual: frequency === 'yearly', discount });
}

async function resume(request, env) {
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  const result = await coordinated(env, member.discord_user_id, '/checkout', {
    user: { id: member.discord_user_id, username: member.discord_username, email: member.discord_email },
    annual: Boolean(member.bill_annually), discount: member.discount_type,
  });
  return redirect(result.url);
}

async function callback(request, env) {
  configured(env, true);
  const url = new URL(request.url);
  const state = url.searchParams.get('state'), browser = cookie(request, 'thelab_oauth');
  if (url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const pending = await verifyOAuthState(env, state, browser);
  if (!pending) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || !code || code.length > 2048 || /[^\x21-\x7e]/.test(code) || url.searchParams.getAll('code').length !== 1) throw new HttpError(400, 'Discord sign-in was not authorized. Please start again.');
  const token = await provider('https://discord.com/api/v10/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: `${origin(env)}/login/discord/callback` }).toString(),
  }, 'Discord', env);
  if (typeof token.access_token !== 'string' || !/^[A-Za-z0-9._~+-]{1,2048}$/.test(token.access_token) || token.token_type?.toLowerCase() !== 'bearer') throw new HttpError(502, 'Discord returned an invalid sign-in token.');
  const user = await provider('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } }, 'Discord', env);
  if (!discordID.test(user.id || '') || typeof user.id !== 'string' || typeof user.username !== 'string' || !user.username.trim() || user.username.length > 80 || user.bot === true) throw new HttpError(502, 'Discord returned an invalid user identity.');
  if (user.verified !== true || typeof user.email !== 'string' || user.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) throw new HttpError(403, 'Please verify your email in Discord before signing up.');
  let guildMember;
  try {
    guildMember = await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
  } catch (error) {
    if (error.providerStatus === 404) throw new HttpError(403, 'Please join TheLab’s Discord server using the link below, then return to signup.');
    throw error;
  }
  if (pending.purpose === 'admin') return finishAdminLogin(env, user, guildMember, pending.return_to);
  if (pending.purpose === 'member') {
    const member = await env.DB.prepare(`UPDATE members SET discord_username = ?, discord_email = ?,
      metadata_version = metadata_version + 1 WHERE discord_user_id = ? RETURNING *`)
      .bind(user.username, user.email.toLowerCase(), user.id).first();
    if (!member) throw new HttpError(404, 'No membership found for this Discord account. Please choose a membership to sign up.');
    const response = redirect(`${origin(env)}${loginDestination(pending.return_to, 'member')}`);
    response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_member', await memberToken(env, member), TOKEN_AGE.member));
    response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_oauth', '', 0));
    return response;
  }
  configured(env);
  const result = await coordinated(env, user.id, '/checkout', { user: { id: user.id, username: user.username, email: user.email }, annual: Boolean(pending.bill_annually), discount: pending.discount_type });
  const member = await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(user.id).first();
  const response = redirect(result.url);
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_member', await memberToken(env, member), TOKEN_AGE.member));
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_oauth', '', 0));
  return response;
}

async function success(request, env) {
  const url = new URL(request.url);
  const sessionID = url.searchParams.get('session_id');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionID || '') || url.searchParams.getAll('session_id').length !== 1) throw new HttpError(400, 'Invalid checkout session.');
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
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
  const customer = event.type === 'customer.updated' ? object.id : typeof object.customer === 'string' ? object.customer : object.customer?.id;
  if (!/^cus_[A-Za-z0-9]+$/.test(customer || '')) throw new HttpError(400, 'Stripe event has no customer.');
  // Acknowledge only after enqueueing so Stripe retries failed sends.
  await env.MEMBERSHIP_QUEUE.send({ customer_id: customer });
  return new Response(null, { status: 204 });
}

export async function processMessage(body, env) {
  if (body?.member_id && /^[a-f0-9]{32}$/.test(body.member_id) && !body.customer_id) {
    await coordinated(env, null, '/sync', { member_id: body.member_id });
    return;
  }
  if (!body || !/^cus_[A-Za-z0-9]+$/.test(body.customer_id || '')) throw new HttpError(400, 'Invalid queue message.');
  const member = await env.DB.prepare('SELECT discord_user_id FROM members WHERE stripe_customer_id = ?').bind(body.customer_id).first();
  // Other Stripe customers (e.g. donations or Conway) are outside this app.
  if (!member) return;
  await coordinated(env, member.discord_user_id, '/sync', { customer_id: body.customer_id, discord_user_id: member.discord_user_id });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const context = requestContext(request);
    const routes = new Map([
      ['/signup', ['GET', signup]],
      ['/login/discord/callback', ['GET', callback]],
      ['/payment/success', ['GET', success]],
      ['/payment/resume', ['GET', resume]],
      ['/machines', ['GET', printerAccess]],
      ['/webhooks/stripe', ['POST', webhook]],
      ['/admin/login', ['GET', (request, env) => signup(request, env, true)]],
    ]);
    const route = routes.get(path);
    const isAdmin = path === '/admin' || path.startsWith('/admin/');
    try {
      if (!route && !isAdmin) {
        const response = await env.ASSETS.fetch(request);
        if (response.status >= 400) logError('assets.failed', new HttpError(response.status, 'Asset request failed.'), context, env);
        return response;
      }
      if (route && request.method !== route[0]) {
        logError('request.rejected', new HttpError(405, 'Method not allowed.'), context, env);
        return new Response('Method not allowed', { status: 405, headers: { Allow: route[0], 'Cache-Control': 'no-store' } });
      }
      if (new URL(request.url).origin !== origin(env)) throw new HttpError(400, 'Please use the configured membership site address.');
      return route ? await route[1](request, env) : await adminRequest(request, env, context);
    } catch (error) {
      logError('request.failed', error, context, env);
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
        const delaySeconds = Math.min(43200, Math.max(error.retryAfter || 0, 30 * 2 ** Math.min(message.attempts - 1, 10)));
        logError('queue.failed', error, { message_id: message.id, attempt: message.attempts, retry_delay_seconds: delaySeconds }, env);
        message.retry({ delaySeconds });
      }
    }
  },
};
