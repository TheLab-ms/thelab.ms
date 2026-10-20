// Stripe checkout, subscription webhooks, and the Discord member role.
import {
  HttpError, currentMember, discord, grantsMembership, isOngoingSubscription, loginRedirect, now, origin, redirect,
  selectCurrentSubscription, stripe, stripeList, verifyStripe,
} from './lib.js';
import { pushFobs } from './edge.js';

export async function setDiscordRole(env, discordUserID, granted) {
  if (!discordUserID) return;
  try {
    await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${discordUserID}/roles/${env.DISCORD_ROLE_ID}`, granted ? 'PUT' : 'DELETE');
  } catch (error) {
    // A member who left the guild already lacks the role and can't be given it.
    // Skip rather than fail, so Stripe deliveries and admin syncs still succeed.
    // Discord code 10007 is Unknown Member; other 404s (e.g. a bad role ID) still fail.
    if (error.providerStatus !== 404 || (granted && error.providerCode !== 10007)) throw error;
    if (granted) console.warn(JSON.stringify({ event: 'discord.role_skipped', discord_user_id: discordUserID, reason: 'not in guild' }));
  }
}

// Discord requests can finish out of order, too. A late write repairs itself
// against current D1 state, including account transfers and member deletion.
export async function syncDiscordRole(env, memberID) {
  const read = () => env.DB.prepare('SELECT discord_user_id, stripe_subscription_state FROM members WHERE member_id = ?').bind(memberID).first();
  let member = await read();
  while (member) {
    const granted = grantsMembership(member.stripe_subscription_state);
    await setDiscordRole(env, member.discord_user_id, granted);
    const current = await read();
    if (!current || current.discord_user_id !== member.discord_user_id) await setDiscordRole(env, member.discord_user_id, false);
    if (!current || (current.discord_user_id === member.discord_user_id && grantsMembership(current.stripe_subscription_state) === granted)) return;
    member = current;
  }
}

// Copies the customer's current subscription into D1 and applies the result.
export async function syncMember(env, member) {
  const customer = member.stripe_customer_id;
  const sync = await env.DB.prepare(`UPDATE members SET stripe_sync_version = stripe_sync_version + 1
    WHERE member_id = ? AND stripe_customer_id IS ? RETURNING stripe_sync_version`).bind(member.member_id, customer).first();
  if (!sync) return;
  const [billing, subscriptions] = customer
    ? await Promise.all([stripe(env, `/customers/${customer}`), stripeList(env, '/subscriptions', { customer, status: 'all' })])
    : [{}, []];
  const current = selectCurrentSubscription(subscriptions);
  const updated = await env.DB.prepare(`UPDATE members SET stripe_subscription_id = ?, stripe_subscription_state = ?,
    billing_name = ?, billing_email = ? WHERE member_id = ? AND stripe_customer_id IS ? AND stripe_sync_version = ? RETURNING member_id`)
    .bind(current?.id || null, current?.status || null, billing.name || '', billing.email || '', member.member_id, customer, sync.stripe_sync_version).first();
  if (!updated) return; // Superseded by a newer sync, deletion, or customer change.
  await pushFobs(env);
  await syncDiscordRole(env, member.member_id);
}

export async function stripeWebhook(request, env) {
  const text = await request.text();
  await verifyStripe(request, env, text);
  let event;
  try { event = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid Stripe event.'); }
  const object = event?.data?.object;
  let customer;
  if (event?.type === 'checkout.session.completed') {
    customer = object.customer;
    // Also accept checkouts created before customers were linked up front.
    if (typeof customer === 'string' && /^[a-f0-9]{32}$/.test(object.client_reference_id || '')) {
      await env.DB.prepare(`UPDATE members SET stripe_customer_id = ?, metadata_version = metadata_version + 1
        WHERE member_id = ? AND stripe_customer_id IS NULL`)
        .bind(customer, object.client_reference_id).run();
    }
  } else if (event?.type === 'customer.updated') {
    customer = object.id;
  } else if (event?.type?.startsWith('customer.subscription.')) {
    customer = object.customer;
  }
  if (typeof customer !== 'string') return new Response(null, { status: 204 });
  // Unmapped customers (e.g. donors) are outside this app. Failures return an
  // error so Stripe retries the delivery.
  const member = await env.DB.prepare('SELECT * FROM members WHERE stripe_customer_id = ?').bind(customer).first();
  if (member) await syncMember(env, member);
  return new Response(null, { status: 204 });
}

async function resolvePricing(env, member) {
  const annual = Boolean(member.bill_annually);
  const prices = await stripeList(env, '/prices', { active: 'true', 'lookup_keys[]': annual ? 'yearly' : 'monthly' });
  const price = prices.find(item => item.type === 'recurring' && item.recurring?.interval === (annual ? 'year' : 'month') && item.recurring.interval_count === 1);
  if (!price) throw new HttpError(503, 'Membership checkout is temporarily unavailable. Please contact leadership.');
  if (!member.discount_type) return { price };
  const product = typeof price.product === 'string' ? price.product : price.product.id;
  const coupon = (await stripeList(env, '/coupons')).find(item => item.valid
    && (item.metadata?.discountTypes || '').split(',').some(value => value.trim().toLowerCase() === member.discount_type.toLowerCase())
    && (!item.applies_to?.products || item.applies_to.products.includes(product)));
  if (!coupon) throw new HttpError(503, 'We couldn’t apply your discount. Please contact leadership before paying.');
  return { price, coupon };
}

// Returns the URL and any customer link saved to the member. Admin links can
// precede onboarding; all checkouts for a member share one Stripe customer.
export async function checkoutLink(env, member, { shared = false } = {}) {
  let customer = member.stripe_customer_id, sessions = [];
  const existingCheckout = async () => {
    // Read sessions before subscriptions: a completed session must not be
    // mistaken for permission to start another subscription during payment.
    sessions = (await stripeList(env, '/checkout/sessions', { customer }))
      .filter(session => session.mode === 'subscription' && session.client_reference_id === member.member_id);
    const subscriptions = await stripeList(env, '/subscriptions', { customer, status: 'all' });
    if (subscriptions.some(sub => isOngoingSubscription(sub.status))) {
      if (shared) throw new HttpError(409, 'This member already has an ongoing subscription. Manage it in Stripe.');
      return (await stripe(env, '/billing_portal/sessions', { customer, return_url: origin(env) })).url;
    }
  };
  const portal = customer && await existingCheckout();
  if (portal) return { url: portal, member };
  // Admin-shared links can precede the waiver; door access still requires it.
  if (!shared && !member.waiver_signed) return { url: `${origin(env)}/waiver`, member };
  let pricing;
  if (!customer) {
    // Checkout links expire within 24 hours. Retire customerless links from
    // before upfront linking, and recover a customer whose webhook is delayed.
    const recent = (await stripeList(env, '/checkout/sessions', { 'created[gte]': String(now() - 86400) }))
      .filter(session => session.mode === 'subscription' && session.client_reference_id === member.member_id);
    const customers = [...new Set(recent.filter(session => ['open', 'complete'].includes(session.status) && typeof session.customer === 'string').map(session => session.customer))];
    if (customers.length > 1) throw new HttpError(409, 'We found multiple billing accounts for your membership. Please contact leadership before paying.');
    let customerID = customers[0];
    if (!customerID) pricing = await resolvePricing(env, member);
    for (const session of recent) {
      if (session.status === 'open' && !session.customer) await stripe(env, `/checkout/sessions/${session.id}/expire`, {}, `member-checkout-expire:${session.id}`);
    }
    if (!customerID) {
      const email = member.discord_email || member.email;
      customerID = (await stripe(env, '/customers', {
        ...(email ? { email } : {}), 'metadata[thelab_member_id]': member.member_id,
      }, `member-customer:${member.member_id}:${member.metadata_version}`)).id;
    }
    const updated = await env.DB.prepare(`UPDATE members SET stripe_customer_id = ?, metadata_version = metadata_version + 1
      WHERE member_id = ? AND stripe_customer_id IS NULL AND metadata_version = ? RETURNING *`)
      .bind(customerID, member.member_id, member.metadata_version).first()
      // A simultaneous request may have saved the same idempotent customer.
      ?? await env.DB.prepare('SELECT * FROM members WHERE member_id = ? AND stripe_customer_id = ? AND metadata_version = ?')
        .bind(member.member_id, customerID, member.metadata_version + 1).first();
    if (!updated) throw new HttpError(409, 'Your membership changed while checkout was opening. Please reload and try again.');
    member = { ...member, ...updated };
    customer = member.stripe_customer_id;
    const portal = await existingCheckout();
    if (portal) return { url: portal, member };
  }
  const { price, coupon } = pricing ?? await resolvePricing(env, member);
  // Reuse a pending payment. Expire superseded pricing and duplicate links so
  // an older admin-shared URL cannot create a second subscription later.
  const pending = sessions.filter(session => session.status === 'open');
  const reusable = pending.find(session => session.metadata?.thelab_price_id === price.id
    && (session.metadata?.thelab_coupon_id || '') === (coupon?.id || ''));
  for (const session of pending) {
    if (session !== reusable) await stripe(env, `/checkout/sessions/${session.id}/expire`, {}, `member-checkout-expire:${session.id}`);
  }
  if (reusable) return { url: reusable.url, member };
  // The count advances only after Stripe creates a session. Concurrent
  // requests use the same key, even if they request different pricing.
  const session = await stripe(env, '/checkout/sessions', {
    mode: 'subscription',
    customer, 'customer_update[name]': 'auto',
    client_reference_id: member.member_id,
    success_url: `${origin(env)}/welcome`,
    cancel_url: `${origin(env)}/#membership`,
    'line_items[0][price]': price.id,
    'line_items[0][quantity]': '1',
    'payment_method_types[0]': 'card',
    'metadata[thelab_member_id]': member.member_id,
    'metadata[thelab_price_id]': price.id,
    ...(coupon ? { 'metadata[thelab_coupon_id]': coupon.id } : {}),
    'subscription_data[metadata][thelab_member_id]': member.member_id,
    ...(coupon ? { 'discounts[0][coupon]': coupon.id } : {}),
  }, `member-checkout:${member.member_id}:${customer}:${sessions.length}`);
  return { url: session.url, member };
}

export async function checkout(request, env) {
  const member = await currentMember(request, env);
  if (!member) return loginRedirect('/checkout');
  return redirect((await checkoutLink(env, member)).url);
}
