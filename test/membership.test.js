import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { processMessage } from '../src/index.js';
import { coordinated } from '../src/membership.js';
import { hash, now } from '../src/http.js';

// Global fetch spies also apply inside the bound Durable Object in this runtime.
// Every unexpected provider request fails; no tests can reach live services.
let interceptors;
const fetchMock = {
  activate() {
    interceptors = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      const path = url.pathname + url.search;
      const mock = interceptors.find(item => item.remaining > 0 && item.origin === url.origin && item.method === (init.method || 'GET') && (typeof item.path === 'string' ? item.path === path : item.path.test(path)));
      if (!mock) throw new Error(`Unexpected provider request: ${init.method || 'GET'} ${url}`);
      mock.remaining--;
      const data = typeof mock.data === 'function' ? await mock.data(init) : mock.data;
      return new Response(mock.status === 204 ? null : JSON.stringify(data), { status: mock.status, headers: mock.headers });
    });
  },
  get(origin) {
    return { intercept({ path, method }) {
      return { reply(status, data, options = {}) {
        const mock = { origin, path, method, status, data, headers: options.headers, remaining: 1 };
        interceptors.push(mock);
        return { times(count) { mock.remaining = count; } };
      } };
    } };
  },
  assertNoPendingInterceptors() {
    expect(interceptors.filter(item => item.remaining).map(item => `${item.method} ${item.path}`)).toEqual([]);
  },
};

const id = '333333333333333333';
const user = { id, username: 'maker', email: 'maker@example.com' };
const customer = 'cus_member';
const api = (path, options, bindings = env) => worker.fetch(new Request(`${env.SITE_URL}${path}`, options), bindings);
const readMember = () => env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(id).first();
const checkout = (input = {}) => coordinated(env, id, '/checkout', { user, annual: false, discount: '', ...input });
const subscription = (status = 'active', subID = 'sub_member') => ({ id: subID, customer, status, created: now(), metadata: { thelab_discord_id: id } });

function mockStripe(path, data, options = {}) {
  return fetchMock.get('https://api.stripe.com').intercept({ path: typeof path === 'string' ? `/v1${path}` : path, method: options.method || 'GET' })
    .reply(options.status || 200, data, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
}

function mockDiscord(path, data = {}, method = 'GET', status = 200, headers = {}) {
  return fetchMock.get('https://discord.com').intercept({ path: `/api/v10${path}`, method })
    .reply(status, data, { headers: { 'Content-Type': 'application/json', ...headers } });
}

function mockSubs(subscriptions = []) {
  return mockStripe(/^\/v1\/subscriptions\?/, { data: subscriptions, has_more: false });
}

function mockPrice(annual = false) {
  return mockStripe(/^\/v1\/prices\?/, { data: [{ id: annual ? 'price_yearly' : 'price_monthly', product: 'prod_membership', type: 'recurring', recurring: { interval: annual ? 'year' : 'month', interval_count: 1 } }], has_more: false });
}

async function seed(extra = {}) {
  await env.DB.prepare('INSERT INTO members (discord_user_id, discord_username, discord_email, stripe_customer_id) VALUES (?, ?, ?, ?)')
    .bind(id, user.username, user.email, customer).run();
  for (const [key, value] of Object.entries(extra)) await env.DB.prepare(`UPDATE members SET ${key} = ? WHERE discord_user_id = ?`).bind(value, id).run();
}

async function loginCookie() {
  const token = 'a'.repeat(64);
  await env.DB.prepare('INSERT INTO sessions (token_hash, discord_user_id, expires) VALUES (?, ?, ?)').bind(await hash(token), id, now() + 3600).run();
  return `thelab_session=${token}`;
}

async function start(query = '') {
  const response = await api(`/signup${query}`);
  expect(response.status).toBe(303);
  const target = new URL(response.headers.get('Location'));
  return { target, state: target.searchParams.get('state'), cookie: response.headers.get('Set-Cookie').split(';')[0] };
}

function oauthMock({ verified = true, guildStatus = 200 } = {}) {
  mockDiscord('/oauth2/token', { access_token: 'access-token', token_type: 'Bearer' }, 'POST');
  mockDiscord('/users/@me', { ...user, verified });
  if (verified) mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}`, { user }, 'GET', guildStatus);
}

async function signedEvent(type = 'customer.subscription.updated', eventID = 'evt_update') {
  const payload = JSON.stringify({ id: eventID, type, data: { object: subscription() } });
  const timestamp = now();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${payload}`))), n => n.toString(16).padStart(2, '0')).join('');
  return { method: 'POST', body: payload, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` } };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fetchMock.activate();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
  vi.restoreAllMocks();
});

describe('Discord signup', () => {
  it('uses identify/email and binds the pricing choice to a one-use browser state', async () => {
    const { target, state, cookie } = await start('?billing=yearly&discount=student');
    expect(target.origin).toBe('https://discord.com');
    expect(target.searchParams.get('scope')).toBe('identify email');
    expect(target.searchParams.get('redirect_uri')).toBe(`${env.SITE_URL}/login/discord/callback`);
    expect((await api(`/login/discord/callback?code=hello&state=${state}`)).status).toBe(400);
    oauthMock();
    const response = await api(`/login/discord/callback?code=hello&state=${state}&discount=`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/membership-pending`);
    expect(response.headers.get('Set-Cookie')).toContain('HttpOnly; SameSite=Lax');
    expect(await readMember()).toMatchObject({ bill_annually: 1, discount_type: 'student', discount_status: 'requested', stripe_customer_id: null });
    expect((await api(`/login/discord/callback?code=hello&state=${state}`, { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it('rejects expired, duplicate, or declined OAuth state before contacting Discord', async () => {
    const { state, cookie } = await start();
    expect((await api(`/login/discord/callback?state=${state}&state=${state}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400);
    await env.DB.prepare('UPDATE oauth_states SET expires = 0').run();
    expect((await api(`/login/discord/callback?state=${state}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400);
    const next = await start();
    expect((await api(`/login/discord/callback?state=${next.state}&error=access_denied`, { headers: { Cookie: next.cookie } })).status).toBe(400);
    expect(await readMember()).toBeNull();
  });

  it.each([{ verified: false, guildStatus: 200 }, { verified: true, guildStatus: 404 }])('requires verified email and existing guild membership: %j', async (settings) => {
    const { state, cookie } = await start();
    oauthMock(settings);
    const response = await api(`/login/discord/callback?state=${state}&code=hello`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(403);
    expect(await readMember()).toBeNull();
  });

  it('redirects a standard signup directly to Stripe and persists stable ownership', async () => {
    const { state, cookie } = await start();
    oauthMock();
    mockPrice();
    let customerForm, checkoutForm;
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/customers', method: 'POST' }).reply(200, options => {
      customerForm = new URLSearchParams(options.body);
      return { id: customer };
    });
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
      checkoutForm = new URLSearchParams(options.body);
      return { id: 'cs_member', url: 'https://checkout.stripe.com/c/pay/test' };
    });
    const response = await api(`/login/discord/callback?state=${state}&code=hello`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/test');
    expect(customerForm.get('metadata[thelab_discord_id]')).toBe(id);
    expect(checkoutForm.get('subscription_data[metadata][thelab_discord_id]')).toBe(id);
    expect(checkoutForm.get('mode')).toBe('subscription');
    expect(checkoutForm.get('line_items[0][price]')).toBe('price_monthly');
    expect(checkoutForm.get('success_url')).toContain('/payment/success?session_id={CHECKOUT_SESSION_ID}');
    expect(await readMember()).toMatchObject({ stripe_customer_id: customer });
  });

  it('resumes the saved approved selection instead of resetting it to full price', async () => {
    await seed({ bill_annually: 1, discount_type: 'family', discount_status: 'approved' });
    const response = await api('/payment/resume', { headers: { Cookie: await loginCookie() } });
    expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/signup?billing=yearly&discount=family`);
  });
});

describe('billing safeguards', () => {
  it('blocks checkout when the configured recurring price is missing', async () => {
    await seed(); mockSubs();
    mockStripe(/^\/v1\/prices\?/, { data: [], has_more: false });
    await expect(checkout()).rejects.toThrow('price is not configured');
  });

  it('uses Conway coupon metadata for manually approved annual discounts', async () => {
    await seed({ discount_type: 'student', discount_status: 'approved' });
    mockSubs();
    mockPrice(true);
    mockStripe(/^\/v1\/coupons\?/, { data: [{ id: 'coupon_student', valid: true, metadata: { discountTypes: 'Military, STUDENT' } }], has_more: false });
    let form;
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
      form = new URLSearchParams(options.body);
      return { id: 'cs_discount', url: 'https://checkout.stripe.com/c/pay/discount' };
    });
    expect((await checkout({ annual: true, discount: 'student' })).url).toContain('checkout.stripe.com');
    expect(form.get('discounts[0][coupon]')).toBe('coupon_student');
    expect(form.get('line_items[0][price]')).toBe('price_yearly');
  });

  it('does not charge full price when an approved coupon is missing', async () => {
    await seed({ discount_type: 'family', discount_status: 'approved' });
    mockSubs(); mockPrice();
    mockStripe(/^\/v1\/coupons\?/, { data: [], has_more: false });
    await expect(checkout({ discount: 'family' })).rejects.toThrow('no valid Stripe coupon');
  });

  it('does not allow a new category to inherit an old discount approval', async () => {
    await seed({ discount_type: 'student', discount_status: 'approved' });
    mockSubs();
    expect((await checkout({ discount: 'family' })).url).toContain('membership-pending');
    expect(await readMember()).toMatchObject({ discount_type: 'family', discount_status: 'requested' });
  });

  it('preserves a declined request and permits an explicit standard-rate choice', async () => {
    await seed({ discount_type: 'student', discount_status: 'denied' });
    mockSubs();
    await expect(checkout({ discount: 'student' })).rejects.toThrow('declined');
    mockSubs(); mockPrice();
    mockStripe('/checkout/sessions', { id: 'cs_standard', url: 'https://checkout.stripe.com/c/pay/standard' }, { method: 'POST' });
    await checkout();
    expect(await readMember()).toMatchObject({ discount_type: '', discount_status: '' });
  });

  it('serializes concurrent checkout requests and reuses the open session', async () => {
    await seed();
    mockSubs().times(2); mockPrice().times(2);
    mockStripe('/checkout/sessions', { id: 'cs_one', url: 'https://checkout.stripe.com/c/pay/one' }, { method: 'POST' });
    mockStripe('/checkout/sessions/cs_one', { id: 'cs_one', status: 'open', url: 'https://checkout.stripe.com/c/pay/one' });
    const results = await Promise.all([checkout(), checkout()]);
    expect(results[0]).toEqual(results[1]);
  });

  it('retries an ambiguous Stripe write with the original idempotency key', async () => {
    await seed();
    mockSubs(); mockPrice();
    let firstKey, retryKey;
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(500, options => {
      firstKey = new Headers(options.headers).get('Idempotency-Key');
      return {};
    });
    await expect(checkout()).rejects.toThrow('HTTP 500');
    mockSubs(); mockPrice();
    fetchMock.get('https://api.stripe.com').intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(200, options => {
      retryKey = new Headers(options.headers).get('Idempotency-Key');
      return { id: 'cs_retry', url: 'https://checkout.stripe.com/c/pay/retry' };
    });
    mockStripe('/checkout/sessions/cs_retry', { id: 'cs_retry', status: 'open', url: 'https://checkout.stripe.com/c/pay/retry' });
    await checkout();
    expect(firstKey).toBeTruthy();
    expect(retryKey).toBe(firstKey);
  });

  it('does not replay an ambiguous write after Stripe idempotency expires', async () => {
    await seed();
    const stub = env.MEMBERS.get(env.MEMBERS.idFromName(id));
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('checkout', { key: 'old', path: '/checkout/sessions', form: {}, created: now() - 86400 });
    });
    mockSubs();
    await expect(checkout()).rejects.toThrow('needs review');
  });

  it('expires a previous payment link before accepting a pending discount', async () => {
    await seed(); mockSubs(); mockPrice();
    mockStripe('/checkout/sessions', { id: 'cs_old', url: 'https://checkout.stripe.com/c/pay/old' }, { method: 'POST' });
    await checkout();
    mockSubs();
    mockStripe('/checkout/sessions/cs_old', { id: 'cs_old', status: 'open' });
    mockStripe('/checkout/sessions/cs_old/expire', { id: 'cs_old', status: 'expired' }, { method: 'POST' });
    expect((await checkout({ discount: 'student' })).url).toContain('membership-pending');
  });

  it('does not issue a second checkout if payment wins a race against session expiry', async () => {
    await seed(); mockSubs(); mockPrice();
    mockStripe('/checkout/sessions', { id: 'cs_race', url: 'https://checkout.stripe.com/c/pay/race' }, { method: 'POST' });
    await checkout();
    mockSubs();
    mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'open' });
    mockStripe('/checkout/sessions/cs_race/expire', {}, { method: 'POST', status: 400 });
    mockStripe('/checkout/sessions/cs_race', { id: 'cs_race', status: 'complete', subscription: 'sub_member' });
    await expect(checkout({ annual: true })).rejects.toThrow('HTTP 400');
    expect(await readMember()).toMatchObject({ bill_annually: 0 });
  });

  it('sends an existing past-due subscriber to the portal rather than charging again', async () => {
    await seed(); mockSubs([subscription('past_due')]);
    mockStripe('/billing_portal/sessions', { url: 'https://billing.stripe.com/p/session/test' }, { method: 'POST' });
    expect((await checkout()).url).toContain('billing.stripe.com');
  });

  it('allows rejoining after a completed checkout subscription was canceled', async () => {
    await seed(); mockSubs(); mockPrice();
    mockStripe('/checkout/sessions', { id: 'cs_old', url: 'https://checkout.stripe.com/c/pay/old' }, { method: 'POST' });
    await checkout();
    mockSubs([subscription('canceled')]).times(2);
    mockStripe('/checkout/sessions/cs_old', { id: 'cs_old', status: 'complete', subscription: 'sub_member' });
    mockPrice();
    mockStripe('/checkout/sessions', { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/new' }, { method: 'POST' });
    expect((await checkout()).url).toContain('/new');
  });
});

describe('payment confirmation', () => {
  it.each(['unpaid', 'paid'])('checks payment status before showing welcome (%s)', async paymentStatus => {
    await seed();
    const cookie = await loginCookie();
    mockStripe('/checkout/sessions/cs_member', { mode: 'subscription', customer, client_reference_id: id, metadata: { thelab_discord_id: id }, status: 'complete', payment_status: paymentStatus, subscription: 'sub_member' });
    const send = vi.fn().mockResolvedValue(undefined);
    if (paymentStatus === 'paid') mockStripe('/subscriptions/sub_member', subscription());
    const response = await api('/payment/success?session_id=cs_member', { headers: { Cookie: cookie } }, { ...env, MEMBERSHIP_QUEUE: { send } });
    expect(response.status).toBe(paymentStatus === 'paid' ? 303 : 409);
    if (paymentStatus === 'paid') expect(response.headers.get('Location')).toBe(`${env.SITE_URL}/welcome`);
    expect(send).toHaveBeenCalledTimes(paymentStatus === 'paid' ? 1 : 0);
  });

  it('rejects a checkout belonging to another Discord identity', async () => {
    await seed();
    mockStripe('/checkout/sessions/cs_other', { mode: 'subscription', customer, client_reference_id: '444444444444444444', status: 'complete', payment_status: 'paid' });
    expect((await api('/payment/success?session_id=cs_other', { headers: { Cookie: await loginCookie() } })).status).toBe(403);
  });
});

describe('webhooks and queued Discord reconciliation', () => {
  it('rejects a tampered signed event and ignores valid unrelated event types', async () => {
    const send = vi.fn();
    const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
    const signed = await signedEvent();
    signed.body = signed.body.replace('cus_member', 'cus_attacker');
    expect((await api('/webhooks/stripe', signed, bindings)).status).toBe(400);
    expect((await api('/webhooks/stripe', await signedEvent('payment_intent.succeeded'), bindings)).status).toBe(204);
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects unsigned and stale webhooks without queueing', async () => {
    const send = vi.fn();
    const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
    expect((await api('/webhooks/stripe', { method: 'POST', body: '{}' }, bindings)).status).toBe(400);
    expect((await api('/webhooks/stripe', { method: 'POST', body: '{}', headers: { 'Stripe-Signature': 't=1,v1=' + '0'.repeat(64) } }, bindings)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('acknowledges Stripe only after a successful queue send, including redelivery', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined);
    const bindings = { ...env, MEMBERSHIP_QUEUE: { send } };
    expect((await api('/webhooks/stripe', await signedEvent(), bindings)).status).toBe(500);
    expect((await api('/webhooks/stripe', await signedEvent(), bindings)).status).toBe(204);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ event_id: 'evt_update', customer_id: customer });
  });

  it('deduplicates successful events but fetches current state for delayed cancellation events', async () => {
    await seed();
    mockSubs([subscription('active', 'sub_replacement'), subscription('canceled', 'sub_old')]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
    await processMessage({ customer_id: customer, event_id: 'evt_oldCancellation' }, env);
    expect(await readMember()).toMatchObject({ stripe_subscription_id: 'sub_replacement', stripe_subscription_state: 'active' });
    await processMessage({ customer_id: customer, event_id: 'evt_oldCancellation' }, env);
    mockSubs([subscription('canceled', 'sub_replacement')]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
    await processMessage({ customer_id: customer, event_id: 'evt_finalCancellation' }, env);
    expect(await readMember()).toMatchObject({ stripe_subscription_state: 'canceled' });
  });

  it('retains the role through cancel-at-period-end and removes it for past-due state', async () => {
    await seed();
    mockSubs([{ ...subscription(), cancel_at_period_end: true }]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
    await processMessage({ customer_id: customer }, env);
    mockSubs([subscription('past_due')]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
    await processMessage({ customer_id: customer }, env);
  });

  it('retries Discord rate limits without marking the event processed', async () => {
    await seed();
    mockSubs([subscription()]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, { retry_after: 120 }, 'PUT', 429);
    const message = { id: 'queue-message', body: { customer_id: customer, event_id: 'evt_retry' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] }, env);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(await env.DB.prepare('SELECT id FROM stripe_events WHERE id = ?').bind('evt_retry').first()).toBeNull();
    mockSubs([subscription()]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'PUT', 204);
    await worker.queue({ messages: [{ ...message, attempts: 2 }] }, env);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(await env.DB.prepare('SELECT id FROM stripe_events WHERE id = ?').bind('evt_retry').first()).not.toBeNull();
  });

  it('ignores unrelated customers and unrelated subscriptions on a mapped customer', async () => {
    await processMessage({ customer_id: 'cus_unrelated', event_id: 'evt_other' }, env);
    await seed();
    mockSubs([{ ...subscription(), metadata: {} }]);
    mockDiscord(`/guilds/${env.DISCORD_GUILD_ID}/members/${id}/roles/${env.DISCORD_ROLE_ID}`, {}, 'DELETE', 204);
    await processMessage({ customer_id: customer }, env);
    expect(await readMember()).toMatchObject({ stripe_subscription_state: null });
  });
});

describe('deployed asset routing', () => {
  it('serves static welcome/pending pages and routes signup navigation through the Worker', async () => {
    for (const path of ['/welcome', '/membership-pending']) {
      const response = await SELF.fetch(`${env.SITE_URL}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('/membership.css');
    }
    const response = await SELF.fetch(`${env.SITE_URL}/signup`, { headers: { 'Sec-Fetch-Mode': 'navigate' }, redirect: 'manual' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toContain('discord.com/oauth2/authorize');
  });
});
