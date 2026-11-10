// Pre-paid wallet: Stripe top-ups, QR-code redemptions, and receipts.
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import {
	HttpError,
	formatMoney,
	hex,
	loginRedirect,
	origin,
	randomToken,
	readForm,
	redirect,
	safeNext,
	stripe,
	stripeList,
	walletIdentity,
	withCookie,
	type Form,
	type Member,
	type WalletEntry,
} from './lib.ts';
import { ensureCustomer } from './billing.ts';
import { devAuth } from './dev.tsx';

const TOPUP_MIN = 500,
	TOPUP_MAX = 20000;

type WalletMember = Member & { balance: number };

// A Checkout session created by a top-up; only these fields take part.
interface WalletCheckout {
	id: string;
	url: string;
	mode: string;
	status: string;
	client_reference_id: string | null;
	success_url?: string | null;
	metadata?: Record<string, string> | null;
}

const date = (value: number) => new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

function addParam(path: string, name: string, value: string) {
	const url = new URL(path, 'https://wallet.invalid');
	url.searchParams.set(name, value);
	return `${url.pathname}${url.search}`;
}

async function destinationKey(path: string) {
	return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))).slice(0, 16);
}

const loadMember = (env: Env, discordUserID: string) =>
	env.DB.prepare(`SELECT members.*, COALESCE(
    (SELECT SUM(amount) FROM wallet_entries WHERE member_id = members.member_id), 0) AS balance
    FROM members WHERE discord_user_id = ?`)
		.bind(discordUserID)
		.first<WalletMember>();

// ────────────────────────────────────────────────────────────────────────
// Item links
// ────────────────────────────────────────────────────────────────────────

// Fixed prices have no unit. Variable items price one unit linearly, e.g.
// /wallet/redeem?n=Filament&u=gram&p=0.10&min=5&max=2000
interface ItemSpec {
	name: string;
	price: number; // Dollars, per unit when unit is set.
	unit?: string;
	min?: number;
	max?: number;
}

type Param = (name: string) => string | null;
const queryParam =
	(params: URLSearchParams): Param =>
	name =>
		params.get(name);
const formParam =
	(form: Form): Param =>
	name =>
		form[name] ?? null;

// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in wallet input.
const CONTROL = /[\x00-\x1f\x7f]/;
const PRICE = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;
const QUANTITY = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/;
const dollars = /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/;

const label = (value: string | null, max: number) => {
	const text = (value || '').trim();
	return text.length > 0 && text.length <= max && !CONTROL.test(text) ? text : '';
};

function readSpec(read: Param): ItemSpec {
	const name = label(read('n'), 80);
	const rawPrice = read('p') || '';
	const price = PRICE.test(rawPrice) ? Number(rawPrice) : 0;
	const unit = label(read('u'), 20);
	if (!name) throw new HttpError(400, 'This item link is missing a valid name.');
	if (!(price > 0)) throw new HttpError(400, 'This item link has an invalid price.');
	if (!unit) {
		if (read('u') || read('min') || read('max')) throw new HttpError(400, 'This item link has invalid details.');
		if (Math.round(price * 100) < 1) throw new HttpError(400, 'This item link has a price below one cent.');
		return { name, price };
	}
	const bound = (value: string | null) => {
		if (!value) return undefined;
		if (!QUANTITY.test(value)) throw new HttpError(400, 'This item link has an invalid unit range.');
		return Number(value);
	};
	const min = bound(read('min')),
		max = bound(read('max'));
	if (min !== undefined && max !== undefined && max <= min)
		throw new HttpError(400, 'This item link has an invalid unit range.');
	return { name, price, unit, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

const quantity = (value: string | null | undefined) => (value && QUANTITY.test(value) ? Number(value) : 0);

// Per-unit prices may have sub-cent precision, so show all meaningful digits.
function unitPrice(value: number) {
	const cents = Math.round(value * 100);
	if (Math.abs(value * 100 - cents) < 1e-9) return formatMoney(cents);
	return `$${value.toFixed(4).replace(/0+$/, '')}`;
}

const specFields = (spec: ItemSpec) => (
	<>
		<input type="hidden" name="n" value={spec.name} />
		<input type="hidden" name="p" value={String(spec.price)} />
		{spec.unit && <input type="hidden" name="u" value={spec.unit} />}
		{spec.min !== undefined && <input type="hidden" name="min" value={String(spec.min)} />}
		{spec.max !== undefined && <input type="hidden" name="max" value={String(spec.max)} />}
	</>
);

// ────────────────────────────────────────────────────────────────────────
// Wallet home and top-ups
// ────────────────────────────────────────────────────────────────────────

export async function walletPage(request: Request, env: Env) {
	const identity = await walletIdentity(request, env);
	if (!identity) return loginRedirect('/wallet');
	const member = await loadMember(env, identity.sub);
	if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	const { results: entries } = await env.DB.prepare(
		'SELECT * FROM wallet_entries WHERE member_id = ? ORDER BY entry_id DESC LIMIT 20',
	)
		.bind(member.member_id)
		.all<WalletEntry>();
	const notice = new URL(request.url).searchParams.get('notice');
	const response = page(
		'Wallet',
		<div class="wallet">
			{notice === 'topped' && (
				<p role="status">Thanks! Stripe is confirming your payment; the new balance appears here shortly.</p>
			)}
			<p class="wallet-balance">
				<span>Balance</span>
				<strong>{formatMoney(member.balance)}</strong>
			</p>
			<section aria-labelledby="wallet-add">
				<h2 id="wallet-add">Add credits</h2>
				<div class="wallet-topups">
					{[500, 1000, 2500, 5000].map(cents => (
						<form method="get" action="/wallet/topup">
							<input type="hidden" name="amount" value={cents / 100} />
							<button class="btn btn-outline" type="submit">
								{formatMoney(cents)}
							</button>
						</form>
					))}
				</div>
			</section>
			<section aria-labelledby="wallet-history">
				<h2 id="wallet-history">Recent activity</h2>
				{entries.length ? (
					<div class="wallet-table-wrap">
						<table class="wallet-table">
							<thead>
								<tr>
									<th scope="col">Date</th>
									<th scope="col">Item</th>
									<th scope="col">Amount</th>
								</tr>
							</thead>
							<tbody>
								{entries.map(entry => (
									<tr>
										<td>{date(entry.created)}</td>
										<td>{entry.item || (entry.amount > 0 ? 'Wallet credit' : 'Donation')}</td>
										<td class={entry.amount > 0 ? 'wallet-credit' : 'wallet-charge'}>
											{entry.amount > 0 ? '+' : ''}
											{formatMoney(entry.amount)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p class="card-desc">No activity yet.</p>
				)}
			</section>
		</div>,
		{ dev: devAuth(env), checkout: true },
	);
	return withCookie(response, identity.cookie);
}

export async function walletTopup(request: Request, env: Env) {
	const url = new URL(request.url);
	const identity = await walletIdentity(request, env);
	if (!identity) return loginRedirect(url.pathname + url.search);
	const member = await loadMember(env, identity.sub);
	if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	const raw = url.searchParams.get('amount') || '';
	const amount = dollars.test(raw) ? Math.round(Number(raw) * 100) : 0;
	if (amount < TOPUP_MIN || amount > TOPUP_MAX)
		throw new HttpError(400, `Choose an amount between ${formatMoney(TOPUP_MIN)} and ${formatMoney(TOPUP_MAX)}.`);
	const rawNext = url.searchParams.get('next') || '';
	if (rawNext && safeNext(rawNext) !== rawNext) throw new HttpError(400, 'The donation return address is invalid.');
	const returnPath = rawNext ? addParam(rawNext, 'notice', 'topped') : '/wallet?notice=topped';
	const successPath = rawNext ? `${returnPath}&session_id={CHECKOUT_SESSION_ID}` : returnPath;
	const successURL = `${origin(env)}${successPath}`;
	const cancelURL = `${origin(env)}${rawNext || '/wallet'}`;

	const { customer, member: current } = await ensureCustomer(env, member);
	// Reuse a pending payment for the same amount, and retire duplicate links so
	// an old one cannot charge twice later. Contextual top-ups are grouped by
	// destination so an existing wallet top-up cannot resume the wrong item.
	const sessions = (await stripeList<WalletCheckout>(env, '/checkout/sessions', { customer })).filter(
		session =>
			session.mode === 'payment' &&
			session.client_reference_id === current.member_id &&
			session.metadata?.thelab_wallet_amount === String(amount),
	);
	const matching = sessions.filter(session =>
		rawNext ? session.success_url === successURL : !session.success_url || session.success_url === successURL,
	);
	const reusable = matching.find(session => session.status === 'open');
	for (const session of matching) {
		if (session.status === 'open' && session !== reusable) {
			await stripe(env, `/checkout/sessions/${session.id}/expire`, {}, `wallet-checkout-expire:${session.id}`);
		}
	}
	if (reusable) return withCookie(redirect(reusable.url), identity.cookie);
	const session = await stripe<{ url: string }>(
		env,
		'/checkout/sessions',
		{
			mode: 'payment',
			customer,
			client_reference_id: current.member_id,
			success_url: successURL,
			cancel_url: cancelURL,
			'line_items[0][quantity]': '1',
			'line_items[0][price_data][currency]': 'usd',
			'line_items[0][price_data][unit_amount]': String(amount),
			'line_items[0][price_data][product_data][name]': 'TheLab wallet credit',
			'payment_method_types[0]': 'card',
			'metadata[thelab_member_id]': current.member_id,
			'metadata[thelab_wallet_amount]': String(amount),
		},
		`wallet-topup:${current.member_id}:${amount}:${await destinationKey(successPath)}:${matching.length}`,
	);
	return withCookie(redirect(session.url), identity.cookie);
}

// ────────────────────────────────────────────────────────────────────────
// Redemption
// ────────────────────────────────────────────────────────────────────────

function itemPage(spec: ItemSpec, key: string, { message = '', status = 200, dev = false } = {}) {
	const amount = spec.unit ? 0 : Math.round(spec.price * 100);
	return page(
		`Donation for ${spec.name}`,
		<div class="wallet">
			{message && (
				<p role="alert" class="wallet-error">
					{message}
				</p>
			)}
			<p class="wallet-price">
				Suggested {spec.unit ? `${unitPrice(spec.price)} per ${spec.unit}` : formatMoney(amount)}
			</p>
			<form method="post" action="/wallet/redeem" class="wallet-form">
				{specFields(spec)}
				<input type="hidden" name="key" value={key} />
				{spec.unit ? (
					<>
						<label for="wallet-quantity">Quantity ({spec.unit})</label>
						<input
							id="wallet-quantity"
							name="q"
							type="number"
							inputmode="decimal"
							step="0.01"
							required
							min={spec.min ?? 0.01}
							max={spec.max}
							placeholder="0"
						/>
						<button class="btn btn-primary" type="submit">
							Review charge
						</button>
					</>
				) : (
					<button class="btn btn-primary" type="submit">
						Pay {formatMoney(amount)}
					</button>
				)}
			</form>
		</div>,
		{ status, dev },
	);
}

function reviewPage(spec: ItemSpec, qty: number, amount: number, key: string, message = '', dev = false) {
	return page(
		`Confirm`,
		<div class="wallet">
			{message && (
				<p role="alert" class="wallet-error">
					{message}
				</p>
			)}
			<p class="wallet-price">
				{qty} {spec.unit} × {unitPrice(spec.price)} = <strong>{formatMoney(amount)}</strong>
			</p>
			<form method="post" action="/wallet/redeem" class="wallet-form">
				{specFields(spec)}
				<input type="hidden" name="q" value={String(qty)} />
				<input type="hidden" name="key" value={key} />
				<input type="hidden" name="confirm" value="1" />
				<button class="btn btn-primary" type="submit">
					Charge {formatMoney(amount)}
				</button>
			</form>
		</div>,
		{ dev },
	);
}

function donationPath(spec: ItemSpec, qty?: number) {
	const params = new URLSearchParams({ n: spec.name, p: String(spec.price) });
	if (spec.unit) params.set('u', spec.unit);
	if (spec.min !== undefined) params.set('min', String(spec.min));
	if (spec.max !== undefined) params.set('max', String(spec.max));
	if (qty !== undefined) params.set('q', String(qty));
	return `/wallet/redeem?${params}`;
}

function quantityRange(spec: ItemSpec, qty: number) {
	if (!spec.unit || ((spec.min === undefined || qty >= spec.min) && (spec.max === undefined || qty <= spec.max)))
		return '';
	const range =
		spec.min !== undefined && spec.max !== undefined
			? `between ${spec.min} and ${spec.max}`
			: spec.min !== undefined
				? `at least ${spec.min}`
				: `at most ${spec.max}`;
	return `Enter a quantity ${range} ${spec.unit}.`;
}

function insufficientPage(
	member: WalletMember,
	spec: ItemSpec,
	qty: number,
	amount: number,
	{ pending = false, sessionID = '', dev = false } = {},
) {
	const next = donationPath(spec, spec.unit ? qty : undefined);
	const retry = addParam(addParam(next, 'notice', 'topped'), 'session_id', sessionID);
	const shortfall = amount - member.balance;
	const topup = Math.min(TOPUP_MAX, Math.max(TOPUP_MIN, shortfall));
	return page(
		'Add wallet credits',
		<div class="wallet">
			<p role={pending ? 'status' : 'alert'} class={pending ? '' : 'wallet-error'}>
				{pending
					? 'Stripe is confirming your payment. Check again shortly to continue your donation.'
					: `Your balance is ${formatMoney(member.balance)}; add ${formatMoney(shortfall)} to complete this donation.`}
			</p>
			<p class="wallet-price">
				{spec.name} · <strong>{formatMoney(amount)}</strong>
			</p>
			{pending ? (
				<p class="wallet-links">
					<a class="btn btn-primary" href={retry}>
						Check again
					</a>
				</p>
			) : (
				<>
					<form method="get" action="/wallet/topup" class="wallet-form">
						<input type="hidden" name="amount" value={topup / 100} />
						<input type="hidden" name="next" value={next} />
						<button class="btn btn-primary" type="submit">
							Add {formatMoney(topup)} with Stripe
						</button>
					</form>
					{topup > shortfall && (
						<p class="card-desc">
							We set a minimum of {formatMoney(TOPUP_MIN)} for credit card transactions to keep payment
							processor fees down. Any extra balance stays in your wallet and can be used for future
							donations.
						</p>
					)}
				</>
			)}
		</div>,
		{ status: pending ? 200 : 409, dev, checkout: !pending },
	);
}

export async function redeemPage(request: Request, env: Env) {
	const url = new URL(request.url);
	const identity = await walletIdentity(request, env);
	if (!identity) return loginRedirect(url.pathname + url.search);
	const member = await loadMember(env, identity.sub);
	if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	const spec = readSpec(queryParam(url.searchParams));
	const dev = devAuth(env),
		topped = url.searchParams.get('notice') === 'topped';
	const sessionID = url.searchParams.get('session_id') || '';
	const credited =
		topped && /^cs_[A-Za-z0-9_]+$/.test(sessionID)
			? await env.DB.prepare('SELECT 1 FROM wallet_entries WHERE member_id = ? AND key = ?')
					.bind(member.member_id, `stripe:${sessionID}`)
					.first()
			: null;
	const pending = topped && !credited;
	if (spec.unit && url.searchParams.has('q')) {
		const qty = quantity(url.searchParams.get('q'));
		if (!(qty > 0)) throw new HttpError(400, 'Enter how many units you are redeeming.');
		const rangeMessage = quantityRange(spec, qty);
		if (rangeMessage) throw new HttpError(400, rangeMessage);
		const amount = Math.round(spec.price * qty * 100);
		if (amount < 1) throw new HttpError(400, 'That charge is below one cent. Enter a larger quantity.');
		const response =
			amount > member.balance
				? insufficientPage(member, spec, qty, amount, { pending, sessionID, dev })
				: reviewPage(spec, qty, amount, randomToken(), '', dev);
		return withCookie(response, identity.cookie);
	}
	const amount = Math.round(spec.price * 100);
	// Defer the top-up until the member has actually attempted a donation, so
	// per-unit items can collect a quantity first. A return from Checkout still
	// reports the payment state.
	const response =
		!spec.unit && topped && amount > member.balance
			? insufficientPage(member, spec, 1, amount, { pending, sessionID, dev })
			: itemPage(spec, randomToken(), { dev });
	return withCookie(response, identity.cookie);
}

export async function redeem(request: Request, env: Env) {
	const identity = await walletIdentity(request, env);
	if (!identity) return loginRedirect('/wallet');
	const member = await loadMember(env, identity.sub);
	if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	const form = await readForm(request);
	const spec = readSpec(formParam(form));
	// The confirmation page mints this key; it makes a repeated submit a replay.
	const key = form.key && /^[a-f0-9]{64}$/.test(form.key) ? form.key : '';
	if (!key) throw new HttpError(400, 'This confirmation expired. Scan the code again.');

	let qty = 1,
		amount: number;
	if (spec.unit) {
		qty = quantity(form.q);
		if (!(qty > 0))
			return withCookie(
				itemPage(spec, randomToken(), {
					message: 'Enter how many units you are redeeming.',
					status: 400,
					dev: devAuth(env),
				}),
				identity.cookie,
			);
		const rangeMessage = quantityRange(spec, qty);
		if (rangeMessage)
			return withCookie(
				itemPage(spec, randomToken(), { message: rangeMessage, status: 400, dev: devAuth(env) }),
				identity.cookie,
			);
		amount = Math.round(spec.price * qty * 100);
		if (!form.confirm) {
			if (amount > member.balance) {
				return withCookie(insufficientPage(member, spec, qty, amount, { dev: devAuth(env) }), identity.cookie);
			}
			return withCookie(reviewPage(spec, qty, amount, key, '', devAuth(env)), identity.cookie);
		}
	} else {
		amount = Math.round(spec.price * 100);
	}
	if (amount < 1) throw new HttpError(400, 'That charge is below one cent. Enter a larger quantity.');

	// One atomic statement: insert only when the balance covers the charge and
	// this key has not already been recorded.
	const entry = await env.DB.prepare(`INSERT INTO wallet_entries (member_id, amount, item, key, details)
    SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM members WHERE member_id = ?1)
    AND COALESCE((SELECT SUM(amount) FROM wallet_entries WHERE member_id = ?1), 0) >= ?6
    AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE member_id = ?1 AND key = ?4)
    RETURNING entry_id`)
		.bind(
			member.member_id,
			-amount,
			spec.name,
			key,
			JSON.stringify({ quantity: qty, unit: spec.unit, unit_price: spec.price }),
			amount,
		)
		.first<{ entry_id: number }>();
	if (entry) return withCookie(redirect(`/wallet/receipt/${entry.entry_id}?k=${key}`), identity.cookie);
	// A repeated submit finds its original entry and lands on the same receipt.
	const replay = await env.DB.prepare('SELECT entry_id FROM wallet_entries WHERE member_id = ? AND key = ?')
		.bind(member.member_id, key)
		.first<{ entry_id: number }>();
	if (replay) return withCookie(redirect(`/wallet/receipt/${replay.entry_id}?k=${key}`), identity.cookie);
	const current = await loadMember(env, identity.sub);
	if (!current) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	return withCookie(insufficientPage(current, spec, qty, amount, { dev: devAuth(env) }), identity.cookie);
}

export async function walletReceipt(request: Request, env: Env) {
	const url = new URL(request.url);
	const identity = await walletIdentity(request, env);
	if (!identity) return loginRedirect(url.pathname + url.search);
	const member = await loadMember(env, identity.sub);
	if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
	const match = url.pathname.match(/^\/wallet\/receipt\/(\d{1,15})$/);
	const key = url.searchParams.get('k') || '';
	if (!match || !/^[a-f0-9]{64}$/.test(key)) throw new HttpError(404, 'Receipt not found.');
	const entry = await env.DB.prepare('SELECT * FROM wallet_entries WHERE entry_id = ? AND member_id = ? AND key = ?')
		.bind(Number(match[1]), member.member_id, key)
		.first<WalletEntry>();
	if (!entry) throw new HttpError(404, 'Receipt not found.');
	let details: Record<string, unknown> = {};
	try {
		details = JSON.parse(entry.details);
	} catch {
		/* Display what is stored. */
	}
	const quantity =
		typeof details.quantity === 'number' && typeof details.unit === 'string' && details.unit
			? `${details.quantity} ${details.unit} · `
			: '';
	const response = page(
		entry.item ? `Donation for ${entry.item}` : 'Donation',
		<div class="wallet">
			<p role="status">Thanks! Your wallet was charged.</p>
			<p class="wallet-item">{entry.item}</p>
			<p class="wallet-price">{formatMoney(-entry.amount)}</p>
			<p class="card-desc">
				{quantity}
				{date(entry.created)}
			</p>
			<p class="wallet-balance">
				<span>Remaining Balance</span>
				<strong>{formatMoney(member.balance)}</strong>
			</p>
			<div class="wallet-links">
				<a href="/wallet">Wallet</a>
			</div>
		</div>,
		{ dev: devAuth(env) },
	);
	return withCookie(response, identity.cookie);
}

// ────────────────────────────────────────────────────────────────────────
// Admin adjustments
// ────────────────────────────────────────────────────────────────────────

export async function adjustWallet(env: Env, memberID: string, adminID: string, form: Form) {
	const raw = (form.amount || '').trim();
	const amount = dollars.test(raw.replace(/^-/, '')) ? Math.round(Number(raw) * 100) : 0;
	if (!amount) throw new HttpError(400, 'Enter a non-zero dollar amount, such as 10 or -2.50.');
	const note = (form.note || '').trim();
	if (!note) throw new HttpError(400, 'A note explaining the adjustment is required.');
	if (note.length > 500 || CONTROL.test(note)) throw new HttpError(400, 'Keep the note under 500 characters.');
	await env.DB.prepare(`INSERT INTO wallet_entries (member_id, amount, item, key, details)
    VALUES (?, ?, 'Adjustment', ?, ?)`)
		.bind(memberID, amount, `admin:${randomToken()}`, JSON.stringify({ source: 'admin', admin: adminID, note }))
		.run();
}
