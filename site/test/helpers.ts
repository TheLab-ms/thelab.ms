import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../src/index.tsx';
import { clearPriceCache } from '../src/billing.ts';
import { hex, sessionCookie, type Member } from '../src/lib.ts';

const encoder = new TextEncoder();

// RFC 8032 test seed in PKCS#8; public test material, never a deployment key.
export const edgeEnv: Env = { ...env, EDGE_URL: 'https://edge.example', EDGE_LAN_URL: 'http://edge.lan.example', EDGE_JWT_PRIVATE_KEY: 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g' };

// Also clears in-memory caches so each test starts from a clean state.
export async function resetDB() {
  clearPriceCache();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

export async function call(path: string, init: RequestInit = {}, bindings: Env = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, env.SITE_URL), init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export const post = (fields: Record<string, string | number>, headers: Record<string, string> = {}) => ({
  method: 'POST', body: new URLSearchParams(Object.entries(fields).map(([key, value]) => [key, String(value)])),
  headers: { Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
});

export const session = async (discordUserID: string, admin = false) => (await sessionCookie(env, discordUserID, admin)).split(';')[0]!;

export interface Call { url: string; method: string; headers: Record<string, string>; body: string; init: RequestInit }
type Reply = object | ((url: string, call: Call) => unknown);
export type Route = [method: string, pattern: string | RegExp, reply: Reply];

// Every unexpected outbound request fails, so no test can reach live services.
// Replies are JSON values, Responses, or functions returning either.
export function mockFetch(routes: Route[] = []) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method || 'GET';
    const call = { url, method, headers: Object.fromEntries(new Headers(init.headers)), body: typeof init.body === 'string' ? init.body : '', init };
    calls.push(call);
    for (const [m, pattern, reply] of routes) {
      if (m !== method || !(pattern instanceof RegExp ? pattern.test(url) : url === pattern)) continue;
      const result = typeof reply === 'function' ? await reply(url, call) : reply;
      return result instanceof Response ? result : Response.json(result);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  return calls;
}

export function quiet() {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

export async function insertMember(fields: Partial<Member> = {}) {
  const keys = Object.keys(fields);
  const sql = keys.length ? `(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})` : 'DEFAULT VALUES';
  const member = await env.DB.prepare(`INSERT INTO members ${sql} RETURNING *`).bind(...Object.values(fields)).first<Member>();
  if (!member) throw new Error('Member insert returned no row.');
  return member;
}

export const addWaiver = (memberID: string) => env.DB.prepare(`INSERT INTO waivers(member_id, content, name, email, agreements)
  VALUES (?, '', 'Maker', 'maker@example.com', '[]')`).bind(memberID).run();

export const readMember = (memberID: string) => env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(memberID).first<Member>();

export const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())?.n;

export async function stripeEvent(event: unknown, secret = env.STRIPE_WEBHOOK_SECRET) {
  const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)));
  return { method: 'POST', body, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` } };
}
