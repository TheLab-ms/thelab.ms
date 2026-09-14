import { boundedText, cookie, errorPage, HttpError, json, origin, redirect } from './http.js';
import { discord, discordIdentity, stripe, verifyStripe } from './providers.js';
import { grantsMembership } from './membership-policy.js';
import { finishLogin, loginDestination, memberToken, signedInMember, startLogin, verifyOAuthState } from './auth.js';
import { coordinated, registerMember } from './membership.js';
import { adminConfigured, adminRequest, finishAdminLogin } from './admin.js';
import { logError, requestContext } from './logging.js';
import { printerAccess } from './printers.js';
import { edgeJWKS } from './edge-auth.js';
import { waiverRequest } from './waiver.js';
import { wikiRequest } from './wiki.js';
import { bindFob, cleanupFobClaims, kioskClaims, kioskPage } from './kiosk.js';
export { Wiki } from './wiki-store.js';
export { Membership } from './membership.js';
export { EdgeSync } from './edge-sync.js';
import { edgeCall, edgeEnabled, nightlyDate } from './edge-sync.js';

const events = new Set([
  'customer.updated',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'invoice.paid', 'invoice.payment_failed',
]);

function configured(env, admin = false) {
  origin(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || (!admin && !env.STRIPE_SECRET_KEY)) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
}

async function signup(request, env, admin = false) {
  configured(env, admin);
  if (admin) adminConfigured(env);
  return startLogin(request, env, admin ? 'admin' : 'signup');
}

async function resume(request, env) {
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  const result = await coordinated(env, member.member_id, 'checkout', {
    user: { id: member.discord_user_id, username: member.discord_username, email: member.discord_email },
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
  const user = await discordIdentity(env, code);
  let guildMember;
  try {
    guildMember = await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
  } catch (error) {
    if (error.providerStatus === 404) throw new HttpError(403, 'Please join TheLab’s Discord server using the link below, then return to signup.');
    throw error;
  }
  if (pending.purpose === 'admin') return finishAdminLogin(env, user, guildMember, pending.return_to);
  if (pending.purpose === 'member') {
    let member = await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(user.id).first();
    if (!member) {
      const pendingMember = await env.DB.prepare('SELECT member_id FROM members WHERE email = ? AND discord_user_id IS NULL').bind(user.email.trim().toLowerCase()).first();
      if (!pendingMember) throw new HttpError(404, 'No membership found for this Discord account. Please choose a membership to sign up.');
      member = await registerMember(env, user);
    }
    member = await coordinated(env, member.member_id, 'refreshIdentity', { user });
    return finishLogin(env, `${origin(env)}${loginDestination(pending.return_to, 'member')}`, 'member', await memberToken(env, member));
  }
  configured(env);
  const registered = await registerMember(env, user);
  const result = await coordinated(env, registered.member_id, 'checkout', { user });
  return finishLogin(env, result.url, 'member', await memberToken(env, registered));
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
  if (!grantsMembership(subscription.status)) throw new HttpError(409, 'Your membership payment is still being processed. Please try again shortly.');
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
    await coordinated(env, body.member_id, 'sync');
    return;
  }
  if (!body || !/^cus_[A-Za-z0-9]+$/.test(body.customer_id || '')) throw new HttpError(400, 'Invalid queue message.');
  const member = await env.DB.prepare('SELECT member_id FROM members WHERE stripe_customer_id = ?').bind(body.customer_id).first();
  // Other Stripe customers (e.g. donations or Conway) are outside this app.
  if (!member) return;
  await coordinated(env, member.member_id, 'sync', { customer_id: body.customer_id });
}

const routes = new Map([
  ['/.well-known/edge-jwks.json', ['GET', edgeJWKS]],
  ['/signup', ['GET', signup]],
  ['/waiver', ['GET, POST', waiverRequest]],
  ['/login/discord/callback', ['GET', callback]],
  ['/payment/success', ['GET', success]],
  ['/payment/resume', ['GET', resume]],
  ['/machines', ['GET', printerAccess]],
  ['/kiosk', ['GET', kioskPage]],
  ['/kiosk/claims', ['GET, POST', kioskClaims]],
  ['/keyfob/bind', ['GET, POST', bindFob]],
  ['/webhooks/stripe', ['POST', webhook]],
  ['/admin/login', ['GET', (request, env) => signup(request, env, true)]],
]);

export default {
  async scheduled(event, env) {
    await cleanupFobClaims(env);
    const date = nightlyDate(event.scheduledTime);
    if (date && edgeEnabled(env)) await edgeCall(env, 'nightly', date);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const context = requestContext(request);
    const route = routes.get(path);
    const isAdmin = path === '/admin' || path.startsWith('/admin/');
    const isWiki = path === '/wiki' || path.startsWith('/wiki/');
    try {
      if (!route && !isAdmin && !isWiki) {
        const response = await env.ASSETS.fetch(request);
        if (response.status >= 400) logError('assets.failed', new HttpError(response.status, 'Asset request failed.'), context, env);
        return response;
      }
      if (route && !route[0].split(', ').includes(request.method)) {
        logError('request.rejected', new HttpError(405, 'Method not allowed.'), context, env);
        return new Response('Method not allowed', { status: 405, headers: { Allow: route[0], 'Cache-Control': 'no-store' } });
      }
      if (url.origin !== origin(env)) throw new HttpError(400, 'Please use the configured membership site address.');
      if (isWiki) return await wikiRequest(request, env);
      return route ? await route[1](request, env) : await adminRequest(request, env, context);
    } catch (error) {
      logError('request.failed', error, context, env);
      if (path === '/webhooks/stripe') return json({ error: 'Webhook could not be accepted.' }, error instanceof HttpError ? error.status : 500);
      if (path === '/kiosk/claims') return json({ error: error instanceof HttpError ? error.message : 'Fob enrollment is temporarily unavailable. Please try again.' }, error instanceof HttpError ? error.status : 500);
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
