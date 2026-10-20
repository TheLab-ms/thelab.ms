// Shared HTTP helpers, sessions, provider clients, and access policy.

export const now = () => Math.floor(Date.now() / 1000);
export const discordID = /^[1-9][0-9]{16,19}$/;
const encoder = new TextEncoder();

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A failed Stripe, Discord, or Turnstile request; callers may inspect the reply.
export class ProviderError extends HttpError {
  readonly providerStatus: number | undefined;
  readonly providerCode: unknown;
  constructor(service: string, options: { cause?: unknown; providerStatus?: number; providerCode?: unknown } = {}) {
    super(502, `${service} is temporarily unavailable. Please try again.`);
    this.cause = options.cause;
    this.providerStatus = options.providerStatus;
    this.providerCode = options.providerCode;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export const base64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64url = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const encodeJSON = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));

export const origin = (env: Env) => new URL(env.SITE_URL).origin;

export function logError(event: string, error: unknown, context: Record<string, unknown> = {}) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = (value: unknown) => String(value instanceof Error ? value.message : value);
  console[status >= 500 ? 'error' : 'warn'](JSON.stringify({
    event, ...context, status, provider_status: error instanceof ProviderError ? error.providerStatus : undefined, message: message(error),
    ...(error instanceof Error && error.cause ? { cause: message(error.cause) } : {}),
    ...(status >= 500 && error instanceof Error && error.stack ? { stack: error.stack } : {}),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Database rows; test/schema.test.ts checks these against the migrations
// ────────────────────────────────────────────────────────────────────────

export const discounts = ['', 'military', 'retired', 'firstResponder', 'student', 'family'] as const;
export type Discount = typeof discounts[number];
export const isDiscount = (value: unknown): value is Discount => discounts.some(discount => discount === value);

type Flag = 0 | 1;

export interface Member {
  member_id: string;
  discord_user_id: string | null;
  discord_username: string;
  discord_email: string;
  email: string | null;
  waiver_name: string;
  billing_name: string;
  billing_email: string;
  name_override: string;
  notes: string;
  fob_id: number | null;
  non_billable: Flag;
  legacy_billing: Flag;
  metadata_version: number;
  created: number;
  bill_annually: Flag;
  discount_type: Discount;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_state: string | null;
  legacy_waiver_signed: Flag;
  stripe_sync_version: number;
  waiver_signed: Flag;
}

export interface MemberEvent {
  id: number;
  created: number;
  member_id: string | null;
  event_type: string;
  details: string;
  source_event_id: string | null;
}

// ────────────────────────────────────────────────────────────────────────
// Responses and cookies
// ────────────────────────────────────────────────────────────────────────

export type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

export const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });

export const loginRedirect = (next: string) => redirect(`/login?next=${encodeURIComponent(next)}`);

export function getCookie(request: Request, name: string) {
  return (request.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function setCookie(env: Env, name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin(env).startsWith('https:') ? '; Secure' : ''}`;
}

// Text fields only; a file upload in place of a field reads as missing.
export type Form = Partial<Record<string, string>>;

export async function readForm(request: Request): Promise<Form> {
  let data;
  try { data = await request.formData(); }
  catch { throw new HttpError(400, 'Submit the form again.'); }
  return Object.fromEntries([...data].filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

// ────────────────────────────────────────────────────────────────────────
// Sessions: one signed cookie keyed by Discord account
// ────────────────────────────────────────────────────────────────────────

const SESSION_AGE = 86400;

function authKey(env: Env) {
  if (typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.length < 32) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
  return crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Signed, expiring JSON values. Readers validate the fields they require, and
// each kind of token has disjoint required fields, so one is never accepted as another.
export async function signToken(env: Env, value: { exp: number } & Record<string, unknown>) {
  const payload = encodeJSON(value);
  return `${payload}.${base64url(await crypto.subtle.sign('HMAC', await authKey(env), encoder.encode(payload)))}`;
}

export async function readToken(env: Env, token: string | undefined): Promise<Record<string, unknown> | null> {
  const parts = (token || '').split('.');
  if (parts.length !== 2) return null;
  const [payload = '', signature = ''] = parts;
  const key = await authKey(env);
  try {
    if (!await crypto.subtle.verify('HMAC', key, fromBase64url(signature), encoder.encode(payload))) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    return isRecord(value) && typeof value.exp === 'number' && value.exp > now() ? value : null;
  } catch { return null; }
}

export interface Session { sub: string; admin: boolean }

export async function sessionCookie(env: Env, discordUserID: string, admin: boolean) {
  return setCookie(env, 'thelab_session', await signToken(env, { sub: discordUserID, admin, exp: now() + SESSION_AGE }), SESSION_AGE);
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const session = await readToken(env, getCookie(request, 'thelab_session'));
  const sub = session?.sub;
  return typeof sub === 'string' && discordID.test(sub) ? { sub, admin: session?.admin === true } : null;
}

// Matches no member without a session, so callers can batch it with other reads.
export const memberQuery = (env: Env, session: Session | null, columns = '*') =>
  env.DB.prepare(`SELECT ${columns} FROM members WHERE discord_user_id = ?`).bind(session?.sub ?? null);

export async function currentMember(request: Request, env: Env) {
  const session = await readSession(request, env);
  if (!session) return null;
  return memberQuery(env, session).first<Member>();
}

// ────────────────────────────────────────────────────────────────────────
// Stripe and Discord clients
// ────────────────────────────────────────────────────────────────────────

// Replies are trusted to match T only for authenticated provider APIs; type
// fields the code must validate as unknown.
export async function provider<T extends object>(service: string, url: string, init: RequestInit = {}): Promise<T> {
  let response;
  try {
    // Manual redirects keep credentials from being forwarded elsewhere.
    response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  } catch (cause) {
    throw new ProviderError(service, { cause });
  }
  let data: unknown = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : {};
  } catch { /* Reported below. */ }
  if (!response.ok || !isRecord(data)) throw new ProviderError(service, { providerStatus: response.status, providerCode: isRecord(data) ? data.code : undefined });
  return data as T;
}

export function stripe<T extends object>(env: Env, path: string, form?: Record<string, string>, idempotencyKey?: string) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, 'Billing is temporarily unavailable. Please contact leadership.');
  return provider<T>('Stripe', `https://api.stripe.com/v1${path}`, {
    method: form ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
}

export async function stripeList<T extends { id: string }>(env: Env, path: string, params: Record<string, string> = {}) {
  const all: T[] = [];
  const query = new URLSearchParams({ ...params, limit: '100' });
  for (;;) {
    const result = await stripe<{ data: T[]; has_more: boolean }>(env, `${path}?${query}`);
    all.push(...result.data);
    const last = result.data.at(-1);
    if (!result.has_more || !last) return all;
    query.set('starting_after', last.id);
  }
}

export function discord<T extends object>(env: Env, path: string, method: 'GET' | 'PUT' | 'DELETE' = 'GET') {
  if (!env.DISCORD_BOT_TOKEN) throw new HttpError(503, 'Discord is temporarily unavailable. Please contact leadership.');
  return provider<T>('Discord', `https://discord.com/api/v10${path}`, { method, headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } });
}

export interface GuildMember { user?: { id?: unknown; username?: unknown; bot?: unknown }; roles?: unknown }

// Returns a validated, non-bot guild member's username.
export async function guildUsername(env: Env, id: string) {
  const { user } = await discord<GuildMember>(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${id}`);
  if (user?.id !== id || typeof user.username !== 'string' || !user.username || user.bot) throw new HttpError(400, 'Choose a valid Discord member account.');
  return user.username;
}

export async function verifyStripe(request: Request, env: Env, text: string) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Stripe webhooks are not configured.');
  const parts = (request.headers.get('Stripe-Signature') || '').split(',').map(s => s.trim());
  const timestamp = parts.find(s => s.startsWith('t='))?.slice(2) || '';
  if (!/^\d+$/.test(timestamp) || Math.abs(now() - Number(timestamp)) > 300) throw new HttpError(400, 'Invalid Stripe signature.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const part of parts) {
    const digits = /^v1=([a-f0-9]{64})$/i.exec(part)?.[1];
    if (!digits) continue;
    const signature = Uint8Array.from(digits.match(/../g) ?? [], s => parseInt(s, 16));
    if (await crypto.subtle.verify('HMAC', key, signature, encoder.encode(`${timestamp}.${text}`))) return;
  }
  throw new HttpError(400, 'Invalid Stripe signature.');
}

// ────────────────────────────────────────────────────────────────────────
// Membership and door-access policy
// ────────────────────────────────────────────────────────────────────────

export const grantsMembership = (status: string | null | undefined) => status === 'active' || status === 'trialing';
export const isOngoingSubscription = (status: string) => !['canceled', 'incomplete_expired'].includes(status);

export interface Subscription { id: string; status: string; created: number }

export function selectCurrentSubscription(subscriptions: readonly Subscription[]) {
  const priority = (sub: Subscription) => grantsMembership(sub.status) ? 2 : isOngoingSubscription(sub.status) ? 1 : 0;
  return subscriptions.toSorted((a, b) => priority(b) - priority(a) || b.created - a.created)[0];
}

export const memberAccessSQL = `(members.non_billable = 1
  OR ((members.legacy_billing = 1 OR members.stripe_subscription_state IN ('active', 'trialing'))
    AND members.waiver_signed = 1))`;

export const fobEnabledSQL = `members.fob_id IS NOT NULL AND ${memberAccessSQL}`;

type NamedMember = Partial<Pick<Member, 'name_override' | 'billing_name' | 'discord_username' | 'waiver_name' | 'email'>>;
export const memberName = (member: NamedMember) => member.name_override?.trim() || member.billing_name?.trim() || member.discord_username || member.waiver_name || member.email || 'Member';
export const memberPath = (member: { member_id: string }) => `/admin/members/${member.member_id}`;
export const validEmail = (email: string) => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
