// Pre-paid wallet: Stripe top-ups, QR-code redemptions, and receipts.
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import {
  HttpError, formatMoney, loginRedirect, origin, randomToken, readForm, redirect, stripe, stripeList, walletIdentity, withCookie,
  type Form, type Member, type WalletEntry,
} from './lib.ts';
import { ensureCustomer } from './billing.ts';

const TOPUP_MIN = 500, TOPUP_MAX = 20000;

type WalletMember = Member & { balance: number };

// A Checkout session created by a top-up; only these fields take part.
interface WalletCheckout {
  id: string; url: string; mode: string; status: string;
  client_reference_id: string | null; metadata?: Record<string, string> | null;
}

const date = (value: number) => new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

const loadMember = (env: Env, discordUserID: string) =>
  env.DB.prepare(`SELECT members.*, COALESCE(
    (SELECT SUM(amount) FROM wallet_entries WHERE member_id = members.member_id), 0) AS balance
    FROM members WHERE discord_user_id = ?`).bind(discordUserID).first<WalletMember>();

// ────────────────────────────────────────────────────────────────────────
// Item links
// ────────────────────────────────────────────────────────────────────────

// Fixed prices have no unit. Variable items price one unit linearly, e.g.
// /wallet/redeem?n=Filament&u=gram&p=0.10&min=5&max=2000
interface ItemSpec {
  name: string;
  price: number;        // Dollars, per unit when unit is set.
  unit?: string;
  min?: number;
  max?: number;
}

type Param = (name: string) => string | null;
const queryParam = (params: URLSearchParams): Param => name => params.get(name);
const formParam = (form: Form): Param => name => form[name] ?? null;

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
  const min = bound(read('min')), max = bound(read('max'));
  if (min !== undefined && max !== undefined && max <= min) throw new HttpError(400, 'This item link has an invalid unit range.');
  return { name, price, unit, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

const quantity = (value: string | null | undefined) => value && QUANTITY.test(value) ? Number(value) : 0;

// Per-unit prices may have sub-cent precision, so show all meaningful digits.
function unitPrice(value: number) {
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) < 1e-9) return formatMoney(cents);
  return `$${value.toFixed(4).replace(/0+$/, '')}`;
}

const specFields = (spec: ItemSpec) => <>
  <input type="hidden" name="n" value={spec.name} />
  <input type="hidden" name="p" value={String(spec.price)} />
  {spec.unit && <input type="hidden" name="u" value={spec.unit} />}
  {spec.min !== undefined && <input type="hidden" name="min" value={String(spec.min)} />}
  {spec.max !== undefined && <input type="hidden" name="max" value={String(spec.max)} />}
</>;

// ────────────────────────────────────────────────────────────────────────
// Wallet home and top-ups
// ────────────────────────────────────────────────────────────────────────

export async function walletPage(request: Request, env: Env) {
  const identity = await walletIdentity(request, env);
  if (!identity) return loginRedirect('/wallet');
  const member = await loadMember(env, identity.sub);
  if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
  const { results: entries } = await env.DB.prepare(
    'SELECT * FROM wallet_entries WHERE member_id = ? ORDER BY entry_id DESC LIMIT 20').bind(member.member_id).all<WalletEntry>();
  const notice = new URL(request.url).searchParams.get('notice');
  const response = page('Wallet', <div class="wallet">
    {notice === 'topped' && <p role="status">Thanks! Stripe is confirming your payment; the new balance appears here shortly.</p>}
    <p class="wallet-balance"><span>Balance</span><strong>{formatMoney(member.balance)}</strong></p>
    <p class="card-desc">Pre-paid credits work at the shelf: scan the code on an item and confirm the charge. Credits are non-refundable except by leadership.</p>
    <section aria-labelledby="wallet-add">
      <h2 id="wallet-add">Add credits</h2>
      <div class="wallet-topups">
        {[500, 1000, 2500, 5000].map(cents => <form method="get" action="/wallet/topup">
          <input type="hidden" name="amount" value={cents / 100} />
          <button class="btn btn-outline" type="submit">{formatMoney(cents)}</button>
        </form>)}
      </div>
      <form method="get" action="/wallet/topup" class="wallet-topup-custom">
        <label class="sr-only" for="wallet-amount">Other amount in dollars</label>
        <input id="wallet-amount" name="amount" type="number" inputmode="decimal" min="5" max="200" step="0.01" placeholder="Other amount" />
        <button class="btn btn-primary" type="submit">Add credits</button>
      </form>
      <p class="card-desc">Minimum {formatMoney(TOPUP_MIN)}. Payments are handled by Stripe.</p>
    </section>
    <section aria-labelledby="wallet-history">
      <h2 id="wallet-history">Recent activity</h2>
      {entries.length ? <div class="wallet-table-wrap">
        <table class="wallet-table">
          <thead><tr><th scope="col">Date</th><th scope="col">Item</th><th scope="col">Amount</th></tr></thead>
          <tbody>{entries.map(entry => <tr>
            <td>{date(entry.created)}</td>
            <td>{entry.item || (entry.amount > 0 ? 'Wallet credit' : 'Purchase')}</td>
            <td class={entry.amount > 0 ? 'wallet-credit' : 'wallet-charge'}>{entry.amount > 0 ? '+' : ''}{formatMoney(entry.amount)}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p class="card-desc">No activity yet.</p>}
    </section>
  </div>);
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
  if (amount < TOPUP_MIN || amount > TOPUP_MAX) throw new HttpError(400, `Choose an amount between ${formatMoney(TOPUP_MIN)} and ${formatMoney(TOPUP_MAX)}.`);

  const { customer, member: current } = await ensureCustomer(env, member);
  // Reuse a pending payment for the same amount, and retire duplicate links so
  // an old one cannot charge twice later.
  const sessions = (await stripeList<WalletCheckout>(env, '/checkout/sessions', { customer }))
    .filter(session => session.mode === 'payment' && session.client_reference_id === current.member_id
      && session.metadata?.thelab_wallet_amount === String(amount));
  const reusable = sessions.find(session => session.status === 'open');
  for (const session of sessions) {
    if (session.status === 'open' && session !== reusable) {
      await stripe(env, `/checkout/sessions/${session.id}/expire`, {}, `wallet-checkout-expire:${session.id}`);
    }
  }
  if (reusable) return withCookie(redirect(reusable.url), identity.cookie);
  const session = await stripe<{ url: string }>(env, '/checkout/sessions', {
    mode: 'payment', customer,
    client_reference_id: current.member_id,
    success_url: `${origin(env)}/wallet?notice=topped`,
    cancel_url: `${origin(env)}/wallet`,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': 'TheLab wallet credit',
    'payment_method_types[0]': 'card',
    'metadata[thelab_member_id]': current.member_id,
    'metadata[thelab_wallet_amount]': String(amount),
  }, `wallet-topup:${current.member_id}:${amount}:${sessions.length}`);
  return withCookie(redirect(session.url), identity.cookie);
}

// ────────────────────────────────────────────────────────────────────────
// Redemption
// ────────────────────────────────────────────────────────────────────────

function itemPage(member: WalletMember, spec: ItemSpec, key: string, { message = '', status = 200 } = {}) {
  const amount = spec.unit ? 0 : Math.round(spec.price * 100);
  return page(`Redeem ${spec.name}`, <div class="wallet">
    {message && <p role="alert" class="wallet-error">{message}</p>}
    <p class="wallet-item">{spec.name}</p>
    <p class="wallet-price">{spec.unit ? `${unitPrice(spec.price)} per ${spec.unit}` : formatMoney(amount)}</p>
    <p class="wallet-balance"><span>Balance</span><strong>{formatMoney(member.balance)}</strong></p>
    <form method="post" action="/wallet/redeem" class="wallet-form">
      {specFields(spec)}
      <input type="hidden" name="key" value={key} />
      {spec.unit ? <>
        <label for="wallet-quantity">Quantity ({spec.unit})</label>
        <input id="wallet-quantity" name="q" type="number" inputmode="decimal" step="0.01" required
          min={spec.min ?? 0.01} max={spec.max} placeholder="0" />
        <button class="btn btn-primary" type="submit">Review charge</button>
      </> : <button class="btn btn-primary" type="submit">Pay {formatMoney(amount)}</button>}
    </form>
    <div class="wallet-links">
      <a href="/wallet">Wallet</a>
    </div>
    <p class="card-desc">Honor system: redeem only what you take. The charge is immediate.</p>
  </div>, { status });
}

function reviewPage(member: WalletMember, spec: ItemSpec, qty: number, amount: number, key: string, message = '') {
  return page(`Confirm ${spec.name}`, <div class="wallet">
    {message && <p role="alert" class="wallet-error">{message}</p>}
    <p class="wallet-item">{spec.name}</p>
    <p class="wallet-price">{qty} {spec.unit} × {unitPrice(spec.price)} = <strong>{formatMoney(amount)}</strong></p>
    <p class="wallet-balance"><span>Balance after</span><strong>{formatMoney(member.balance - amount)}</strong></p>
    <form method="post" action="/wallet/redeem" class="wallet-form">
      {specFields(spec)}
      <input type="hidden" name="q" value={String(qty)} />
      <input type="hidden" name="key" value={key} />
      <input type="hidden" name="confirm" value="1" />
      <button class="btn btn-primary" type="submit">Charge {formatMoney(amount)}</button>
    </form>
    <div class="wallet-links">
      <a href={`/wallet/redeem?${new URLSearchParams({ n: spec.name, p: String(spec.price), ...(spec.unit ? { u: spec.unit } : {}), ...(spec.min !== undefined ? { min: String(spec.min) } : {}), ...(spec.max !== undefined ? { max: String(spec.max) } : {}) })}`}>Change quantity</a>
      <a href="/wallet">Cancel</a>
    </div>
  </div>);
}

export async function redeemPage(request: Request, env: Env) {
  const url = new URL(request.url);
  const identity = await walletIdentity(request, env);
  if (!identity) return loginRedirect(url.pathname + url.search);
  const member = await loadMember(env, identity.sub);
  if (!member) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
  return withCookie(itemPage(member, readSpec(queryParam(url.searchParams)), randomToken()), identity.cookie);
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

  let qty = 1, amount: number;
  if (spec.unit) {
    qty = quantity(form.q);
    if (!(qty > 0)) return withCookie(itemPage(member, spec, randomToken(), { message: 'Enter how many units you are redeeming.', status: 400 }), identity.cookie);
    if ((spec.min !== undefined && qty < spec.min) || (spec.max !== undefined && qty > spec.max)) {
      const range = spec.min !== undefined && spec.max !== undefined ? `between ${spec.min} and ${spec.max}`
        : spec.min !== undefined ? `at least ${spec.min}` : `at most ${spec.max}`;
      return withCookie(itemPage(member, spec, randomToken(), { message: `Enter a quantity ${range} ${spec.unit}.`, status: 400 }), identity.cookie);
    }
    amount = Math.round(spec.price * qty * 100);
    if (!form.confirm) {
      if (amount > member.balance) {
        return withCookie(itemPage(member, spec, randomToken(), {
          message: `Your balance is ${formatMoney(member.balance)}; add credits in your wallet and try again.`, status: 409,
        }), identity.cookie);
      }
      return withCookie(reviewPage(member, spec, qty, amount, key), identity.cookie);
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
    .bind(member.member_id, -amount, spec.name, key,
      JSON.stringify({ quantity: qty, unit: spec.unit, unit_price: spec.price }), amount)
    .first<{ entry_id: number }>();
  if (entry) return withCookie(redirect(`/wallet/receipt/${entry.entry_id}?k=${key}`), identity.cookie);
  // A repeated submit finds its original entry and lands on the same receipt.
  const replay = await env.DB.prepare('SELECT entry_id FROM wallet_entries WHERE member_id = ? AND key = ?')
    .bind(member.member_id, key).first<{ entry_id: number }>();
  if (replay) return withCookie(redirect(`/wallet/receipt/${replay.entry_id}?k=${key}`), identity.cookie);
  const current = await loadMember(env, identity.sub);
  if (!current) throw new HttpError(403, 'Your account isn’t registered with TheLab yet. Please contact leadership.');
  return withCookie(itemPage(current, spec, randomToken(), {
    message: `Your balance is ${formatMoney(current.balance)}; add credits and try again.`, status: 409,
  }), identity.cookie);
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
    .bind(Number(match[1]), member.member_id, key).first<WalletEntry>();
  if (!entry) throw new HttpError(404, 'Receipt not found.');
  let details: Record<string, unknown> = {};
  try { details = JSON.parse(entry.details); } catch { /* Display what is stored. */ }
  const quantity = typeof details.quantity === 'number' && typeof details.unit === 'string' && details.unit
    ? `${details.quantity} ${details.unit} · ` : '';
  const response = page('Redeemed', <div class="wallet">
    <p role="status">Thanks! Your wallet was charged.</p>
    <p class="wallet-item">{entry.item}</p>
    <p class="wallet-price">{formatMoney(-entry.amount)}</p>
    <p class="card-desc">{quantity}{date(entry.created)}</p>
    <p class="wallet-balance"><span>Balance</span><strong>{formatMoney(member.balance)}</strong></p>
    <div class="wallet-links">
      <a href="/wallet">Wallet</a>
    </div>
  </div>);
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
    .bind(memberID, amount, `admin:${randomToken()}`, JSON.stringify({ source: 'admin', admin: adminID, note })).run();
}
