import { DurableObject } from 'cloudflare:workers';
import { discord, discounts, hash, HttpError, json, now, origin, randomToken, stripe, stripeList } from './http.js';
import { memberName, validateMetadata } from './member-metadata.js';
import { logError, requestContext } from './logging.js';

const healthy = subscription => ['active', 'trialing'].includes(subscription.status);
const ongoing = subscription => !['canceled', 'incomplete_expired'].includes(subscription.status);

// Checkout, admin edits, and queue work share a stable membership instance.
// A promise chain is needed because external fetches allow DO requests to interleave.
export class Membership extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tail = Promise.resolve();
  }

  async fetch(request) {
    const work = this.tail.then(async () => {
      try {
        const input = await request.json();
        const path = new URL(request.url).pathname;
        if (input.expected_member_id && path !== '/sync') {
          const member = await this.member(input.user?.id || input.discord_user_id);
          if (member.member_id !== input.expected_member_id) throw new HttpError(409, 'Membership identity changed. Please reload and try again.');
        }
        if (path === '/checkout') return json({ url: await this.checkout(input) });
        if (path === '/sync') { await this.sync(input); return json({ ok: true }); }
        if (path === '/admin/update') { await this.updateMetadata(input); return json({ ok: true }); }
        throw new HttpError(404, 'Unknown membership operation.');
      } catch (error) {
        const errorID = logError('membership.failed', error, requestContext(request), this.env);
        return json({ error: error instanceof HttpError ? error.message : 'Membership operation failed.', retry_after: error.retryAfter || 0, error_id: errorID }, error instanceof HttpError ? error.status : 500);
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async member(id) {
    const member = await this.env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(id).first();
    if (!member) throw new HttpError(404, 'Membership not found. Please sign in again.');
    return member;
  }

  async write(slot, path, form) {
    let operation = await this.ctx.storage.get(slot);
    if (!operation) {
      operation = { key: randomToken(), path, form, created: now() };
      await this.ctx.storage.put(slot, operation);
    }
    if (operation.path !== path || JSON.stringify(operation.form) !== JSON.stringify(form)) {
      throw new HttpError(409, 'A previous billing request needs to finish. Retry your original selection or contact leadership.');
    }
    if (operation.result) return operation.result;
    // Stripe retains idempotency keys for at least 24h. Never blindly replay an
    // ambiguous write after that guarantee expires (e.g. following a long outage).
    if (operation.created < now() - 23 * 3600) throw new HttpError(409, 'An earlier billing request needs review. Please contact leadership.');
    operation.result = await stripe(this.env, path, form, operation.key);
    await this.ctx.storage.put(slot, operation);
    return operation.result;
  }

  async subscriptions(member) {
    if (!member.stripe_customer_id) return [];
    return (await stripeList(this.env, '/subscriptions', { customer: member.stripe_customer_id, status: 'all' }))
      .filter(sub => sub.metadata?.thelab_member_id ? sub.metadata.thelab_member_id === member.member_id : sub.metadata?.thelab_discord_id === member.discord_user_id);
  }

  async checkout({ user, annual, discount }) {
    const id = user.id;
    await this.member(id);
    await this.env.DB.prepare(`UPDATE members SET discord_username = ?, discord_email = ?,
      metadata_version = metadata_version + 1 WHERE discord_user_id = ?`)
      .bind(user.username, user.email.toLowerCase(), id).run();
    let member = await this.member(id);
    if (member.stripe_customer_id) {
      const subscriptions = await this.subscriptions(member);
      if (subscriptions.some(ongoing)) {
        // Reconcile a just-completed Checkout even if its webhook is still in flight.
        await this.env.MEMBERSHIP_QUEUE.send({ customer_id: member.stripe_customer_id });
        const session = await stripe(this.env, '/billing_portal/sessions', {
          customer: member.stripe_customer_id, return_url: origin(this.env),
        });
        return this.stripeURL(session.url, 'billing.stripe.com');
      }
    }

    if (!discounts.includes(discount) || typeof annual !== 'boolean') throw new HttpError(400, 'Invalid membership selection.');
    // Resolve a previous ambiguous checkout using its ORIGINAL parameters before
    // expiring/replacing it. This also survives a crash before persisting its ID.
    let prior = await this.ctx.storage.get('checkout');
    if (prior) {
      const created = await this.write('checkout', prior.path, prior.form);
      const session = await stripe(this.env, `/checkout/sessions/${encodeURIComponent(created.id)}`);
      let finished = session.status === 'expired';
      if (session.status === 'complete') {
        const subID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const subscriptions = await this.subscriptions(member);
        finished = subscriptions.some(sub => sub.id === subID && !ongoing(sub));
        if (!finished) throw new HttpError(409, 'Your previous checkout is being processed. Please try again shortly.');
      }
      if (!['open', 'expired', 'complete'].includes(session.status)) throw new HttpError(502, 'Stripe returned an invalid checkout status.');
      if (finished) {
        await this.ctx.storage.delete('checkout');
        prior = null;
      } else {
        prior.session = session;
      }
    }

    const status = discount ? (member.discount_type === discount ? member.discount_status || 'requested' : 'requested') : '';
    // A changed selection or a revoked approval must invalidate any old payment link.
    const changed = Boolean(member.bill_annually) !== annual || member.discount_type !== discount || (discount && status !== 'approved');
    if (prior && changed) {
      await this.expire(prior.session);
      await this.ctx.storage.delete('checkout');
      prior = null;
    }
    await this.env.DB.prepare('UPDATE members SET bill_annually = ?, discount_type = ?, discount_status = ?, metadata_version = metadata_version + 1 WHERE discord_user_id = ?')
      .bind(annual ? 1 : 0, discount, status, id).run();
    if (status === 'requested') return `${origin(this.env)}/membership-pending`;
    if (status === 'denied') throw new HttpError(403, 'Your discount request was declined. Contact leadership or select the standard rate to continue.');

    const prices = await stripeList(this.env, '/prices', { active: 'true', 'lookup_keys[]': annual ? 'yearly' : 'monthly' });
    const price = prices.find(item => item.type === 'recurring' && item.recurring?.interval === (annual ? 'year' : 'month') && item.recurring.interval_count === 1);
    if (!price) throw new HttpError(503, 'The membership price is not configured. Please contact leadership.');
    let coupon;
    if (discount) {
      const coupons = await stripeList(this.env, '/coupons');
      coupon = coupons.find(item => item.valid && (item.metadata?.discountTypes || '').split(',').map(s => s.trim().toLowerCase()).includes(discount.toLowerCase()) && (!item.applies_to?.products || item.applies_to.products.includes(typeof price.product === 'string' ? price.product : price.product.id)));
      if (!coupon) throw new HttpError(503, 'Your approved discount has no valid Stripe coupon. Please contact leadership before paying.');
    }

    if (!member.stripe_customer_id) {
      const previous = await this.ctx.storage.get('customer');
      const customer = await this.write('customer', '/customers', previous?.form || {
        name: memberName(member),
        'metadata[thelab_discord_id]': id,
        'metadata[thelab_member_id]': member.member_id,
      });
      if (!/^cus_[A-Za-z0-9]+$/.test(customer.id)) throw new HttpError(502, 'Stripe returned an invalid customer.');
      await this.env.DB.prepare('UPDATE members SET stripe_customer_id = ?, billing_name = ?, billing_email = ? WHERE discord_user_id = ?')
        .bind(customer.id, customer.name || '', customer.email || '', id).run();
      member = await this.member(id);
    }

    // Stripe locks an existing Customer's email in Checkout. Clear it so the
    // member can choose their billing email; Checkout saves their entry back.
    await stripe(this.env, `/customers/${member.stripe_customer_id}`, { email: '' });

    const form = {
      mode: 'subscription',
      customer: member.stripe_customer_id,
      'customer_update[name]': 'auto',
      client_reference_id: id,
      success_url: `${origin(this.env)}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin(this.env)}/#membership`,
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': '1',
      // Card-only Checkout completes payment synchronously before the welcome redirect.
      'payment_method_types[0]': 'card',
      'metadata[thelab_discord_id]': id,
      'metadata[thelab_member_id]': member.member_id,
      'subscription_data[metadata][thelab_discord_id]': id,
      'subscription_data[metadata][thelab_member_id]': member.member_id,
      ...(coupon ? { 'discounts[0][coupon]': coupon.id } : {}),
    };
    if (prior) {
      if (await hash(JSON.stringify(form)) === await hash(JSON.stringify(prior.form))) return this.stripeURL(prior.session.url, 'checkout.stripe.com');
      await this.expire(prior.session);
      await this.ctx.storage.delete('checkout');
    }
    const session = await this.write('checkout', '/checkout/sessions', form);
    return this.stripeURL(session.url, 'checkout.stripe.com');
  }

  async expire(session) {
    try {
      await stripe(this.env, `/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}, `expire-${session.id}`);
    } catch (error) {
      // A simultaneous payment wins over expiry; never open a second checkout.
      const current = await stripe(this.env, `/checkout/sessions/${encodeURIComponent(session.id)}`);
      if (current.status !== 'expired') throw error;
    }
  }

  async updateMetadata({ discord_user_id: id, fields }) {
    const value = validateMetadata(fields);
    const member = await this.member(id);
    if (member.metadata_version !== value.metadata_version) throw new HttpError(409, 'This member was changed after you opened the form. Reload the member and reapply your edits.');
    const discordChanged = member.discord_user_id !== value.discord_user_id;
    const customerChanged = member.stripe_customer_id !== value.stripe_customer_id;
    const identityChanged = discordChanged || customerChanged || member.stripe_subscription_id !== value.stripe_subscription_id;
    let username = member.discord_username, email = member.discord_email;
    let billingName = member.billing_name, billingEmail = member.billing_email;
    let selected;
    if (identityChanged) {
      const duplicate = await this.env.DB.prepare(`SELECT member_id FROM members WHERE member_id != ?
        AND (discord_user_id = ? OR stripe_customer_id = ?)`).bind(member.member_id, value.discord_user_id, value.stripe_customer_id).first();
      if (duplicate) throw new HttpError(409, 'That Discord account or Stripe customer already belongs to another membership.');
      if (discordChanged) {
        const account = await discord(this.env, `/guilds/${this.env.DISCORD_GUILD_ID}/members/${value.discord_user_id}`);
        if (account.user?.id !== value.discord_user_id || !account.user.username || account.user.bot) throw new HttpError(400, 'Choose a valid Discord member account.');
        username = account.user.username;
        email = '';
      }
      if (value.stripe_customer_id) {
        const customer = await stripe(this.env, `/customers/${value.stripe_customer_id}`);
        if (customer.deleted) throw new HttpError(400, 'This Stripe customer has been deleted.');
        billingName = customer.name || '';
        billingEmail = customer.email || '';
      } else {
        billingName = billingEmail = '';
      }
      if (value.stripe_subscription_id) {
        selected = await stripe(this.env, `/subscriptions/${value.stripe_subscription_id}`);
        if (selected.customer !== value.stripe_customer_id) throw new HttpError(400, 'The Stripe subscription does not belong to this customer.');
      }
    }
    const pricingChanged = ['bill_annually', 'discount_type', 'discount_status'].some(key => member[key] !== value[key]);
    if (pricingChanged || identityChanged) {
      // Resolve ambiguous creation before expiring the old URL. This shares the
      // checkout lock and durable idempotency record, including its age limit.
      const prior = await this.ctx.storage.get('checkout');
      if (prior) {
        const created = await this.write('checkout', prior.path, prior.form);
        const session = await stripe(this.env, `/checkout/sessions/${encodeURIComponent(created.id)}`);
        if (session.status === 'open') await this.expire(session);
        else if (!['expired', 'complete'].includes(session.status)) throw new HttpError(502, 'Stripe returned an invalid checkout status.');
        // Keep completed checkout tracking so signup still guards against a
        // second checkout while Stripe is finishing the first subscription.
        if (identityChanged && session.status === 'complete') {
          const subscriptions = await this.subscriptions(member);
          const subID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          if (!subscriptions.some(sub => sub.id === subID)) throw new HttpError(409, 'The completed checkout is still being processed. Retry after Stripe synchronizes.');
        }
        if (session.status !== 'complete' || identityChanged) await this.ctx.storage.delete('checkout');
      }
    }
    if (identityChanged) {
      // Stable membership metadata keeps automatic selection working after a
      // Discord transfer, including retries after a partially completed write.
      const subscriptions = !customerChanged ? await this.subscriptions(member) : [];
      if (selected && !subscriptions.some(sub => sub.id === selected.id)) subscriptions.push(selected);
      const metadata = { 'metadata[thelab_discord_id]': value.discord_user_id, 'metadata[thelab_member_id]': member.member_id };
      const editKey = `admin-${member.member_id}-${value.metadata_version}-${await hash(JSON.stringify(metadata))}`;
      for (const sub of subscriptions) await stripe(this.env, `/subscriptions/${sub.id}`, metadata,
        `${editKey}-${sub.id}`);
      if (value.stripe_customer_id) await stripe(this.env, `/customers/${value.stripe_customer_id}`, metadata,
        `${editKey}-${value.stripe_customer_id}`);
      if (discordChanged || customerChanged) {
        try { await discord(this.env, `/guilds/${this.env.DISCORD_GUILD_ID}/members/${id}/roles/${this.env.DISCORD_ROLE_ID}`, 'DELETE'); }
        catch (error) { if (error.providerStatus !== 404) throw error; }
      }
      await this.ctx.storage.delete('customer');
      // The queued sync uses this same stable lock, so it runs after the save.
      await this.env.MEMBERSHIP_QUEUE.send({ member_id: member.member_id });
    }
    const statements = [];
    statements.push(this.env.DB.prepare(`UPDATE members SET discord_user_id = ?, discord_username = ?, discord_email = ?,
      billing_name = ?, billing_email = ?, name_override = ?, notes = ?, bill_annually = ?, discount_type = ?,
      discount_status = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
      stripe_subscription_state = ?, stripe_synced_at = ?, discord_last_synced = ?,
      auth_version = auth_version + ?, metadata_version = metadata_version + 1 WHERE discord_user_id = ? AND metadata_version = ?`)
      .bind(value.discord_user_id, username, email, billingName, billingEmail, value.name_override, value.notes,
        value.bill_annually, value.discount_type, value.discount_status, value.stripe_customer_id, value.stripe_subscription_id,
        identityChanged ? selected?.status || null : member.stripe_subscription_state,
        identityChanged ? null : member.stripe_synced_at, identityChanged ? null : member.discord_last_synced, discordChanged ? 1 : 0, id, value.metadata_version));
    const results = await this.env.DB.batch(statements);
    const result = results[results.length - 1];
    if (result.meta.changes !== 1) throw new HttpError(409, 'This member was changed. Reload the member and reapply your edits.');
  }

  stripeURL(value, host) {
    let url;
    try { url = new URL(value); } catch { /* Validate below. */ }
    if (!url || url.protocol !== 'https:' || url.hostname !== host) throw new HttpError(502, 'Stripe returned an invalid redirect.');
    return url.href;
  }

  async sync({ discord_user_id: id, member_id: memberID, customer_id: customer }) {
    const member = memberID ? await this.env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(memberID).first() : await this.member(id);
    if (!member) return;
    id = member.discord_user_id;
    if (memberID) customer = member.stripe_customer_id;
    if (member.stripe_customer_id !== customer) throw new HttpError(409, 'Billing identity changed.');
    // Every delivery reconciles current Stripe state, including delayed webhooks.
    const billing = customer ? await stripe(this.env, `/customers/${customer}`) : {};
    const subscriptions = await this.subscriptions(member);
    const paid = subscriptions.some(healthy);
    const current = subscriptions.filter(healthy).sort((a, b) => b.created - a.created)[0]
      || subscriptions.filter(ongoing).sort((a, b) => b.created - a.created)[0]
      || subscriptions.sort((a, b) => b.created - a.created)[0];
    await this.env.DB.prepare(`UPDATE members SET stripe_subscription_id = ?, stripe_subscription_state = ?, stripe_synced_at = ?,
      billing_name = ?, billing_email = ?, metadata_version = metadata_version + 1 WHERE discord_user_id = ?`)
      .bind(current?.id || null, current?.status || null, now(), billing.name || '', billing.email || '', id).run();

    const path = `/guilds/${this.env.DISCORD_GUILD_ID}/members/${id}/roles/${this.env.DISCORD_ROLE_ID}`;
    // Repeating PUT/DELETE is safe if the process crashes after Discord succeeds.
    // Retry even if the saved Stripe state matches: a previous Discord call may have failed.
    // Failed removals/additions remain unacknowledged and are retried by the queue.
    await discord(this.env, path, paid ? 'PUT' : 'DELETE');
    await this.env.DB.prepare('UPDATE members SET discord_last_synced = ? WHERE discord_user_id = ?').bind(now(), id).run();
  }
}

export async function coordinated(env, id, path, input) {
  if (path === '/checkout') {
    await env.DB.prepare(`INSERT INTO members (discord_user_id, discord_username, discord_email) VALUES (?, ?, ?)
      ON CONFLICT(discord_user_id) DO NOTHING`).bind(id, input.user.username, input.user.email.toLowerCase()).run();
  }
  const member = input.member_id ? { member_id: input.member_id } : await env.DB.prepare('SELECT member_id FROM members WHERE discord_user_id = ?').bind(id).first();
  if (!member) throw new HttpError(404, 'Membership not found. Please sign in again.');
  const response = await env.MEMBERS.get(env.MEMBERS.idFromName(member.member_id)).fetch(`https://membership.internal${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, expected_member_id: member.member_id }),
  });
  const value = await response.json();
  if (!response.ok) {
    const error = new HttpError(response.status, value.error, value.retry_after);
    error.errorId = value.error_id;
    throw error;
  }
  return value;
}
