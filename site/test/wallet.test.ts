import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { walletCookie, type Member } from '../src/lib.ts';
import { call, insertMember, mockFetch, post, quiet, readMember, resetDB, session, stripeEvent } from './helpers.ts';

const discordID = '333333333333333333';
const stripeAPI = 'https://api.stripe.com/v1';
const roleURL = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordID}/roles/${env.DISCORD_ROLE_ID}`;
const list = (data: unknown[]) => ({ data, has_more: false });
const key = 'a'.repeat(64);

const walletSession = async (id = discordID) => (await walletCookie(env, id)).split(';')[0]!;
const cookieFrom = (response: Response) => (response.headers.get('Set-Cookie') || '').split(';')[0]!;
const balance = async (memberID: string) =>
  (await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_entries WHERE member_id = ?')
    .bind(memberID).first<{ n: number }>())?.n ?? 0;
const credit = (memberID: string, cents: number, id = 'seed') =>
  env.DB.prepare(`INSERT INTO wallet_entries (member_id, amount, key) VALUES (?, ?, ?)`).bind(memberID, cents, id).run();
const hiddenKey = (html: string) => html.match(/name="key" value="([a-f0-9]{64})"/)?.[1] ?? '';

describe('Wallet', () => {
  let member: Member;
  beforeEach(async () => {
    await resetDB();
    member = await insertMember({ discord_user_id: discordID, discord_username: 'maker', discord_email: 'maker@example.com' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('signs members in with a year-long wallet cookie', async () => {
    mockFetch();
    let response = await call('/wallet');
    expect(response.headers.get('Location')).toBe('/login?next=%2Fwallet');
    response = await call('/wallet', { headers: { Cookie: await session(discordID) } });
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('thelab_wallet=');
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=31536000');
    const html = await response.text();
    expect(html).toContain('Balance');
    expect(html).toContain('$0.00');
    // The wallet cookie alone works on a later visit.
    expect((await call('/wallet', { headers: { Cookie: cookieFrom(response) } })).status).toBe(200);
  });

  it('does not accept a wallet token as a site session', async () => {
    mockFetch();
    const response = await call('/admin', { headers: { Cookie: await walletSession() } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('/login?next=%2Fadmin');
  });

  it('refuses members who are not registered yet', async () => {
    quiet();
    mockFetch();
    const response = await call('/wallet', { headers: { Cookie: await walletSession('999999999999999999') } });
    expect(response.status).toBe(403);
  });

  it('creates a customer and a payment Checkout session for a top-up', async () => {
    const calls = mockFetch([
      ['POST', `${stripeAPI}/customers`, { id: 'cus_new' }],
      ['GET', /\/v1\/checkout\/sessions\?/, list([])],
      ['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_wallet' }],
    ]);
    const response = await call('/wallet/topup?amount=10', { headers: { Cookie: await walletSession() } });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_wallet');
    expect((await readMember(member.member_id))?.stripe_customer_id).toBe('cus_new');
    const form = Object.fromEntries(new URLSearchParams(calls.at(-1)?.body));
    expect(form).toMatchObject({
      mode: 'payment', customer: 'cus_new', client_reference_id: member.member_id,
      'line_items[0][price_data][unit_amount]': '1000',
      'metadata[thelab_member_id]': member.member_id, 'metadata[thelab_wallet_amount]': '1000',
      success_url: `${env.SITE_URL}/wallet?notice=topped`,
    });
  });

  it('reuses an open top-up and enforces the $5 minimum', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?").bind(member.member_id).run();
    let calls = mockFetch([
      ['GET', /\/v1\/checkout\/sessions\?/, list([{
        id: 'cs_open', url: 'https://checkout.stripe.com/c/pay/cs_open', mode: 'payment', status: 'open',
        client_reference_id: member.member_id, metadata: { thelab_wallet_amount: '500' },
      }])],
    ]);
    const response = await call('/wallet/topup?amount=5', { headers: { Cookie: await walletSession() } });
    expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_open');
    expect(calls.some(call => call.method === 'POST')).toBe(false);

    vi.restoreAllMocks();
    calls = mockFetch();
    const rejected = await call('/wallet/topup?amount=4.99', { headers: { Cookie: await walletSession() } });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain('between $5.00 and $200.00');
    expect(calls).toHaveLength(0);
  });

  it('credits a completed top-up once per Checkout session', async () => {
    await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?").bind(member.member_id).run();
    mockFetch([
      ['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
      ['GET', /\/v1\/subscriptions\?/, list([])],
      ['DELETE', roleURL, new Response(null, { status: 204 })],
    ]);
    const event = (id: string) => stripeEvent({
      type: 'checkout.session.completed',
      data: { object: {
        id, mode: 'payment', payment_status: 'paid', customer: 'cus_1', client_reference_id: member.member_id,
        metadata: { thelab_member_id: member.member_id, thelab_wallet_amount: '1000' },
      } },
    });
    expect((await call('/webhooks/stripe', await event('cs_one'))).status).toBe(204);
    expect(await balance(member.member_id)).toBe(1000);
    expect((await call('/webhooks/stripe', await event('cs_one'))).status).toBe(204);
    expect(await balance(member.member_id)).toBe(1000);
    expect((await call('/webhooks/stripe', await event('cs_two'))).status).toBe(204);
    expect(await balance(member.member_id)).toBe(2000);
  });

  it('charges a fixed-price item and makes repeated confirmation a replay', async () => {
    await credit(member.member_id, 500);
    const cookie = await walletSession();
    const html = await (await call('/wallet/redeem?n=Soda&p=1.50', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('<p class="wallet-item">Soda</p>');
    expect(html).toContain('Pay $1.50');
    const purchaseKey = hiddenKey(html);
    const confirm = await call('/wallet/redeem', post({ n: 'Soda', p: '1.50', key: purchaseKey }, { Cookie: cookie }));
    expect(confirm.status).toBe(303);
    const receipt = confirm.headers.get('Location') || '';
    expect(receipt).toMatch(new RegExp(`^/wallet/receipt/\\d+\\?k=${purchaseKey}$`));
    expect(await balance(member.member_id)).toBe(350);
    expect(await (await call(receipt, { headers: { Cookie: cookie } })).text()).toContain('Soda');

    const replay = await call('/wallet/redeem', post({ n: 'Soda', p: '1.50', key: purchaseKey }, { Cookie: cookie }));
    expect(replay.headers.get('Location')).toBe(receipt);
    expect(await balance(member.member_id)).toBe(350);
  });

  it('reviews a per-unit charge, then applies it once', async () => {
    await credit(member.member_id, 5000);
    const cookie = await walletSession();
    const html = await (await call('/wallet/redeem?n=Filament&u=gram&p=0.10&min=5&max=2000', { headers: { Cookie: cookie } })).text();
    expect(html).toContain('$0.10 per gram');
    const key = hiddenKey(html);
    const review = await call('/wallet/redeem', post({ n: 'Filament', p: '0.1', u: 'gram', min: '5', max: '2000', q: '250', key }, { Cookie: cookie }));
    expect(review.status).toBe(200);
    expect(await review.text()).toContain('Charge $25.00');
    expect(await balance(member.member_id)).toBe(5000);

    const confirm = await call('/wallet/redeem', post({ n: 'Filament', p: '0.1', u: 'gram', min: '5', max: '2000', q: '250', key, confirm: '1' }, { Cookie: cookie }));
    expect(confirm.status).toBe(303);
    expect(await balance(member.member_id)).toBe(2500);
  });

  it('rejects quantities outside the link range and charges the zero floor', async () => {
    await credit(member.member_id, 350);
    const cookie = await walletSession();
    const below = await call('/wallet/redeem', post({ n: 'Filament', p: '0.1', u: 'gram', min: '5', q: '2', key }, { Cookie: cookie }));
    expect(below.status).toBe(400);
    expect(await below.text()).toContain('at least 5 gram');

    const poor = await call('/wallet/redeem', post({ n: 'Soda', p: '10.00', key }, { Cookie: cookie }));
    expect(poor.status).toBe(409);
    expect(await poor.text()).toContain('Your balance is $3.50');
    expect(await balance(member.member_id)).toBe(350);
  });

  it('rejects invalid item links', async () => {
    const cookie = await walletSession();
    for (const path of ['/wallet/redeem?n=Soda', '/wallet/redeem?n=Soda&p=free', '/wallet/redeem?n=Filament&u=gram&p=0.10&min=9&max=2']) {
      expect((await call(path, { headers: { Cookie: cookie } })).status).toBe(400);
    }
  });

  it('requires a note on admin adjustments and records them in history', async () => {
    const admin = await session('444444444444444444', true);
    let response = await call(`/admin/members/${member.member_id}/wallet`, post({ amount: '10', note: '' }, { Cookie: admin }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('note explaining the adjustment is required');
    expect(await balance(member.member_id)).toBe(0);

    response = await call(`/admin/members/${member.member_id}/wallet`, post({ amount: '10', note: 'Cash top-up' }, { Cookie: admin }));
    expect(response.status).toBe(303);
    expect(await balance(member.member_id)).toBe(1000);
    const history = await (await call(`/admin/members/${member.member_id}/events`, { headers: { Cookie: admin } })).text();
    expect(history).toContain('Wallet top-up');
    expect(history).toContain('Cash top-up');
    expect(history).toContain('$10.00');
  });
});
