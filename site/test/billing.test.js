import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addWaiver, call, insertMember, mockFetch, quiet, readMember, resetDB, session, stripeEvent } from './helpers.js';

const discordID = '333333333333333333';
const stripeAPI = 'https://api.stripe.com/v1';
const roleURL = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordID}/roles/${env.DISCORD_ROLE_ID}`;
const monthly = { id: 'price_monthly', type: 'recurring', recurring: { interval: 'month', interval_count: 1 }, product: 'prod_member' };
const list = data => ({ data, has_more: false });

describe('Checkout', () => {
  let member, cookie;
  beforeEach(async () => {
    await resetDB();
    member = await insertMember({ discord_user_id: discordID, discord_username: 'maker', discord_email: 'maker@example.com' });
    cookie = await session(discordID);
  });
  afterEach(() => vi.restoreAllMocks());

  it('signs visitors in, then sends unsigned members to the waiver', async () => {
    mockFetch();
    let response = await call('/checkout');
    expect(response.headers.get('Location')).toBe('/login?next=%2Fcheckout');
    response = await call('/checkout', { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/waiver`);
  });

  it('creates a Checkout session for the member with their email and saved pricing', async () => {
    await addWaiver(member.member_id);
    await env.DB.prepare("UPDATE members SET discount_type = 'student' WHERE member_id = ?").bind(member.member_id).run();
    const calls = mockFetch([
      ['GET', /\/v1\/prices\?/, list([monthly])],
      ['GET', /\/v1\/coupons\?/, list([
        { id: 'other', valid: true, metadata: { discountTypes: 'military' } },
        { id: 'student', valid: true, metadata: { discountTypes: 'Retired, Student' }, applies_to: { products: ['prod_member'] } },
      ])],
      ['POST', `${stripeAPI}/customers`, { id: 'cus_new' }],
      ['GET', /\/v1\/checkout\/sessions\?/, list([])],
      ['GET', /\/v1\/subscriptions\?/, list([])],
      ['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_1' }],
    ]);
    const response = await call('/checkout', { headers: { Cookie: cookie } });
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_1');
    expect(new URL(calls.find(c => c.url.includes('/prices?')).url).searchParams.get('lookup_keys[]')).toBe('monthly');
    expect(new URLSearchParams(calls.find(c => c.url === `${stripeAPI}/customers`).body).get('email')).toBe('maker@example.com');
    expect(Object.fromEntries(new URLSearchParams(calls.at(-1).body))).toEqual({
      mode: 'subscription', customer: 'cus_new', 'customer_update[name]': 'auto', client_reference_id: member.member_id,
      success_url: `${env.SITE_URL}/welcome`, cancel_url: `${env.SITE_URL}/#membership`,
      'line_items[0][price]': 'price_monthly', 'line_items[0][quantity]': '1', 'payment_method_types[0]': 'card',
      'metadata[thelab_member_id]': member.member_id, 'subscription_data[metadata][thelab_member_id]': member.member_id,
      'metadata[thelab_price_id]': 'price_monthly', 'metadata[thelab_coupon_id]': 'student',
      'discounts[0][coupon]': 'student',
    });
  });

  it('reuses an existing customer and opens the billing portal for ongoing subscriptions', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1', legacy_waiver_signed = 1 WHERE member_id = ?").bind(member.member_id).run();
    let calls = mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, list([])],
      ['GET', /\/v1\/subscriptions\?/, list([{ id: 'sub_old', status: 'canceled' }])],
      ['GET', /\/v1\/prices\?/, list([monthly])],
      ['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_2' }],
    ]);
    await call('/checkout', { headers: { Cookie: cookie } });
    expect(new URLSearchParams(calls.at(-1).body).get('customer')).toBe('cus_1');
    expect(new URLSearchParams(calls.at(-1).body).has('customer_email')).toBe(false);
    vi.restoreAllMocks();
    calls = mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, list([])],
      ['GET', /\/v1\/subscriptions\?/, list([{ id: 'sub_1', status: 'past_due' }])],
      ['POST', `${stripeAPI}/billing_portal/sessions`, { url: 'https://billing.stripe.com/p/session_1' }],
    ]);
    const response = await call('/checkout', { headers: { Cookie: cookie } });
    expect(response.headers.get('Location')).toBe('https://billing.stripe.com/p/session_1');
  });

  it('shows a readable error when no price is configured', async () => {
    quiet();
    await addWaiver(member.member_id);
    mockFetch([['GET', /\/v1\/checkout\/sessions\?/, list([])], ['GET', /\/v1\/prices\?/, list([])]]);
    const response = await call('/checkout', { headers: { Cookie: cookie } });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('Membership checkout is temporarily unavailable');
  });

  it('reuses the membership price for later checkouts', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1', legacy_waiver_signed = 1 WHERE member_id = ?").bind(member.member_id).run();
    const calls = mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, list([])],
      ['GET', /\/v1\/subscriptions\?/, list([])],
      ['GET', /\/v1\/prices\?/, list([monthly])],
      ['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_1' }],
    ]);
    await call('/checkout', { headers: { Cookie: cookie } });
    await call('/checkout', { headers: { Cookie: cookie } });
    expect(calls.filter(c => c.url.includes('/prices?'))).toHaveLength(1);
  });

  it('reuses an unfinished checkout so returning members cannot start a second payment', async () => {
    await addWaiver(member.member_id);
    const sessions = [];
    const calls = mockFetch([
      ['POST', `${stripeAPI}/customers`, { id: 'cus_pending' }],
      ['GET', /\/v1\/subscriptions\?/, list([])],
      ['GET', /\/v1\/checkout\/sessions\?/, () => list(sessions)],
      ['GET', /\/v1\/prices\?/, list([monthly])],
      ['POST', `${stripeAPI}/checkout/sessions`, (_url, init) => {
        const form = new URLSearchParams(init.body);
        const session = { id: `cs_${sessions.length + 1}`, url: `https://checkout.stripe.com/c/pay/cs_${sessions.length + 1}`,
          status: 'open', mode: 'subscription', client_reference_id: form.get('client_reference_id'),
          metadata: Object.fromEntries([...form].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])) };
        sessions.push(session);
        return session;
      }],
    ]);
    const first = await call('/checkout', { headers: { Cookie: cookie } });
    const again = await call('/checkout', { headers: { Cookie: cookie } });
    expect(first.status).toBe(303);
    expect(again.headers.get('Location')).toBe(first.headers.get('Location'));
    expect(sessions).toHaveLength(1);
    expect((await readMember(member.member_id)).stripe_customer_id).toBe('cus_pending');
    expect(calls.filter(c => c.method === 'POST' && c.url === `${stripeAPI}/checkout/sessions`)).toHaveLength(1);
  });
});

describe('Stripe webhooks', () => {
  let member;
  const sync = ({ subscriptions = [{ id: 'sub_1', status: 'active', created: 2 }], role = {} } = {}) => mockFetch([
    ['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1', name: 'Billing Name', email: 'billing@example.com' }],
    ['GET', /\/v1\/subscriptions\?customer=cus_1/, list(subscriptions)],
    ['PUT', roleURL, new Response(null, { status: 204 })],
    ['DELETE', roleURL, role.delete ?? new Response(null, { status: 204 })],
  ]);
  beforeEach(async () => {
    await resetDB();
    member = await insertMember({ discord_user_id: discordID });
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects unsigned or wrongly signed events', async () => {
    quiet();
    const calls = mockFetch();
    const event = { type: 'customer.updated', data: { object: { id: 'cus_1' } } };
    expect((await call('/webhooks/stripe', { ...(await stripeEvent(event)), headers: {} })).status).toBe(400);
    expect((await call('/webhooks/stripe', await stripeEvent(event, 'whsec_other'))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('links a completed checkout to its member and grants the Discord role', async () => {
    const calls = sync({ subscriptions: [{ id: 'sub_old', status: 'canceled', created: 1 }, { id: 'sub_1', status: 'active', created: 2 }] });
    const response = await call('/webhooks/stripe', await stripeEvent({
      type: 'checkout.session.completed', data: { object: { customer: 'cus_1', client_reference_id: member.member_id } },
    }));
    expect(response.status).toBe(204);
    expect(await readMember(member.member_id)).toMatchObject({
      stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1', stripe_subscription_state: 'active',
      billing_name: 'Billing Name', billing_email: 'billing@example.com',
    });
    expect(calls.map(c => `${c.method} ${c.url.split('?')[0]}`)).toContain(`PUT ${roleURL}`);
  });

  it('revokes the role when a subscription ends, even if the member left Discord', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1', stripe_subscription_state = 'active' WHERE member_id = ?").bind(member.member_id).run();
    const calls = sync({ subscriptions: [{ id: 'sub_1', status: 'canceled', created: 2 }], role: { delete: new Response('{}', { status: 404 }) } });
    const response = await call('/webhooks/stripe', await stripeEvent({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }));
    expect(response.status).toBe(204);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_subscription_state: 'canceled' });
    expect(calls.at(-1).method).toBe('DELETE');
    const event = await env.DB.prepare("SELECT details FROM member_events WHERE event_type = 'SubscriptionStatusChanged' ORDER BY id DESC").first();
    expect(event).toEqual({ details: '{"from":"active","to":"canceled"}' });
  });

  it('fails the delivery so Stripe retries when synchronization fails', async () => {
    quiet();
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?").bind(member.member_id).run();
    mockFetch([
      ['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
      ['GET', /\/v1\/subscriptions\?/, list([{ id: 'sub_1', status: 'active' }])],
      ['PUT', roleURL, new Response('{}', { status: 500 })],
    ]);
    const response = await call('/webhooks/stripe', await stripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Discord is temporarily unavailable. Please try again.' });
  });

  it('skips the role grant for members who left Discord, but not other Discord 404s', async () => {
    quiet();
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?").bind(member.member_id).run();
    const deliver = async code => {
      vi.restoreAllMocks();
      quiet();
      mockFetch([
        ['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
        ['GET', /\/v1\/subscriptions\?/, list([{ id: 'sub_1', status: 'active' }])],
        ['PUT', roleURL, Response.json({ message: 'Unknown', code }, { status: 404 })],
      ]);
      return (await call('/webhooks/stripe', await stripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } }))).status;
    };
    expect(await deliver(10007)).toBe(204);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_subscription_state: 'active' });
    expect(await deliver(10011)).toBe(502);
  });

  it('acknowledges unmapped customers and unrelated events without calling providers', async () => {
    const calls = mockFetch();
    for (const event of [
      { type: 'customer.subscription.updated', data: { object: { customer: 'cus_unknown' } } },
      { type: 'invoice.paid', data: { object: { customer: 'cus_1' } } },
      { type: 'checkout.session.completed', data: { object: { customer: 'cus_new', client_reference_id: 'not-a-member' } } },
    ]) expect((await call('/webhooks/stripe', await stripeEvent(event))).status).toBe(204);
    expect(calls).toHaveLength(0);
    expect((await readMember(member.member_id)).stripe_customer_id).toBeNull();
  });

  it('discards a sync for a customer that was replaced while Stripe was responding', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1'").run();
    const calls = mockFetch([
      ['GET', `${stripeAPI}/customers/cus_1`, async () => {
        await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_new', stripe_subscription_id = 'sub_new', stripe_subscription_state = 'canceled' WHERE member_id = ?")
          .bind(member.member_id).run();
        return { id: 'cus_1', name: 'Old customer' };
      }],
      ['GET', /\/v1\/subscriptions\?customer=cus_1/, list([{ id: 'sub_old', status: 'active' }])],
      ['PUT', roleURL, new Response(null, { status: 204 })],
    ]);
    const response = await call('/webhooks/stripe', await stripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } }));
    expect(response.status).toBe(204);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_customer_id: 'cus_new', stripe_subscription_id: 'sub_new', stripe_subscription_state: 'canceled' });
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('keeps a newer cancellation when an older Stripe lookup finishes late', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1', stripe_subscription_state = 'active'").run();
    let release, started;
    const waiting = new Promise(resolve => { started = resolve; });
    let status = 'active', lookups = 0;
    const calls = mockFetch([
      ['GET', `${stripeAPI}/customers/cus_1`, () => {
        if (lookups++ === 0) { started(); return new Promise(resolve => { release = resolve; }); }
        return { id: 'cus_1' };
      }],
      ['GET', /\/v1\/subscriptions\?customer=cus_1/, () => list([{ id: 'sub_1', status }])],
      ['PUT', roleURL, new Response(null, { status: 204 })],
      ['DELETE', roleURL, new Response(null, { status: 204 })],
    ]);
    const event = await stripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } });
    const older = call('/webhooks/stripe', event);
    await waiting;
    status = 'canceled';
    expect((await call('/webhooks/stripe', event)).status).toBe(204);
    release({ id: 'cus_1' });
    expect((await older).status).toBe(204);
    expect((await readMember(member.member_id)).stripe_subscription_state).toBe('canceled');
    expect(calls.some(c => c.method === 'PUT')).toBe(false);
  });

  it('repairs a late Discord role grant after a newer cancellation has revoked it', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1'").run();
    let release, started, granted = false, status = 'active';
    const waiting = new Promise(resolve => { started = resolve; });
    mockFetch([
      ['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
      ['GET', /\/v1\/subscriptions\?customer=cus_1/, () => list([{ id: 'sub_1', status }])],
      ['PUT', roleURL, () => {
        started();
        return new Promise(resolve => { release = () => { granted = true; resolve(new Response(null, { status: 204 })); }; });
      }],
      ['DELETE', roleURL, () => { granted = false; return new Response(null, { status: 204 }); }],
    ]);
    const event = await stripeEvent({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } });
    const older = call('/webhooks/stripe', event);
    await waiting;
    status = 'canceled';
    expect((await call('/webhooks/stripe', event)).status).toBe(204);
    release();
    expect((await older).status).toBe(204);
    expect((await readMember(member.member_id)).stripe_subscription_state).toBe('canceled');
    expect(granted).toBe(false);
  });
});
