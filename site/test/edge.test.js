import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edgeEventKey, edgeJWKS, edgeToken, pushFobs } from '../src/edge.js';
import { now, randomToken } from '../src/lib.js';
import { addWaiver, call, edgeEnv, insertMember, post, quiet, readMember, resetDB, session } from './helpers.js';

const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));
const revision = async () => (await env.DB.prepare('SELECT revision FROM edge_changes').first()).revision;
const swipeCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM member_events WHERE event_type = 'FobSwipe'").first()).n;

// A fake edge that, like edgeproxy, keeps only the highest pushed revision.
let edge, pushes, fetchSpy;
function fakeEdge() {
  edge = null;
  pushes = [];
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init = {}) => {
    expect(String(url)).toBe('https://edge.example/api/fobs');
    expect(init).toMatchObject({ method: 'PUT', redirect: 'manual' });
    expect(parse(init.headers.Authorization.slice(7).split('.')[1]).scope).toBe('edge:api');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(['fobs', 'key', 'revision']);
    pushes.push(body);
    if (!edge || body.revision >= edge.revision) edge = body;
    return new Response(null, { status: 204 });
  });
}

async function member(fob = 7, status = 'active', waiver = true) {
  const row = await insertMember({ fob_id: fob, stripe_subscription_state: status });
  if (waiver) await addWaiver(row.member_id);
  return row;
}

beforeEach(async () => {
  await resetDB();
  fakeEdge();
});
afterEach(() => vi.restoreAllMocks());

describe('Edge fob list', () => {
  it('pushes the current revision, eligible fobs, and the derived edge key', async () => {
    await member();
    await pushFobs(edgeEnv);
    expect(pushes).toEqual([{ revision: await revision(), fobs: [7], key: await edgeEventKey(edgeEnv) }]);
    expect(pushes[0].key).toMatch(/^[a-f0-9]{64}$/);
    fetchSpy.mockClear();
    await pushFobs({ ...edgeEnv, EDGE_URL: '' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('includes exactly the members eligible for door access', async () => {
    const expected = [];
    let fob = 100;
    for (const status of [null, 'active', 'trialing', 'past_due', 'canceled']) {
      for (const signed of [false, true, 'legacy']) {
        for (const [nonBillable, legacyBilling] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const m = await member(fob++, status, signed === true);
          await env.DB.prepare('UPDATE members SET non_billable = ?, legacy_billing = ?, legacy_waiver_signed = ? WHERE member_id = ?')
            .bind(nonBillable, legacyBilling, Number(signed === 'legacy'), m.member_id).run();
          if (nonBillable || (signed && (legacyBilling || status === 'active' || status === 'trialing'))) expected.push(m.fob_id);
        }
      }
    }
    await insertMember({ non_billable: 1 });
    await pushFobs(edgeEnv);
    expect(edge.fobs).toEqual(expected);
  });

  it.each([
    ['offline', () => Promise.reject(new Error('Edge offline'))],
    ['rejected', () => new Response(null, { status: 401 })],
    ['redirected', () => new Response(null, { status: 302, headers: { Location: 'https://other.example' } })],
  ])('logs a %s push without throwing', async (_name, failure) => {
    await member();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy.mockImplementation(failure);
    await pushFobs(edgeEnv);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ event: 'edge.push_failed' });
  });

  it('delivers all 512 authorized fobs and refuses to truncate an overflowing list', async () => {
    await env.DB.prepare(`INSERT INTO members(fob_id, non_billable)
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<512) SELECT n, 1 FROM seq`).run();
    await pushFobs(edgeEnv);
    expect(edge.fobs).toEqual(Array.from({ length: 512 }, (_, i) => i + 1));
    await env.DB.prepare('INSERT INTO members(fob_id, non_billable) VALUES (513, 1)').run();
    quiet();
    await pushFobs(edgeEnv);
    expect(pushes).toHaveLength(1);
  });
});

describe('Edge sync requests', () => {
  const request = (init = {}) => call('/webhooks/edge/sync', { method: 'POST', ...init }, edgeEnv);
  beforeEach(() => member());

  it('accepts one unauthenticated request per ten minutes and pushes current state', async () => {
    expect((await request()).status).toBe(202);
    expect(pushes).toHaveLength(1);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('600');
    const { sync_requested } = await env.DB.prepare('SELECT sync_requested FROM edge_changes').first();
    vi.spyOn(Date, 'now').mockReturnValue((sync_requested + 600) * 1000);
    expect((await request()).status).toBe(202);
    expect(pushes).toHaveLength(2);
  });

  it('admits exactly one of many concurrent requests', async () => {
    const statuses = await Promise.all(Array.from({ length: 8 }, () => request({ headers: { Origin: 'https://evil.example' } })));
    expect(statuses.map(response => response.status).sort()).toEqual([202, 429, 429, 429, 429, 429, 429, 429]);
  });
});

describe('Swipe ingestion', () => {
  let key;
  const swipe = (id, extra = {}) => ({ id, time: new Date().toISOString(), controller: '192.168.1.2', fob: 7, allowed: true, ...extra });
  async function upload(events, { authorization = `Bearer ${key}`, edgeRevision } = {}) {
    edgeRevision ??= await revision();
    return call('/webhooks/edge/swipes', {
      method: 'POST', body: JSON.stringify(events),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Edge-Revision': String(edgeRevision) },
    }, edgeEnv);
  }
  beforeEach(async () => { key = await edgeEventKey(edgeEnv); });

  it('authenticates the edge key before importing anything', async () => {
    quiet();
    for (const authorization of ['', `Bearer ${'0'.repeat(64)}`, key, `Bearer ${key}x`, `bearer ${key}`]) {
      const response = await upload([swipe('forged')], { authorization });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Edge authentication failed.' });
    }
    expect(await swipeCount()).toBe(0);
    expect((await upload([swipe('valid')])).status).toBe(204);
    expect(await swipeCount()).toBe(1);
  });

  it('deduplicates swipes and uses ownership at swipe time after reassignment', async () => {
    const first = await member();
    await env.DB.prepare('UPDATE fob_assignments SET started = 1000 WHERE member_id = ?').bind(first.member_id).run();
    await env.DB.prepare('UPDATE members SET fob_id = NULL WHERE member_id = ?').bind(first.member_id).run();
    await env.DB.prepare('UPDATE fob_assignments SET ended = 2000 WHERE member_id = ?').bind(first.member_id).run();
    const second = await member();
    await env.DB.prepare('UPDATE fob_assignments SET started = 2000 WHERE member_id = ?').bind(second.member_id).run();
    const swipes = [1999.999, 2000].map((time, i) => swipe(`swipe-${i}`, { time: new Date(time * 1000).toISOString() }));
    swipes.push({ ...swipes[0], id: 'unknown', fob: 99, allowed: false });
    expect((await upload(swipes)).status).toBe(204);
    const select = "SELECT * FROM member_events WHERE event_type = 'FobSwipe' ORDER BY source_event_id";
    const original = (await env.DB.prepare(select).all()).results;
    expect(original.map(e => [e.source_event_id, e.member_id])).toEqual([['swipe-0', first.member_id], ['swipe-1', second.member_id], ['unknown', null]]);
    for (const [i, event] of original.entries()) {
      expect(event.created).toBe(Math.floor(Date.parse(swipes[i].time) / 1000));
      expect(JSON.parse(event.details)).toEqual({ ...swipes[i], allowed: swipes[i].allowed ? 1 : 0 });
    }
    // Retries keep the original evidence.
    expect((await upload(swipes.map(event => ({ ...event, allowed: !event.allowed })))).status).toBe(204);
    expect((await env.DB.prepare(select).all()).results).toEqual(original);
  });

  it('pushes the current fob list when the edge reports a different revision', async () => {
    await member();
    expect((await upload([])).status).toBe(204);
    expect(pushes).toHaveLength(0);
    for (const stale of [(await revision()) - 1, '', 'x']) expect((await upload([], { edgeRevision: stale })).status).toBe(204);
    expect(pushes).toHaveLength(3);
    expect(edge).toMatchObject({ revision: await revision(), fobs: [7] });
  });

  it.each([
    ['malformed events', [swipe('valid'), swipe('invalid', { time: 'yesterday' })]],
    ['an oversized batch', Array.from({ length: 513 }, (_, i) => swipe(`large-${i}`))],
    ['a non-array', { id: 'object' }],
  ])('rejects %s before importing any rows', async (_name, events) => {
    quiet();
    expect((await upload(events)).status).toBe(400);
    expect(await swipeCount()).toBe(0);
  });
});

describe('Edge authentication', () => {
  it('matches the Go verifier interoperability fixture', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    expect(await edgeToken(edgeEnv)).toBe('eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwczovL3RoZWxhYi5leGFtcGxlIiwiYXVkIjoiaHR0cHM6Ly9lZGdlLmV4YW1wbGUiLCJzdWIiOiJlZGdlLXN5bmMiLCJzY29wZSI6ImVkZ2U6YXBpIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.c9kUt-WlqySz-RDa62Q4wgwoV9a0XMGole4SYlWp1xJEKBhSKTsERxcoIUMih0TiU2Wa1UodgU7AM8qfz5zjAw');
  });

  it('publishes only the public signing key', async () => {
    const response = await call('/.well-known/edge-jwks.json', {}, edgeEnv);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    const { keys } = await response.json();
    expect(keys).toEqual([{ alg: 'EdDSA', kty: 'OKP', crv: 'Ed25519', use: 'sig', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo', kid: expect.any(String) }]);
    const [header, payload, signature] = (await edgeToken(edgeEnv)).split('.');
    expect(parse(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: keys[0].kid });
    const verifier = await crypto.subtle.importKey('jwk', keys[0], 'Ed25519', false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', verifier, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  });

  it('fails closed on missing or invalid signing keys', async () => {
    quiet();
    for (const secret of ['', 'invalid']) {
      const bindings = { ...edgeEnv, EDGE_JWT_PRIVATE_KEY: secret };
      await expect(edgeEventKey(bindings)).rejects.toThrow('signing key');
      expect((await call('/.well-known/edge-jwks.json', {}, bindings)).status).toBe(503);
    }
  });
});

describe('Kiosk and fob enrollment', () => {
  const discordID = '333333333333333333';
  let key;
  const scan = (body, authorization = `Bearer ${key}`) => call('/kiosk/claims', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
  }, edgeEnv);
  async function claim(fob = 123) {
    const token = randomToken();
    await env.DB.prepare('INSERT INTO fob_claims(id, fob_id, created, expires) VALUES (?, ?, ?, ?)').bind(token, fob, now(), now() + 300).run();
    return token;
  }
  const bind = async (token, cookie) => call(`/keyfob/bind?token=${token}`, post({}, { Cookie: cookie }), edgeEnv);
  beforeEach(async () => { key = await edgeEventKey(edgeEnv); });

  it('creates five-minute claims with a QR link to the binding page', async () => {
    const response = await scan({ fob_id: 4294967295 });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.url).toBe(`${env.SITE_URL}/keyfob/bind?token=${result.token}`);
    expect(atob(result.qr.replace(/^data:image\/svg\+xml;base64,/, ''))).toMatch(/^<svg /);
    expect(await env.DB.prepare('SELECT fob_id, expires - created AS lifetime FROM fob_claims').first()).toEqual({ fob_id: 4294967295, lifetime: 300 });
  });

  it('rejects unauthenticated, malformed, and excessive scans with kiosk-readable errors', async () => {
    quiet();
    for (const authorization of [null, 'Bearer wrong']) expect((await scan({ fob_id: 7 }, authorization)).status).toBe(401);
    for (const body of ['not json', 'null', { fob_id: 0 }, { fob_id: '7' }, { fob_id: 4294967296 }, { fob: 7 }]) {
      const response = await scan(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Fob not recognized. Scan again.' });
    }
    for (let i = 0; i < 30; i++) expect((await scan({ fob_id: 7 })).status).toBe(201);
    expect(await (await scan({ fob_id: 7 })).json()).toEqual({ error: 'Too many scans. Please wait a minute.' });
  });

  it('signs visitors in, confirms on GET, and links on POST', async () => {
    const token = await claim();
    const m = await insertMember({ discord_user_id: discordID, discord_username: 'Maker', fob_id: 99, non_billable: 1 });
    const cookie = await session(discordID);
    expect((await call(`/keyfob/bind?token=${token}`)).headers.get('Location')).toBe(`/login?next=${encodeURIComponent(`/keyfob/bind?token=${token}`)}`);
    const confirm = await call(`/keyfob/bind?token=${token}`, { headers: { Cookie: cookie } });
    expect(await confirm.text()).toContain('replaces fob <strong>99');
    expect((await readMember(m.member_id)).fob_id).toBe(99);
    const response = await bind(token, cookie);
    expect(await response.text()).toContain('Fob 123 is now linked');
    expect((await readMember(m.member_id)).fob_id).toBe(123);
    expect(edge.fobs).toEqual([123]);
    quiet();
    expect((await bind(token, cookie)).status).toBe(409);
  });

  it('rejects invalid, expired, conflicting, and cross-origin redemptions', async () => {
    quiet();
    await insertMember({ discord_user_id: discordID, fob_id: 456 });
    await insertMember({ fob_id: 123 });
    const cookie = await session(discordID);
    for (const token of ['bogus', randomToken()]) expect((await bind(token, cookie)).status).toBe(410);
    const token = await claim();
    expect((await call(`/keyfob/bind?token=${token}`, post({}, { Cookie: cookie, Origin: 'https://evil.example' }), edgeEnv)).status).toBe(403);
    expect((await bind(token, '')).status).toBe(401);
    expect((await bind(token, cookie)).status).toBe(409);
    expect((await env.DB.prepare('SELECT claimed_by FROM fob_claims').first()).claimed_by).toBeNull();
    vi.spyOn(Date, 'now').mockReturnValue((now() + 301) * 1000);
    expect((await bind(token, cookie)).status).toBe(410);
  });
});

describe('Printer access', () => {
  const discordID = '333333333333333333';
  let row, cookie;
  const data = (session = cookie, bindings = edgeEnv) => call('/machines/data', { headers: session ? { Cookie: session } : {} }, bindings);
  beforeEach(async () => {
    row = await insertMember({ discord_user_id: discordID, stripe_subscription_state: 'active', legacy_waiver_signed: 1 });
    cookie = await session(discordID);
    quiet();
  });

  it('issues read-only, verifiable 60-second credentials', async () => {
    const response = await data();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = await response.json();
    expect(result.edge).toBe(edgeEnv.EDGE_URL);
    const [header, payload, signature] = result.token.split('.');
    const claims = parse(payload);
    expect(claims).toMatchObject({ sub: row.member_id, scope: 'printers:read', iss: env.SITE_URL, aud: edgeEnv.EDGE_URL });
    expect(claims.exp - claims.iat).toBe(60);
    const jwks = await (await edgeJWKS(null, edgeEnv)).json();
    const verifier = await crypto.subtle.importKey('jwk', jwks.keys[0], 'Ed25519', false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', verifier, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['active', 1, 0, 0, 200], ['trialing', 1, 0, 0, 200], ['active', 0, 0, 0, 403],
    ['past_due', 1, 0, 0, 403], ['', 1, 1, 0, 200], ['', 0, 1, 0, 403], ['', 0, 0, 1, 200],
  ])('applies access eligibility: %s/%s/%s/%s', async (state, waiver, legacy, nonBillable, expected) => {
    await env.DB.prepare('UPDATE members SET stripe_subscription_state = ?, legacy_waiver_signed = ?, legacy_billing = ?, non_billable = ?')
      .bind(state, waiver, legacy, nonBillable).run();
    expect((await data()).status).toBe(expected);
  });

  it('rejects missing sessions, deleted members, and unsafe edge configuration', async () => {
    expect((await data(null)).status).toBe(401);
    for (const origin of ['', 'http://edge.example', 'https://edge.example/path']) {
      expect((await data(cookie, { ...edgeEnv, EDGE_URL: origin })).status).toBe(503);
    }
    await env.DB.prepare('DELETE FROM members').run();
    expect((await data()).status).toBe(401);
  });
});
