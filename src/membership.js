import { DurableObject } from 'cloudflare:workers';
import { hash, HttpError, now, origin, randomToken } from './http.js';
import { discord, stripe, stripeList } from './providers.js';
import { grantsMembership, isOngoingSubscription, selectCurrentSubscription } from './membership-policy.js';
import { memberName, validateMetadata } from './member-metadata.js';
import { logError } from './logging.js';

// Checkout, admin edits, and queue work share a stable membership instance.
// A promise chain is needed because external fetches allow DO requests to interleave.
export class Membership extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tail = Promise.resolve();
  }

  async execute({ member_id, operation, input = {} }) {
    const work = this.tail.then(async () => {
      try {
        const member = await this.env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(member_id).first();
        if (!member) {
          if (operation === 'sync') return { ok: true };
          throw new HttpError(404, 'Membership not found. Please sign in again.');
        }
        if (['checkout', 'refreshIdentity'].includes(operation) && member.discord_user_id !== input.user?.id) {
          throw new HttpError(409, 'Membership identity changed. Please reload and try again.');
        }
        let value;
        switch (operation) {
          case 'checkout': value = { url: await this.checkout(member, input) }; break;
          case 'refreshIdentity': value = await this.refreshIdentity(member, input.user); break;
          case 'sync': await this.sync(member, input); break;
          case 'updateMetadata': await this.updateMetadata(member, input); break;
          default: throw new HttpError(404, 'Unknown membership operation.');
        }
        return { ok: true, value };
      } catch (error) {
        const errorID = logError('membership.failed', error, { member_id, operation }, this.env);
        return { ok: false, error: error instanceof HttpError ? error.message : 'Membership operation failed.',
          status: error instanceof HttpError ? error.status : 500, retry_after: error.retryAfter || 0, error_id: errorID };
      }
    });
    this.tail = work.catch(() => {});
    return work;
  }

  async refreshIdentity(member, user) {
    return this.env.DB.prepare(`UPDATE members SET discord_username = ?, discord_email = ?,
      metadata_version = metadata_version + 1 WHERE member_id = ? RETURNING *`)
      .bind(user.username, user.email.toLowerCase(), member.member_id).first();
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

  async checkout(member, { user, annual = Boolean(member.bill_annually) }) {
    const id = user.id;
    member = await this.refreshIdentity(member, user);
    if (member.stripe_customer_id) {
      const subscriptions = await this.subscriptions(member);
      if (subscriptions.some(sub => isOngoingSubscription(sub.status))) {
        // Reconcile a just-completed Checkout even if its webhook is still in flight.
        await this.env.MEMBERSHIP_QUEUE.send({ customer_id: member.stripe_customer_id });
        const session = await stripe(this.env, '/billing_portal/sessions', {
          customer: member.stripe_customer_id, return_url: origin(this.env),
        });
        return this.stripeURL(session.url, 'billing.stripe.com');
      }
    }

    if (typeof annual !== 'boolean') throw new HttpError(400, 'Invalid membership selection.');
    // Resolve a previous ambiguous checkout using its ORIGINAL parameters before
    // expiring/replacing it. This also survives a crash before persisting its ID.
    let prior = await this.loadTrackedCheckout();
    if (prior) {
      const { session } = prior;
      let finished = session.status === 'expired';
      if (session.status === 'complete') {
        const subID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        const subscriptions = await this.subscriptions(member);
        finished = subscriptions.some(sub => sub.id === subID && !isOngoingSubscription(sub.status));
        if (!finished) throw new HttpError(409, 'Your previous checkout is being processed. Please try again shortly.');
      }
      if (finished) {
        await this.ctx.storage.delete('checkout');
        prior = null;
      }
    }

    // A changed billing cycle must invalidate any old payment link.
    const changed = Boolean(member.bill_annually) !== annual;
    if (prior && changed) {
      await this.expireTrackedCheckout(prior.session);
      prior = null;
    }
    await this.env.DB.prepare('UPDATE members SET bill_annually = ?, metadata_version = metadata_version + 1 WHERE member_id = ?')
      .bind(annual ? 1 : 0, member.member_id).run();

    // Discounts come only from the current admin-managed member record.
    const { price, coupon } = await this.resolvePricing(annual, member.discount_type);
    member = await this.ensureCustomer(member);

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
      if (JSON.stringify(form) === JSON.stringify(prior.form)) return this.stripeURL(prior.session.url, 'checkout.stripe.com');
      await this.expireTrackedCheckout(prior.session);
    }
    const session = await this.write('checkout', '/checkout/sessions', form);
    return this.stripeURL(session.url, 'checkout.stripe.com');
  }

  async resolvePricing(annual, discount) {
    const prices = await stripeList(this.env, '/prices', { active: 'true', 'lookup_keys[]': annual ? 'yearly' : 'monthly' });
    const price = prices.find(item => item.type === 'recurring' && item.recurring?.interval === (annual ? 'year' : 'month') && item.recurring.interval_count === 1);
    if (!price) throw new HttpError(503, 'The membership price is not configured. Please contact leadership.');
    let coupon;
    if (discount) {
      const coupons = await stripeList(this.env, '/coupons');
      const product = typeof price.product === 'string' ? price.product : price.product.id;
      coupon = coupons.find(item => item.valid
        && (item.metadata?.discountTypes || '').split(',').some(value => value.trim().toLowerCase() === discount.toLowerCase())
        && (!item.applies_to?.products || item.applies_to.products.includes(product)));
      if (!coupon) throw new HttpError(503, 'Your assigned discount has no valid Stripe coupon. Please contact leadership before paying.');
    }
    return { price, coupon };
  }

  async ensureCustomer(member) {
    if (member.stripe_customer_id) return member;
    const previous = await this.ctx.storage.get('customer');
    const customer = await this.write('customer', '/customers', previous?.form || {
      name: memberName(member),
      'metadata[thelab_discord_id]': member.discord_user_id,
      'metadata[thelab_member_id]': member.member_id,
    });
    if (!/^cus_[A-Za-z0-9]+$/.test(customer.id)) throw new HttpError(502, 'Stripe returned an invalid customer.');
    return this.env.DB.prepare('UPDATE members SET stripe_customer_id = ?, billing_name = ?, billing_email = ? WHERE member_id = ? RETURNING *')
      .bind(customer.id, customer.name || '', customer.email || '', member.member_id).first();
  }

  async loadTrackedCheckout() {
    const operation = await this.ctx.storage.get('checkout');
    if (!operation) return null;
    const created = await this.write('checkout', operation.path, operation.form);
    const session = await stripe(this.env, `/checkout/sessions/${encodeURIComponent(created.id)}`);
    if (!['open', 'expired', 'complete'].includes(session.status)) throw new HttpError(502, 'Stripe returned an invalid checkout status.');
    return { ...operation, session };
  }

  async expireTrackedCheckout(session) {
    try {
      await stripe(this.env, `/checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}, `expire-${session.id}`);
    } catch (error) {
      // A simultaneous payment wins over expiry; never open a second checkout.
      const current = await stripe(this.env, `/checkout/sessions/${encodeURIComponent(session.id)}`);
      if (current.status !== 'expired') throw error;
    }
    await this.ctx.storage.delete('checkout');
  }

  async updateMetadata(member, { fields }) {
    const value = validateMetadata(fields);
    const id = member.discord_user_id;
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
    const pricingChanged = ['bill_annually', 'discount_type'].some(key => member[key] !== value[key]);
    if (pricingChanged || identityChanged) {
      // Resolve ambiguous creation before expiring the old URL. This shares the
      // checkout lock and durable idempotency record, including its age limit.
      const prior = await this.loadTrackedCheckout();
      if (prior) {
        const { session } = prior;
        if (session.status === 'open') await this.expireTrackedCheckout(session);
        // Keep completed checkout tracking so signup still guards against a
        // second checkout while Stripe is finishing the first subscription.
        if (identityChanged && session.status === 'complete') {
          const subscriptions = await this.subscriptions(member);
          const subID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          if (!subscriptions.some(sub => sub.id === subID)) throw new HttpError(409, 'The completed checkout is still being processed. Retry after Stripe synchronizes.');
        }
        if (session.status === 'expired' || identityChanged) await this.ctx.storage.delete('checkout');
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
    const result = await this.env.DB.prepare(`UPDATE members SET discord_user_id = ?, discord_username = ?, discord_email = ?,
      billing_name = ?, billing_email = ?, name_override = ?, notes = ?, bill_annually = ?, discount_type = ?,
      stripe_customer_id = ?, stripe_subscription_id = ?,
      stripe_subscription_state = ?, stripe_synced_at = ?, discord_last_synced = ?,
      auth_version = auth_version + ?, metadata_version = metadata_version + 1 WHERE member_id = ? AND metadata_version = ?`)
      .bind(value.discord_user_id, username, email, billingName, billingEmail, value.name_override, value.notes,
        value.bill_annually, value.discount_type, value.stripe_customer_id, value.stripe_subscription_id,
        identityChanged ? selected?.status || null : member.stripe_subscription_state,
        identityChanged ? null : member.stripe_synced_at, identityChanged ? null : member.discord_last_synced, discordChanged ? 1 : 0, member.member_id, value.metadata_version).run();
    if (result.meta.changes !== 1) throw new HttpError(409, 'This member was changed. Reload the member and reapply your edits.');
  }

  stripeURL(value, host) {
    let url;
    try { url = new URL(value); } catch { /* Validate below. */ }
    if (!url || url.protocol !== 'https:' || url.hostname !== host) throw new HttpError(502, 'Stripe returned an invalid redirect.');
    return url.href;
  }

  async sync(member, { customer_id: customer = member.stripe_customer_id }) {
    const id = member.discord_user_id;
    if (member.stripe_customer_id !== customer) throw new HttpError(409, 'Billing identity changed.');
    // Every delivery reconciles current Stripe state, including delayed webhooks.
    const billing = customer ? await stripe(this.env, `/customers/${customer}`) : {};
    const subscriptions = await this.subscriptions(member);
    const current = selectCurrentSubscription(subscriptions);
    const paid = grantsMembership(current?.status);
    await this.env.DB.prepare(`UPDATE members SET stripe_subscription_id = ?, stripe_subscription_state = ?, stripe_synced_at = ?,
      billing_name = ?, billing_email = ?, metadata_version = metadata_version + 1 WHERE member_id = ?`)
      .bind(current?.id || null, current?.status || null, now(), billing.name || '', billing.email || '', member.member_id).run();

    const path = `/guilds/${this.env.DISCORD_GUILD_ID}/members/${id}/roles/${this.env.DISCORD_ROLE_ID}`;
    // Repeating PUT/DELETE is safe if the process crashes after Discord succeeds.
    // Retry even if the saved Stripe state matches: a previous Discord call may have failed.
    // Failed removals/additions remain unacknowledged and are retried by the queue.
    await discord(this.env, path, paid ? 'PUT' : 'DELETE');
    await this.env.DB.prepare('UPDATE members SET discord_last_synced = ? WHERE member_id = ?').bind(now(), member.member_id).run();
  }
}

export async function registerMember(env, user) {
  await env.DB.prepare(`INSERT INTO members (discord_user_id, discord_username, discord_email) VALUES (?, ?, ?)
    ON CONFLICT(discord_user_id) DO NOTHING`).bind(user.id, user.username, user.email.toLowerCase()).run();
  return env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(user.id).first();
}

export async function coordinated(env, memberID, operation, input = {}) {
  const result = await env.MEMBERS.get(env.MEMBERS.idFromName(memberID)).execute({ member_id: memberID, operation, input });
  if (!result.ok) {
    const error = new HttpError(result.status, result.error, result.retry_after);
    error.errorId = result.error_id;
    throw error;
  }
  return result.value;
}
