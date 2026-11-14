import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Member, walletCookie } from '../src/lib.ts';
import { donationLink } from '../static/sign/lib.js';
import { call, insertMember, mockFetch, post, quiet, readMember, resetDB, session, stripeEvent } from './helpers.ts';

const discordID = '333333333333333333';
const stripeAPI = 'https://api.stripe.com/v1';
const roleURL = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${discordID}/roles/${env.DISCORD_ROLE_ID}`;
const list = (data: unknown[]) => ({ data, has_more: false });
const key = 'a'.repeat(64);

const walletSession = async (id = discordID) => (await walletCookie(env, id)).split(';')[0]!;
const cookieFrom = (response: Response) => (response.headers.get('Set-Cookie') || '').split(';')[0]!;
const balance = async (memberID: string) =>
	(
		await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM wallet_entries WHERE member_id = ?')
			.bind(memberID)
			.first<{ n: number }>()
	)?.n ?? 0;
const credit = (memberID: string, cents: number, id = 'seed') =>
	env.DB.prepare(`INSERT INTO wallet_entries (member_id, amount, key) VALUES (?, ?, ?)`)
		.bind(memberID, cents, id)
		.run();
const hiddenKey = (html: string) => html.match(/name="key" value="([a-f0-9]{64})"/)?.[1] ?? '';

describe('Wallet', () => {
	let member: Member;
	beforeEach(async () => {
		await resetDB();
		member = await insertMember({
			discord_user_id: discordID,
			discord_username: 'maker',
			discord_email: 'maker@example.com',
		});
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
		expect(html).toContain('name="amount"');
		expect(html).toContain('type="number"');
		expect(html).toContain('min="5"');
		expect(html).toContain('value="5.00"');
		expect(html).not.toContain('wallet-topups');
		// Top-up forms redirect to Stripe Checkout, which form-action must allow.
		expect(response.headers.get('Content-Security-Policy')).toContain(
			"form-action 'self' https://checkout.stripe.com;",
		);
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
		const response = await call('/wallet/topup?amount=10.37', { headers: { Cookie: await walletSession() } });
		expect(response.status).toBe(303);
		expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_wallet');
		expect((await readMember(member.member_id))?.stripe_customer_id).toBe('cus_new');
		const form = Object.fromEntries(new URLSearchParams(calls.at(-1)?.body));
		expect(form).toMatchObject({
			mode: 'payment',
			customer: 'cus_new',
			client_reference_id: member.member_id,
			'line_items[0][price_data][unit_amount]': '1037',
			'metadata[thelab_member_id]': member.member_id,
			'metadata[thelab_wallet_amount]': '1037',
			success_url: `${env.SITE_URL}/wallet?notice=topped`,
		});
	});

	it('reuses an open top-up and enforces the $5 minimum', async () => {
		await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?")
			.bind(member.member_id)
			.run();
		let calls = mockFetch([
			[
				'GET',
				/\/v1\/checkout\/sessions\?/,
				list([
					{
						id: 'cs_open',
						url: 'https://checkout.stripe.com/c/pay/cs_open',
						mode: 'payment',
						status: 'open',
						client_reference_id: member.member_id,
						metadata: { thelab_wallet_amount: '500' },
					},
				]),
			],
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

		await credit(member.member_id, 9600, 'near-cap');
		const overLimit = await call('/wallet/topup?amount=5', { headers: { Cookie: await walletSession() } });
		expect(overLimit.status).toBe(400);
		expect(await overLimit.text()).toContain('so you can add at most $4.00');
		const cannotTopUp = await call(
			'/wallet/redeem',
			post({ n: 'Snack', p: '99', key }, { Cookie: await walletSession() }),
		);
		const cannotTopUpHTML = await cannotTopUp.text();
		expect(cannotTopUpHTML).toContain('wallet limit leaves room for only $4.00');
		expect(cannotTopUpHTML).not.toContain('Continue to payment');
	});

	it('offers the bounded shortfall and preserves the donation through Checkout', async () => {
		await credit(member.member_id, 350);
		const cookie = await walletSession();
		// Loading the item does not divert to Checkout before the donation is submitted.
		let response = await call('/wallet/redeem?n=Soda&p=10', { headers: { Cookie: cookie } });
		expect(response.status).toBe(200);
		let html = await response.text();
		expect(html).toContain('Pay $10.00');
		expect(html).not.toContain('with Stripe');

		response = await call('/wallet/redeem', post({ n: 'Soda', p: '10', key }, { Cookie: cookie }));
		expect(response.status).toBe(409);
		html = await response.text();
		expect(response.headers.get('Content-Security-Policy')).toContain(
			"form-action 'self' https://checkout.stripe.com;",
		);
		expect(html).toContain('Your balance is $3.50; add $6.50');
		expect(html).toContain('name="amount"');
		expect(html).toContain('min="6.5"');
		expect(html).toContain('value="6.50"');
		expect(html).toContain('name="next" value="/wallet/redeem?n=Soda&amp;p=10"');
		expect(html).not.toContain('payment processor fees');

		response = await call('/wallet/redeem', post({ n: 'Snack', p: '4', key }, { Cookie: cookie }));
		html = await response.text();
		expect(html).toContain('value="5.00"');
		expect(html).toContain('Continue to payment');
		expect(html).toContain('We set a minimum of $5.00 for credit card transactions');
		expect(html).toContain('payment processor fees');
		response = await call('/wallet/redeem', post({ n: 'Machine', p: '300', key }, { Cookie: cookie }));
		html = await response.text();
		expect(html).toContain('exceeds the $100.00 wallet limit');
		expect(html).not.toContain('Continue to payment');
		expect(html).not.toContain('payment processor fees');

		const next = '/wallet/redeem?n=Soda&p=10';
		const tooLittle = await call(`/wallet/topup?amount=6.49&next=${encodeURIComponent(next)}`, {
			headers: { Cookie: cookie },
		});
		expect(tooLittle.status).toBe(400);
		expect(await tooLittle.text()).toContain('Add at least $6.50 to complete this donation.');

		await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?")
			.bind(member.member_id)
			.run();
		const calls = mockFetch([
			['GET', /\/v1\/checkout\/sessions\?/, list([])],
			['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_shortfall' }],
		]);
		response = await call(`/wallet/topup?amount=7.25&next=${encodeURIComponent(next)}`, {
			headers: { Cookie: cookie },
		});
		expect(response.headers.get('Location')).toBe('https://checkout.stripe.com/c/pay/cs_shortfall');
		const form = Object.fromEntries(new URLSearchParams(calls.at(-1)?.body));
		expect(form).toMatchObject({
			success_url: `${env.SITE_URL}${next}&notice=topped&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${env.SITE_URL}${next}`,
			'line_items[0][price_data][unit_amount]': '725',
		});

		await credit(member.member_id, 20000, 'stripe:cs_capped');
		response = await call('/wallet/redeem?n=Machine&p=300&notice=topped&session_id=cs_capped', {
			headers: { Cookie: cookie },
		});
		html = await response.text();
		expect(html).not.toContain('Stripe is confirming your payment');
		expect(html).toContain('exceeds the $100.00 wallet limit');
		expect(html).not.toContain('Continue to payment');
	});

	it('waits for a contextual credit, then resumes a quantity confirmation', async () => {
		const cookie = await walletSession();
		const path = '/wallet/redeem?n=Filament&u=gram&p=0.1&q=250';
		let response = await call(path, { headers: { Cookie: cookie } });
		expect(response.status).toBe(409);
		expect(await response.text()).toContain('value="25.00"');

		response = await call(`${path}&notice=topped&session_id=cs_context`, { headers: { Cookie: cookie } });
		expect(response.status).toBe(200);
		let html = await response.text();
		expect(html).toContain('Stripe is confirming your payment');
		expect(html).not.toContain('Continue to payment');
		expect(html).toContain('session_id=cs_context');

		await credit(member.member_id, 2500, 'stripe:cs_context');
		response = await call(`${path}&notice=topped&session_id=cs_context`, { headers: { Cookie: cookie } });
		html = await response.text();
		expect(html).toContain('250 gram');
		expect(html).toContain('Charge $25.00');
	});

	it('automatically charges the intended donation after a paid contextual top-up', async () => {
		await credit(member.member_id, 350);
		await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?")
			.bind(member.member_id)
			.run();
		const cookie = await walletSession();
		const next = '/wallet/redeem?n=Soda&p=10';
		const insufficient = await call('/wallet/redeem', post({ n: 'Soda', p: '10', key }, { Cookie: cookie }));
		const html = await insufficient.text();
		const intent = html.match(/name="intent" value="([^"]+)"/)?.[1];
		expect(intent).toBeTruthy();

		const calls = mockFetch([
			['GET', /\/v1\/checkout\/sessions\?/, list([])],
			['POST', `${stripeAPI}/checkout/sessions`, { url: 'https://checkout.stripe.com/c/pay/cs_auto' }],
		]);
		const checkout = await call(
			`/wallet/topup?amount=7.25&next=${encodeURIComponent(next)}&intent=${encodeURIComponent(intent!)}`,
			{ headers: { Cookie: cookie } },
		);
		expect(checkout.status).toBe(303);
		const form = Object.fromEntries(new URLSearchParams(calls.at(-1)?.body));
		expect(form['metadata[thelab_wallet_intent]']).toBeTruthy();
		expect(form['line_items[0][price_data][unit_amount]']).toBe('725');
		const successURL = form.success_url!;
		const returnPath = `/wallet/redeem?auto=${encodeURIComponent(intent!)}&session_id=cs_auto`;
		const session = {
			id: 'cs_auto',
			url: 'https://checkout.stripe.com/c/pay/cs_auto',
			mode: 'payment',
			status: 'complete',
			payment_status: 'paid',
			currency: 'usd',
			amount_total: 725,
			customer: 'cus_1',
			client_reference_id: member.member_id,
			success_url: successURL,
			metadata: {
				thelab_member_id: member.member_id,
				thelab_wallet_amount: '725',
				thelab_wallet_intent: form['metadata[thelab_wallet_intent]'],
			},
		};
		vi.restoreAllMocks();
		mockFetch([['GET', `${stripeAPI}/checkout/sessions/cs_auto`, session]]);

		const returned = await call(returnPath, { headers: { Cookie: cookie } });
		expect(returned.status).toBe(303);
		const receipt = returned.headers.get('Location') || '';
		expect(receipt).toMatch(/^\/wallet\/receipt\/\d+\?k=/);
		expect(await balance(member.member_id)).toBe(75);
		const receiptHTML = await (await call(receipt, { headers: { Cookie: cookie } })).text();
		expect(receiptHTML).toContain('<p class="wallet-item">Soda</p>');
		expect(receiptHTML).toContain('<p class="wallet-price">$10.00</p>');

		// Returning again is safe: both the Stripe credit and donation debit replay.
		const replay = await call(returnPath, { headers: { Cookie: cookie } });
		expect(replay.headers.get('Location')).toBe(receipt);
		expect(await balance(member.member_id)).toBe(75);
	});

	it('asks for a quantity before offering a top-up', async () => {
		const cookie = await walletSession();
		const response = await call('/wallet/redeem?n=Filament&u=gram&p=0.1&min=5&max=2000', {
			headers: { Cookie: cookie },
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain('Quantity (gram)');
		expect(html).toContain('Review charge');
		expect(html).not.toContain('with Stripe');
	});

	it('rejects an external donation return address', async () => {
		mockFetch();
		const response = await call('/wallet/topup?amount=10&next=https%3A%2F%2Fevil.example', {
			headers: { Cookie: await walletSession() },
		});
		expect(response.status).toBe(400);
	});

	it('credits a completed top-up once per Checkout session', async () => {
		await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?")
			.bind(member.member_id)
			.run();
		mockFetch([
			['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
			['GET', /\/v1\/subscriptions\?/, list([])],
			['DELETE', roleURL, new Response(null, { status: 204 })],
		]);
		const event = (id: string) =>
			stripeEvent({
				type: 'checkout.session.completed',
				data: {
					object: {
						id,
						mode: 'payment',
						payment_status: 'paid',
						customer: 'cus_1',
						client_reference_id: member.member_id,
						metadata: { thelab_member_id: member.member_id, thelab_wallet_amount: '1000' },
					},
				},
			});
		expect((await call('/webhooks/stripe', await event('cs_one'))).status).toBe(204);
		expect(await balance(member.member_id)).toBe(1000);
		expect((await call('/webhooks/stripe', await event('cs_one'))).status).toBe(204);
		expect(await balance(member.member_id)).toBe(1000);
		expect((await call('/webhooks/stripe', await event('cs_two'))).status).toBe(204);
		expect(await balance(member.member_id)).toBe(2000);
	});

	it('does not let Stripe credits push a wallet above $100', async () => {
		await credit(member.member_id, 9500);
		await env.DB.prepare("UPDATE members SET stripe_customer_id = 'cus_1' WHERE member_id = ?")
			.bind(member.member_id)
			.run();
		mockFetch([
			['GET', `${stripeAPI}/customers/cus_1`, { id: 'cus_1' }],
			['GET', /\/v1\/subscriptions\?/, list([])],
			['DELETE', roleURL, new Response(null, { status: 204 })],
		]);
		const deliver = (id: string, amount: string) =>
			stripeEvent({
				type: 'checkout.session.completed',
				data: {
					object: {
						id,
						mode: 'payment',
						payment_status: 'paid',
						customer: 'cus_1',
						client_reference_id: member.member_id,
						metadata: { thelab_member_id: member.member_id, thelab_wallet_amount: amount },
					},
				},
			});
		expect((await call('/webhooks/stripe', await deliver('cs_too_much', '1000'))).status).toBe(204);
		expect(await balance(member.member_id)).toBe(9500);
		expect((await call('/webhooks/stripe', await deliver('cs_fits', '500'))).status).toBe(204);
		expect(await balance(member.member_id)).toBe(10000);
	});

	it('charges a fixed-price item and makes repeated confirmation a replay', async () => {
		await credit(member.member_id, 500);
		const cookie = await walletSession();
		const html = await (await call('/wallet/redeem?n=Soda&p=1.50', { headers: { Cookie: cookie } })).text();
		expect(html).toContain('<h1>Donation for Soda</h1>');
		expect(html).toContain('<p class="wallet-price">Suggested $1.50</p>');
		expect(html).toContain('Pay $1.50');
		const donationKey = hiddenKey(html);
		const confirm = await call(
			'/wallet/redeem',
			post({ n: 'Soda', p: '1.50', key: donationKey }, { Cookie: cookie }),
		);
		expect(confirm.status).toBe(303);
		const receipt = confirm.headers.get('Location') || '';
		expect(receipt).toMatch(new RegExp(`^/wallet/receipt/\\d+\\?k=${donationKey}$`));
		expect(await balance(member.member_id)).toBe(350);
		const receiptHtml = await (await call(receipt, { headers: { Cookie: cookie } })).text();
		expect(receiptHtml).toContain('<h1>Donation for Soda</h1>');
		expect(receiptHtml).toContain('<p class="wallet-item">Soda</p>');
		expect(receiptHtml).toContain('<p class="wallet-price">$1.50</p>');
		expect(receiptHtml).toContain('Remaining Balance');

		const replay = await call(
			'/wallet/redeem',
			post({ n: 'Soda', p: '1.50', key: donationKey }, { Cookie: cookie }),
		);
		expect(replay.headers.get('Location')).toBe(receipt);
		expect(await balance(member.member_id)).toBe(350);
	});

	it('reviews a per-unit charge, then applies it once', async () => {
		await credit(member.member_id, 5000);
		const cookie = await walletSession();
		const html = await (
			await call('/wallet/redeem?n=Filament&u=gram&p=0.10&min=5&max=2000', { headers: { Cookie: cookie } })
		).text();
		expect(html).toContain('$0.10 per gram');
		const key = hiddenKey(html);
		const review = await call(
			'/wallet/redeem',
			post({ n: 'Filament', p: '0.1', u: 'gram', min: '5', max: '2000', q: '250', key }, { Cookie: cookie }),
		);
		expect(review.status).toBe(200);
		expect(await review.text()).toContain('Charge $25.00');
		expect(await balance(member.member_id)).toBe(5000);

		const confirm = await call(
			'/wallet/redeem',
			post(
				{ n: 'Filament', p: '0.1', u: 'gram', min: '5', max: '2000', q: '250', key, confirm: '1' },
				{ Cookie: cookie },
			),
		);
		expect(confirm.status).toBe(303);
		expect(await balance(member.member_id)).toBe(2500);
		const receiptHtml = await (
			await call(confirm.headers.get('Location') || '', { headers: { Cookie: cookie } })
		).text();
		expect(receiptHtml).toContain('250 gram · ');
	});

	it('rejects quantities outside the link range and charges the zero floor', async () => {
		await credit(member.member_id, 350);
		const cookie = await walletSession();
		const below = await call(
			'/wallet/redeem',
			post({ n: 'Filament', p: '0.1', u: 'gram', min: '5', q: '2', key }, { Cookie: cookie }),
		);
		expect(below.status).toBe(400);
		expect(await below.text()).toContain('at least 5 gram');

		const poor = await call('/wallet/redeem', post({ n: 'Soda', p: '10.00', key }, { Cookie: cookie }));
		expect(poor.status).toBe(409);
		expect(await poor.text()).toContain('Your balance is $3.50');
		expect(await balance(member.member_id)).toBe(350);
	});

	it('rejects invalid item links', async () => {
		const cookie = await walletSession();
		for (const path of [
			'/wallet/redeem?n=Soda',
			'/wallet/redeem?n=Soda&p=free',
			'/wallet/redeem?n=Filament&u=gram&p=0.10&min=9&max=2',
		]) {
			expect((await call(path, { headers: { Cookie: cookie } })).status).toBe(400);
		}
	});

	it('accepts the donation links the sign generator builds', async () => {
		const cookie = await walletSession();
		const fixed = { perUnit: false, unit: '', min: '', max: '' };
		for (const donation of [
			{ ...fixed, name: 'Soda & Snacks', price: '$1.50' },
			{ ...fixed, name: 'Gum', price: '.01' },
			{ ...fixed, name: '🧃 Juice/box?', price: '999.99' },
			{ name: 'Filament', price: '0.0025', perUnit: true, unit: 'gram', min: '', max: '' },
			{ name: 'Resin', price: '999.9999', perUnit: true, unit: 'mL', min: '0.5', max: '99999.99' },
		]) {
			const { href, errors } = donationLink(donation);
			expect(errors).toEqual({});
			const response = await call(href.replace('https://thelab.ms', ''), { headers: { Cookie: cookie } });
			expect(response.status, href).toBe(200);
		}
	});

	it('requires a note on admin adjustments and records them in history', async () => {
		const admin = await session('444444444444444444', true);
		let response = await call(
			`/admin/members/${member.member_id}/wallet`,
			post({ amount: '10', note: '' }, { Cookie: admin }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('note explaining the adjustment is required');
		expect(await balance(member.member_id)).toBe(0);

		response = await call(
			`/admin/members/${member.member_id}/wallet`,
			post({ amount: '10', note: 'Cash top-up' }, { Cookie: admin }),
		);
		expect(response.status).toBe(303);
		expect(await balance(member.member_id)).toBe(1000);
		response = await call(
			`/admin/members/${member.member_id}/wallet`,
			post({ amount: '90.01', note: 'Over the wallet limit' }, { Cookie: admin }),
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Wallet balance cannot exceed $100.00');
		expect(await balance(member.member_id)).toBe(1000);
		const history = await (
			await call(`/admin/members/${member.member_id}/events`, { headers: { Cookie: admin } })
		).text();
		expect(history).toContain('Wallet top-up');
		expect(history).toContain('Cash top-up');
		expect(history).toContain('$10.00');
	});
});
