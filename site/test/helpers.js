import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, reset, waitOnExecutionContext } from 'cloudflare:test';
import { vi } from 'vitest';
import worker from '../src/index.js';
import { clearPriceCache } from '../src/billing.js';
import { hex, sessionCookie } from '../src/lib.js';

const encoder = new TextEncoder();

// RFC 8032 test seed in PKCS#8; public test material, never a deployment key.
export const edgeEnv = { ...env, EDGE_URL: 'https://edge.example', EDGE_LAN_URL: 'http://edge.lan.example', EDGE_JWT_PRIVATE_KEY: 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g' };

// Also clears in-memory caches so each test starts from a clean state.
export async function resetDB() {
  clearPriceCache();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

export async function call(path, init = {}, bindings = env) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, env.SITE_URL), init), bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

export const post = (fields, headers = {}) => ({
  method: 'POST', body: new URLSearchParams(fields),
  headers: { Origin: env.SITE_URL, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
});

export const session = async (discordUserID, admin = false) => (await sessionCookie(env, discordUserID, admin)).split(';')[0];

// Every unexpected outbound request fails, so no test can reach live services.
// Handlers are [method, exact URL or RegExp, reply object/Response/function].
export function mockFetch(handlers = []) {
  const calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method || 'GET';
    calls.push({ url, method, init, body: typeof init.body === 'string' ? init.body : undefined });
    for (const [m, pattern, reply] of handlers) {
      if (m !== method || !(pattern instanceof RegExp ? pattern.test(url) : url === pattern)) continue;
      const result = typeof reply === 'function' ? await reply(url, init) : reply;
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

export async function insertMember(fields = {}) {
  const keys = Object.keys(fields);
  const sql = keys.length ? `(${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})` : 'DEFAULT VALUES';
  return env.DB.prepare(`INSERT INTO members ${sql} RETURNING *`).bind(...Object.values(fields)).first();
}

export const addWaiver = memberID => env.DB.prepare(`INSERT INTO waivers(member_id, content, name, email, agreements)
  VALUES (?, '', 'Maker', 'maker@example.com', '[]')`).bind(memberID).run();

export const readMember = memberID => env.DB.prepare('SELECT * FROM members WHERE member_id = ?').bind(memberID).first();

export async function stripeEvent(event, secret = env.STRIPE_WEBHOOK_SECRET) {
  const body = JSON.stringify(event), timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`)));
  return { method: 'POST', body, headers: { 'Stripe-Signature': `t=${timestamp},v1=${signature}` } };
}
