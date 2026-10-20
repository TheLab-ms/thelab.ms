// Edge proxy integration: signing, fob list pushes, swipes, kiosk claims, and printer tokens.
import { renderSVG } from 'uqr';
import {
  HttpError, base64url, currentMember, encodeJSON, escapeHTML as e, hex, json, logError, loginRedirect,
  memberAccessSQL, memberQuery, fobEnabledSQL, now, origin, page, randomToken, readSession, redirect,
} from './lib.js';

const encoder = new TextEncoder();

export function edgeOrigin(env) {
  try {
    const url = new URL(env.EDGE_URL);
    if (url.protocol === 'https:' && url.origin === env.EDGE_URL) return url.origin;
  } catch { /* Reported below. */ }
  throw new HttpError(503, 'Machine status is temporarily unavailable. Please try again later.');
}

// ────────────────────────────────────────────────────────────────────────
// Worker-to-edge signing; the edge verifies tokens using the published JWKS
// ────────────────────────────────────────────────────────────────────────

const signingKeys = new WeakMap();

async function signingKey(env) {
  const cached = signingKeys.get(env);
  if (cached?.secret === env.EDGE_JWT_PRIVATE_KEY) return cached.value;
  try {
    const bytes = Uint8Array.from(atob(env.EDGE_JWT_PRIVATE_KEY), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', true, ['sign']);
    const { x } = await crypto.subtle.exportKey('jwk', key);
    const publicKey = { crv: 'Ed25519', kty: 'OKP', x };
    // RFC 7638 thumbprint.
    const kid = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicKey))));
    const value = { key, publicKey: { ...publicKey, kid, alg: 'EdDSA', use: 'sig' } };
    signingKeys.set(env, { secret: env.EDGE_JWT_PRIVATE_KEY, value });
    return value;
  } catch {
    throw new HttpError(503, 'Edge signing key is not configured.');
  }
}

export async function edgeToken(env, printerMemberID) {
  const { key, publicKey } = await signingKey(env);
  const issued = now();
  const data = `${encodeJSON({ alg: 'EdDSA', typ: 'JWT', kid: publicKey.kid })}.${encodeJSON({
    iss: origin(env), aud: env.EDGE_URL, sub: printerMemberID ?? 'edge-sync',
    scope: printerMemberID === undefined ? 'edge:api' : 'printers:read', iat: issued, exp: issued + 60,
  })}`;
  return `${data}.${base64url(await crypto.subtle.sign('Ed25519', key, encoder.encode(data)))}`;
}

export async function edgeJWKS(_request, env) {
  const { publicKey } = await signingKey(env);
  return Response.json({ keys: [publicKey] }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

// The edge's credential for calls to the Worker. It is derived from the signing
// key, delivered with every fob push, and rotates with that key.
export async function edgeEventKey(env) {
  await signingKey(env);
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.EDGE_JWT_PRIVATE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode('edge-events')));
}

async function verifyEdgeKey(request, env) {
  const expected = encoder.encode(`Bearer ${await edgeEventKey(env)}`);
  const actual = encoder.encode(request.headers.get('Authorization') || '');
  if (actual.length !== expected.length || !crypto.subtle.timingSafeEqual(actual, expected)) throw new HttpError(401, 'Edge authentication failed.');
}

// ────────────────────────────────────────────────────────────────────────
// Authorized fob list and swipe history
// ────────────────────────────────────────────────────────────────────────

// Sends the authorized fob list after access changes. The edge ignores older
// revisions, so concurrent pushes are safe. Failures are logged; the edge asks
// for a sync when it suspects it missed one.
export async function pushFobs(env) {
  if (!env.EDGE_URL) return;
  try {
    // One batch is one D1 transaction: the revision describes exactly these fobs.
    const [revisions, rows] = await env.DB.batch([
      env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1'),
      env.DB.prepare(`SELECT fob_id FROM members WHERE ${fobEnabledSQL} ORDER BY fob_id LIMIT 513`),
    ]);
    const fobs = rows.results.map(row => row.fob_id);
    if (fobs.length > 512) throw new Error('Authorized fob set exceeds edge capacity (512).');
    const response = await fetch(`${edgeOrigin(env)}/api/fobs`, {
      method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await edgeToken(env)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: revisions.results[0].revision, fobs, key: await edgeEventKey(env) }),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error(`Edge fob push failed (${response.status}).`);
  } catch (error) {
    logError('edge.push_failed', error);
  }
}

// Unauthenticated by design: the request carries no input and can only push
// current state to EDGE_URL, so a global rate limit bounds its cost.
export async function edgeSyncRequest(_request, env, ctx) {
  const accepted = await env.DB.prepare(`UPDATE edge_changes SET sync_requested = ?1
    WHERE id = 1 AND sync_requested <= ?1 - 600 RETURNING id`).bind(now()).first();
  if (!accepted) return new Response(null, { status: 429, headers: { 'Retry-After': '600', 'Cache-Control': 'no-store' } });
  ctx.waitUntil(pushFobs(env));
  return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

const validFob = n => Number.isInteger(n) && n > 0 && n <= 4294967295;

export async function swipeWebhook(request, env, ctx) {
  await verifyEdgeKey(request, env);
  let events;
  try { events = await request.json(); } catch { throw new HttpError(400, 'Invalid swipe batch.'); }
  if (!Array.isArray(events) || events.length > 512 || !events.every(event => event
    && typeof event.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.id)
    && validFob(event.fob) && typeof event.allowed === 'boolean'
    && typeof event.controller === 'string' && event.controller.length <= 64
    && typeof event.time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(event.time)
    && Number.isFinite(Date.parse(event.time)))) throw new HttpError(400, 'Invalid swipe batch.');
  // Event IDs make redelivery idempotent; ownership is resolved at swipe time.
  const inserts = events.map(event => env.DB.prepare(`
    INSERT INTO member_events(source_event_id, created, event_type, details, member_id)
    VALUES (?1, CAST(unixepoch(?2) AS INTEGER), 'FobSwipe',
      json_object('id', ?1, 'time', ?2, 'controller', ?3, 'fob', ?4, 'allowed', ?5),
      (SELECT member_id FROM fob_assignments WHERE fob = ?4 AND started <= ?6
        AND (ended IS NULL OR ended > ?6) ORDER BY started DESC, id DESC LIMIT 1))
    ON CONFLICT(source_event_id) DO NOTHING`)
    .bind(event.id, event.time, event.controller, event.fob, event.allowed ? 1 : 0, Date.parse(event.time) / 1000));
  // The last batch also reads the revision.
  let results;
  for (let i = 0; !results || i < inserts.length; i += 50) {
    const last = i + 50 >= inserts.length;
    results = await env.DB.batch([...inserts.slice(i, i + 50), ...(last ? [env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1')] : [])]);
  }
  // A stale edge missed a push; correct it now rather than waiting for its staleness timer.
  const { revision } = results.at(-1).results[0];
  if (request.headers.get('X-Edge-Revision') !== String(revision)) ctx.waitUntil(pushFobs(env));
  return new Response(null, { status: 204 });
}

// ────────────────────────────────────────────────────────────────────────
// LAN kiosk claims and member fob binding
// ────────────────────────────────────────────────────────────────────────

// Kiosk scans arrive through the LAN edge proxy, which adds its credential.
// The page itself is only served through the edge; direct visits are sent
// there. A wrong credential fails rather than redirecting the edge to itself.
export async function kioskPage(request, env) {
  if (request.headers.has('Authorization')) {
    await verifyEdgeKey(request, env);
    return env.ASSETS.fetch(new URL('/kiosk', request.url));
  }
  let target;
  try { target = new URL('/kiosk', env.EDGE_LAN_URL); } catch { /* Reported below. */ }
  if (!['http:', 'https:'].includes(target?.protocol) || target.origin !== env.EDGE_LAN_URL) {
    throw new HttpError(404, 'The fob kiosk is only available on TheLab’s network.');
  }
  return redirect(target.href);
}

export async function kioskClaim(request, env) {
  await verifyEdgeKey(request, env);
  const unrecognized = new HttpError(400, 'Fob not recognized. Scan again.');
  let input;
  try { input = await request.json(); } catch { throw unrecognized; }
  if (!validFob(input?.fob_id)) throw unrecognized;
  const created = now();
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('DELETE FROM fob_claims WHERE expires <= ?').bind(created),
    env.DB.prepare(`INSERT INTO fob_claims(id, fob_id, created, expires)
      SELECT ?1, ?2, ?3, ?3 + 300 WHERE (SELECT COUNT(*) FROM fob_claims WHERE created > ?3 - 60) < 30
      RETURNING id, expires`).bind(randomToken(), input.fob_id, created),
  ]);
  const claim = inserted.results[0];
  if (!claim) throw new HttpError(429, 'Too many scans. Please wait a minute.');
  const url = `${origin(env)}/keyfob/bind?token=${claim.id}`;
  return json({ token: claim.id, url, expires: claim.expires, qr: `data:image/svg+xml;base64,${btoa(renderSVG(url))}` }, 201);
}

export async function bindFob(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const session = await readSession(request, env);
  const [claim, member] = /^[a-f0-9]{64}$/.test(token) ? (await env.DB.batch([
    env.DB.prepare('SELECT * FROM fob_claims WHERE id = ?').bind(token),
    memberQuery(env, session),
  ])).map(result => result.results[0] ?? null) : [null, null];
  if (!claim || claim.expires <= now()) throw new HttpError(410, 'This QR code is invalid or expired. Scan your fob at the kiosk again.');
  if (claim.claimed_by !== null) throw new HttpError(409, 'This QR code has already been used. Scan your fob again.');
  if (!member) {
    if (request.method === 'GET') return loginRedirect(url.pathname + url.search);
    throw new HttpError(401, 'Your sign-in expired. Reload this enrollment link to sign in again.');
  }
  if (request.method === 'GET') {
    return page('Link your fob', `<p>Signed in as <strong>${e(member.discord_username)}</strong>.</p><p>Link fob <strong>${claim.fob_id}</strong> to your membership.</p>
      ${member.fob_id && member.fob_id !== claim.fob_id ? `<p>This replaces fob <strong>${member.fob_id}</strong>, which will lose door access.</p>` : ''}
      <p>Door access follows your membership and waiver status.</p>
      <form method="post" action="/keyfob/bind?token=${e(token)}"><button class="btn btn-primary" type="submit">Link fob</button></form>`);
  }
  let linked;
  try {
    // The fob_claim_redeemed trigger assigns the fob in the same statement.
    linked = await env.DB.prepare(`UPDATE fob_claims SET claimed_by = ?
      WHERE id = ? AND claimed_by IS NULL AND expires > ? RETURNING id`).bind(member.member_id, token, now()).first();
  } catch (error) {
    if (String(error).includes('members.fob_id')) throw new HttpError(409, 'That fob belongs to another member. Please ask leadership to reassign it.');
    throw error;
  }
  if (!linked) throw new HttpError(409, 'This QR code expired or has already been used. Scan your fob again.');
  await pushFobs(env);
  return page('Fob linked', `<p role="status">Fob ${claim.fob_id} is now linked to your membership.</p><p>You can close this page.</p>`);
}

// ────────────────────────────────────────────────────────────────────────
// Printer dashboard credentials; the browser fetches status from the edge
// ────────────────────────────────────────────────────────────────────────

export async function machinesData(request, env) {
  const member = await currentMember(request, env, `member_id, COALESCE(${memberAccessSQL}, 0) AS printer_access`);
  if (!member) throw new HttpError(401, 'Sign in to view the printers.');
  if (!member.printer_access) throw new HttpError(403, 'An active membership with access eligibility is required to view the printers.');
  return json({ edge: edgeOrigin(env), token: await edgeToken(env, member.member_id) });
}
