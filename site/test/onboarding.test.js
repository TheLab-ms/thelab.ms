import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEventKey } from '../src/edge.js';
import { addWaiver, call, edgeEnv, insertMember, mockFetch, post, quiet, readMember, resetDB, session, stripeEvent } from './helpers.js';

const user = { id: '333333333333333333', username: 'new-maker', email: 'maker@example.com', verified: true };
const adminID = '444444444444444444';
const stripeAPI = 'https://api.stripe.com/v1';
const discordMember = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`;
const list = data => ({ data, has_more: false });
const request = (path, init) => call(path, init, edgeEnv);
const fields = { version: '2', agree_signature: 'on', agree_terms: 'on', name: 'New Maker', email: user.email, 'cf-turnstile-response': 'verified-token' };

// Stateful provider replies exercise the handoffs between real Worker routes
// and D1 migrations, including Stripe's idempotency and session lifecycle.
let customers, checkouts, subscriptions, roles, edge, calls;
function providers() {
  customers = [];
  checkouts = [];
  subscriptions = [];
  roles = new Set();
  edge = { fobs: [] };
  const saved = new Map();
  const create = make => (_url, init) => {
    const key = init.headers['Idempotency-Key'];
    const previous = key && saved.get(key);
    if (previous) {
      if (previous.body !== init.body) return Response.json({ error: { message: 'Idempotency parameters changed' } }, { status: 400 });
      return previous.result;
    }
    const result = make(new URLSearchParams(init.body));
    if (key) saved.set(key, { body: init.body, result: structuredClone(result) });
    return result;
  };
  calls = mockFetch([
    ['POST', 'https://discord.com/api/v10/oauth2/token', { access_token: 'access' }],
    ['GET', 'https://discord.com/api/v10/users/@me', user],
    ['GET', discordMember, () => ({ user, roles: [...roles] })],
    ['PUT', `${discordMember}/roles/${env.DISCORD_ROLE_ID}`, () => { roles.add(env.DISCORD_ROLE_ID); return new Response(null, { status: 204 }); }],
    ['DELETE', `${discordMember}/roles/${env.DISCORD_ROLE_ID}`, () => { roles.delete(env.DISCORD_ROLE_ID); return new Response(null, { status: 204 }); }],
    ['POST', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', { success: true, hostname: new URL(env.SITE_URL).hostname, action: 'waiver' }],
    ['PUT', `${edgeEnv.EDGE_URL}/api/fobs`, (_url, init) => { edge = JSON.parse(init.body); return new Response(null, { status: 204 }); }],
    ['GET', /\/v1\/prices\?/, url => {
      const annual = new URL(url).searchParams.get('lookup_keys[]') === 'yearly';
      return list([{ id: annual ? 'price_yearly' : 'price_monthly', type: 'recurring', product: 'prod_member', recurring: { interval: annual ? 'year' : 'month', interval_count: 1 } }]);
    }],
    ['GET', /\/v1\/coupons\?/, list([{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'student' } }])],
    ['POST', `${stripeAPI}/customers`, create(form => {
      const customer = { id: `cus_${customers.length + 1}`, email: form.get('email'), name: '' };
      customers.push(customer);
      return customer;
    })],
    ['GET', /\/v1\/customers\/cus_\d+$/, url => customers.find(customer => url.endsWith(`/${customer.id}`))],
    ['GET', /\/v1\/checkout\/sessions\?/, url => {
      const customer = new URL(url).searchParams.get('customer');
      return list(checkouts.filter(checkout => !customer || checkout.customer === customer));
    }],
    ['GET', /\/v1\/subscriptions\?/, url => list(subscriptions.filter(subscription => subscription.customer === new URL(url).searchParams.get('customer')))],
    ['POST', `${stripeAPI}/checkout/sessions`, create(form => {
      const checkout = { id: `cs_${checkouts.length + 1}`, url: `https://checkout.stripe.com/c/pay/cs_${checkouts.length + 1}`,
        customer: form.get('customer'), mode: form.get('mode'), status: 'open', client_reference_id: form.get('client_reference_id'),
        metadata: Object.fromEntries([...form].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])) };
      checkouts.push(checkout);
      return checkout;
    })],
    ['POST', /\/v1\/checkout\/sessions\/cs_\d+\/expire$/, url => {
      const checkout = checkouts.find(checkout => url.endsWith(`/${checkout.id}/expire`));
      if (checkout.status !== 'open') return Response.json({ error: { message: 'Session is not open' } }, { status: 400 });
      checkout.status = 'expired';
      return checkout;
    }],
    ['POST', `${stripeAPI}/billing_portal/sessions`, { url: 'https://billing.stripe.com/p/session_1' }],
  ]);
}

async function signIn(next = '/checkout') {
  const login = await request(`/login?next=${encodeURIComponent(next)}`);
  expect(login.status).toBe(303);
  const state = new URL(login.headers.get('Location')).searchParams.get('state');
  const callback = await request(`/login/callback?state=${state}&code=authorized`, {
    headers: { Cookie: login.headers.getSetCookie()[0].split(';')[0] },
  });
  expect(callback.status).toBe(303);
  expect(callback.headers.get('Location')).toBe(next);
  return callback.headers.getSetCookie().find(value => value.startsWith('thelab_session=')).split(';')[0];
}

function pay(checkout) {
  expect(checkout.status).toBe('open');
  checkout.status = 'complete';
  const subscription = { id: `sub_${subscriptions.length + 1}`, customer: checkout.customer, status: 'active', created: 1 };
  subscriptions.push(subscription);
  customers.find(customer => customer.id === checkout.customer).name = 'New Maker';
  return subscription;
}

async function deliver(type, object) {
  expect((await request('/webhooks/stripe', await stripeEvent({ type, data: { object } }))).status).toBe(204);
}

async function enroll(cookie, fob = 123) {
  const scan = await request('/kiosk/claims', { method: 'POST', body: JSON.stringify({ fob_id: fob }),
    headers: { Authorization: `Bearer ${await edgeEventKey(edgeEnv)}`, 'Content-Type': 'application/json' } });
  expect(scan.status).toBe(201);
  const claim = await scan.json();
  expect((await request(claim.url)).headers.get('Location')).toBe(`/login?next=${encodeURIComponent(`/keyfob/bind?token=${claim.token}`)}`);
  expect(await (await request(claim.url, { headers: { Cookie: cookie } })).text()).toContain('Link your fob');
  expect(await (await request(claim.url, post({}, { Cookie: cookie }))).text()).toContain(`Fob ${fob} is now linked`);
}

describe('Member onboarding across services', () => {
  beforeEach(async () => { await resetDB(); providers(); quiet(); });
  afterEach(() => vi.restoreAllMocks());

  it('walks signup, waiver, payment, fob enrollment, billing, and cancellation', async () => {
    expect((await request('/checkout')).headers.get('Location')).toBe('/login?next=%2Fcheckout');
    const cookie = await signIn();
    const headers = { Cookie: cookie };
    expect((await request('/checkout', { headers })).headers.get('Location')).toBe(`${env.SITE_URL}/waiver`);
    expect((await request('/machines/data', { headers })).status).toBe(403);
    expect((await request('/waiver/sign', post(fields, headers))).headers.get('Location')).toBe('/checkout');
    const checkout = await request('/checkout', { headers });
    expect(checkout.headers.get('Location')).toBe(checkouts[0].url);
    expect(customers).toHaveLength(1);
    const member = await env.DB.prepare('SELECT * FROM members').first();
    expect(member).toMatchObject({ discord_user_id: user.id, stripe_customer_id: customers[0].id, waiver_name: fields.name });

    // Linking a fob before paying must not grant access.
    await enroll(cookie);
    expect(edge.fobs).toEqual([]);
    expect((await request('/machines/data', { headers })).status).toBe(403);
    const subscription = pay(checkouts[0]);

    // Returning before Stripe delivers its webhooks must not start a new payment.
    expect((await request('/checkout', { headers })).headers.get('Location')).toBe('https://billing.stripe.com/p/session_1');
    expect(checkouts).toHaveLength(1);
    // Stripe can deliver subscription events before checkout completion.
    await deliver('customer.subscription.created', subscription);
    await deliver('checkout.session.completed', checkouts[0]);
    expect(roles.has(env.DISCORD_ROLE_ID)).toBe(true);
    expect(edge.fobs).toEqual([123]);
    expect((await request('/machines/data', { headers })).status).toBe(200);
    expect(await readMember(member.member_id)).toMatchObject({ stripe_subscription_state: 'active', billing_name: 'New Maker', fob_id: 123 });
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM member_events').first();
    await deliver('checkout.session.completed', checkouts[0]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM member_events').first()).toEqual(events);

    subscription.status = 'canceled';
    await deliver('customer.subscription.deleted', subscription);
    expect(roles.has(env.DISCORD_ROLE_ID)).toBe(false);
    expect(edge.fobs).toEqual([]);
    expect((await request('/machines/data', { headers })).status).toBe(403);
  });

  it('joins an admin-created, discounted membership after paying and signing the public waiver', async () => {
    const admin = { Cookie: await session(adminID, true) };
    const draft = { email: user.email, name_override: fields.name, billing: 'yearly', discount_type: 'student' };
    expect((await request('/admin/members/new', post(draft, admin))).status).toBe(303);
    let member = await env.DB.prepare('SELECT * FROM members').first();
    const edit = { ...draft, metadata_version: String(member.metadata_version), stripe_customer_id: '', discord_user_id: '', fob_id: '', notes: 'Keep this draft' };
    const shared = await request(`/admin/members/${member.member_id}/checkout`, post(edit, admin));
    expect(shared.status).toBe(200);
    const html = await shared.text();
    member = await readMember(member.member_id);
    expect(html).toContain(`value="${checkouts[0].url}"`);
    expect(html).toContain(`name="metadata_version" value="${member.metadata_version}"`);
    expect(html).toContain(`name="stripe_customer_id" type="text" value="${member.stripe_customer_id}"`);
    expect(html).toContain('Keep this draft');
    expect(checkouts[0].metadata).toMatchObject({ thelab_price_id: 'price_yearly', thelab_coupon_id: 'coupon_student' });
    expect((await request(`/admin/members/${member.member_id}`, post({ ...edit, metadata_version: member.metadata_version, stripe_customer_id: member.stripe_customer_id }, admin))).status).toBe(303);

    pay(checkouts[0]);
    await deliver('checkout.session.completed', checkouts[0]);
    expect(roles.has(env.DISCORD_ROLE_ID)).toBe(false);
    expect((await request('/waiver/sign', post(fields))).status).toBe(200);
    const cookie = await signIn();
    expect(roles.has(env.DISCORD_ROLE_ID)).toBe(true);
    expect(await readMember(member.member_id)).toMatchObject({ discord_user_id: user.id, stripe_subscription_state: 'active', bill_annually: 1, discount_type: 'student' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first()).n).toBe(1);
    expect((await env.DB.prepare('SELECT member_id FROM waivers').first()).member_id).toBe(member.member_id);
    await enroll(cookie, 456);
    expect(edge.fobs).toEqual([456]);
  });

  it('expires superseded pricing and permits a fresh checkout after expiration', async () => {
    const member = await insertMember({ discord_user_id: user.id, email: user.email });
    await addWaiver(member.member_id);
    const headers = { Cookie: await session(user.id) };
    expect((await request('/checkout', { headers })).status).toBe(303);
    const current = await readMember(member.member_id);
    const response = await request(`/admin/members/${member.member_id}/checkout`, post({
      metadata_version: current.metadata_version, billing: 'yearly', discount_type: 'student', stripe_customer_id: current.stripe_customer_id,
    }, { Cookie: await session(adminID, true) }));
    expect(response.status).toBe(200);
    expect(checkouts.map(checkout => checkout.status)).toEqual(['expired', 'open']);
    expect(checkouts[1].metadata).toMatchObject({ thelab_price_id: 'price_yearly', thelab_coupon_id: 'coupon_student' });
    expect((await request('/checkout', { headers })).headers.get('Location')).toBe(checkouts[1].url);
    checkouts[1].status = 'expired';
    expect((await request('/checkout', { headers })).headers.get('Location')).toBe(checkouts[2].url);
    expect(customers).toHaveLength(1);
    expect(checkouts.map(checkout => checkout.status)).toEqual(['expired', 'expired', 'open']);
  });

  it('creates only one billable session when checkout requests arrive together', async () => {
    const member = await insertMember({ discord_user_id: user.id, email: user.email });
    await addWaiver(member.member_id);
    const headers = { Cookie: await session(user.id) };
    const responses = await Promise.all(Array.from({ length: 6 }, () => request('/checkout', { headers })));
    expect(responses.map(response => response.status)).toEqual(Array(6).fill(303));
    expect(new Set(responses.map(response => response.headers.get('Location')))).toEqual(new Set([checkouts[0].url]));
    expect(customers).toHaveLength(1);
    expect(checkouts).toHaveLength(1);
    expect(calls.filter(call => call.url === `${stripeAPI}/checkout/sessions`).every(call => call.init.headers['Idempotency-Key'])).toBe(true);
  });

  it.each(['open', 'complete'])('handles a previously issued checkout with status %s', async status => {
    const member = await insertMember({ discord_user_id: user.id, email: user.email });
    await addWaiver(member.member_id);
    const previous = { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', mode: 'subscription', status,
      customer: status === 'complete' ? 'cus_1' : null, client_reference_id: member.member_id, metadata: { thelab_member_id: member.member_id } };
    checkouts.push(previous);
    if (status === 'complete') {
      customers.push({ id: 'cus_1', email: user.email, name: 'Maker' });
      subscriptions.push({ id: 'sub_1', customer: 'cus_1', status: 'active' });
    }
    const response = await request('/checkout', { headers: { Cookie: await session(user.id) } });
    expect(response.status).toBe(303);
    expect(customers).toHaveLength(1);
    if (status === 'open') {
      expect(previous.status).toBe('expired');
      expect(checkouts).toHaveLength(2);
      expect(response.headers.get('Location')).toBe(checkouts[1].url);
    } else {
      expect(checkouts).toHaveLength(1);
      expect(response.headers.get('Location')).toBe('https://billing.stripe.com/p/session_1');
    }
    expect((await readMember(member.member_id)).stripe_customer_id).toBe('cus_1');
  });
});
