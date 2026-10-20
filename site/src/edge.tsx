// Edge proxy integration: signing, fob list pushes, swipes, kiosk claims, and printer tokens.
import { renderSVG } from 'uqr';
import { h, Fragment } from './html.ts';
import { page } from './page.tsx';
import {
  HttpError, base64url, encodeJSON, hex, isRecord, json, logError, loginRedirect,
  memberAccessSQL, memberQuery, fobEnabledSQL, now, origin, readSession, readToken, redirect, signToken,
  type Member,
} from './lib.ts';

const encoder = new TextEncoder();

export function edgeOrigin(env: Env) {
  try {
    const url = new URL(env.EDGE_URL);
    if (url.protocol === 'https:' && url.origin === env.EDGE_URL) return url.origin;
  } catch { /* Reported below. */ }
  throw new HttpError(503, 'Machine status is temporarily unavailable. Please try again later.');
}

// ────────────────────────────────────────────────────────────────────────
// Worker-to-edge signing; the edge verifies tokens using the published JWKS
// ────────────────────────────────────────────────────────────────────────

interface SigningKey { key: CryptoKey; publicKey: { crv: 'Ed25519'; kty: 'OKP'; x: string; kid: string; alg: 'EdDSA'; use: 'sig' } }
const signingKeys = new WeakMap<Env, { secret: string; value: SigningKey }>();

async function signingKey(env: Env): Promise<SigningKey> {
  const cached = signingKeys.get(env);
  if (cached?.secret === env.EDGE_JWT_PRIVATE_KEY) return cached.value;
  try {
    const bytes = Uint8Array.from(atob(env.EDGE_JWT_PRIVATE_KEY), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key);
    const x = jwk instanceof ArrayBuffer ? undefined : jwk.x;
    if (!x) throw new Error('Ed25519 key has no public component.');
    const publicKey = { crv: 'Ed25519', kty: 'OKP', x } as const;
    // RFC 7638 thumbprint.
    const kid = base64url(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicKey))));
    const value: SigningKey = { key, publicKey: { ...publicKey, kid, alg: 'EdDSA', use: 'sig' } };
    signingKeys.set(env, { secret: env.EDGE_JWT_PRIVATE_KEY, value });
    return value;
  } catch {
    throw new HttpError(503, 'Edge signing key is not configured.');
  }
}

// Fob pushes and sync use the edge API scope; printer dashboards read status for one member.
type EdgeGrant = { scope: 'edge:api' } | { scope: 'printers:read'; memberID: string };

export async function edgeToken(env: Env, grant: EdgeGrant = { scope: 'edge:api' }) {
  const { key, publicKey } = await signingKey(env);
  const issued = now();
  const data = `${encodeJSON({ alg: 'EdDSA', typ: 'JWT', kid: publicKey.kid })}.${encodeJSON({
    iss: origin(env), aud: env.EDGE_URL, sub: grant.scope === 'printers:read' ? grant.memberID : 'edge-sync',
    scope: grant.scope, iat: issued, exp: issued + 60,
  })}`;
  return `${data}.${base64url(await crypto.subtle.sign('Ed25519', key, encoder.encode(data)))}`;
}

export async function edgeJWKS(_request: Request, env: Env) {
  const { publicKey } = await signingKey(env);
  return Response.json({ keys: [publicKey] }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

// The edge's credential for calls to the Worker. It is derived from the signing
// key, delivered with every fob push, and rotates with that key.
export async function edgeEventKey(env: Env) {
  await signingKey(env);
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.EDGE_JWT_PRIVATE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode('edge-events')));
}

async function verifyEdgeKey(request: Request, env: Env) {
  const expected = encoder.encode(`Bearer ${await edgeEventKey(env)}`);
  const actual = encoder.encode(request.headers.get('Authorization') || '');
  if (actual.length !== expected.length || !crypto.subtle.timingSafeEqual(actual, expected)) throw new HttpError(401, 'Edge authentication failed.');
}

// ────────────────────────────────────────────────────────────────────────
// Authorized fob list and swipe history
// ────────────────────────────────────────────────────────────────────────

// The body of PUT /api/fobs; edgeproxy rejects unknown fields.
export interface FobPush { revision: number; fobs: number[]; key: string }

const revisionQuery = (env: Env) => env.DB.prepare('SELECT revision FROM edge_changes WHERE id = 1');

// Sends the authorized fob list after access changes. The edge ignores older
// revisions, so concurrent pushes are safe. Failures are logged; the edge asks
// for a sync when it suspects it missed one.
export async function pushFobs(env: Env) {
  if (!env.EDGE_URL) return;
  try {
    // One batch is one D1 transaction: the revision describes exactly these fobs.
    const [revisions, rows] = await env.DB.batch([
      revisionQuery(env),
      env.DB.prepare(`SELECT fob_id FROM members WHERE ${fobEnabledSQL} ORDER BY fob_id LIMIT 513`),
    ]);
    const revision = (revisions?.results[0] as { revision: number } | undefined)?.revision;
    const fobs = ((rows?.results ?? []) as { fob_id: number }[]).map(row => row.fob_id);
    if (revision === undefined) throw new Error('Edge revision is missing.');
    if (fobs.length > 512) throw new Error('Authorized fob set exceeds edge capacity (512).');
    const body: FobPush = { revision, fobs, key: await edgeEventKey(env) };
    const response = await fetch(`${edgeOrigin(env)}/api/fobs`, {
      method: 'PUT', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${await edgeToken(env)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error(`Edge fob push failed (${response.status}).`);
  } catch (error) {
    logError('edge.push_failed', error);
  }
}

// Unauthenticated by design: the request carries no input and can only push
// current state to EDGE_URL, so a global rate limit bounds its cost.
export async function edgeSyncRequest(_request: Request, env: Env, ctx: ExecutionContext) {
  const accepted = await env.DB.prepare(`UPDATE edge_changes SET sync_requested = ?1
    WHERE id = 1 AND sync_requested <= ?1 - 600 RETURNING id`).bind(now()).first();
  if (!accepted) return new Response(null, { status: 429, headers: { 'Retry-After': '600', 'Cache-Control': 'no-store' } });
  ctx.waitUntil(pushFobs(env));
  return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
}

const validFob = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 4294967295;

interface Swipe { id: string; fob: number; allowed: boolean; controller: string; time: string }

const isSwipe = (event: unknown): event is Swipe => isRecord(event)
  && typeof event.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event.id)
  && validFob(event.fob) && typeof event.allowed === 'boolean'
  && typeof event.controller === 'string' && event.controller.length <= 64
  && typeof event.time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(event.time)
  && Number.isFinite(Date.parse(event.time));

export async function swipeWebhook(request: Request, env: Env, ctx: ExecutionContext) {
  await verifyEdgeKey(request, env);
  let events: unknown;
  try { events = await request.json(); } catch { throw new HttpError(400, 'Invalid swipe batch.'); }
  if (!Array.isArray(events) || events.length > 512 || !events.every(isSwipe)) throw new HttpError(400, 'Invalid swipe batch.');
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
  let revision: number | undefined;
  for (let i = 0; i === 0 || i < inserts.length; i += 50) {
    const last = i + 50 >= inserts.length;
    const results = await env.DB.batch<{ revision: number }>([...inserts.slice(i, i + 50), ...(last ? [revisionQuery(env)] : [])]);
    if (last) revision = results.at(-1)?.results[0]?.revision;
  }
  // A stale edge missed a push; correct it now rather than waiting for its staleness timer.
  if (request.headers.get('X-Edge-Revision') !== String(revision)) ctx.waitUntil(pushFobs(env));
  return new Response(null, { status: 204 });
}

// ────────────────────────────────────────────────────────────────────────
// LAN kiosk claims and member fob binding
// ────────────────────────────────────────────────────────────────────────

// Kiosk scans arrive through the LAN edge proxy, which adds its credential.
// The page itself is only served through the edge; direct visits are sent
// there. A wrong credential fails rather than redirecting the edge to itself.
export async function kioskPage(request: Request, env: Env) {
  if (request.headers.has('Authorization')) {
    await verifyEdgeKey(request, env);
    return env.ASSETS.fetch(new URL('/kiosk', request.url));
  }
  let target;
  try { target = new URL('/kiosk', env.EDGE_LAN_URL); } catch { /* Reported below. */ }
  if (!target || !['http:', 'https:'].includes(target.protocol) || target.origin !== env.EDGE_LAN_URL) {
    throw new HttpError(404, 'The fob kiosk is only available on TheLab’s network.');
  }
  return redirect(target.href);
}

// A claim is a signed, five-minute token naming the scanned fob; there is no
// server-side state. Redeeming it again is harmless: the fob is already linked
// to the redeeming member, and the unique fob_id rejects anyone else.
export async function kioskClaim(request: Request, env: Env) {
  await verifyEdgeKey(request, env);
  const unrecognized = new HttpError(400, 'Fob not recognized. Scan again.');
  let input: unknown;
  try { input = await request.json(); } catch { throw unrecognized; }
  const fob = isRecord(input) ? input.fob_id : undefined;
  if (!validFob(fob)) throw unrecognized;
  const expires = now() + 300;
  const token = await signToken(env, { fob, exp: expires });
  const url = `${origin(env)}/keyfob/bind?token=${token}`;
  return json({ token, url, expires, qr: `data:image/svg+xml;base64,${btoa(renderSVG(url))}` }, 201);
}

export async function bindFob(request: Request, env: Env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || '';
  const [claim, session] = await Promise.all([readToken(env, token), readSession(request, env)]);
  const fob = claim?.fob;
  if (!validFob(fob)) throw new HttpError(410, 'This QR code is invalid or expired. Scan your fob at the kiosk again.');
  const member = await memberQuery(env, session).first<Member>();
  if (!member) {
    if (request.method === 'GET') return loginRedirect(url.pathname + url.search);
    throw new HttpError(401, 'Your sign-in expired. Reload this enrollment link to sign in again.');
  }
  const linkedPage = () => page('Fob linked', <>
    <p role="status">Fob {fob} is now linked to your membership.</p>
    <p>You can close this page.</p>
  </>);
  if (request.method === 'GET') {
    if (member.fob_id === fob) return linkedPage();
    return page('Link your fob', <>
      <p>Signed in as <strong>{member.discord_username}</strong>.</p>
      <p>Link fob <strong>{fob}</strong> to your membership.</p>
      {member.fob_id ? <p>This replaces fob <strong>{member.fob_id}</strong>, which will lose door access.</p> : null}
      <p>Door access follows your membership and waiver status.</p>
      <form method="post" action={`/keyfob/bind?token=${token}`}><button class="btn btn-primary" type="submit">Link fob</button></form>
    </>);
  }
  let changed;
  try {
    changed = await env.DB.prepare(`UPDATE members SET fob_id = ?1, metadata_version = metadata_version + 1
      WHERE member_id = ?2 AND fob_id IS NOT ?1 RETURNING member_id`).bind(fob, member.member_id).first();
  } catch (error) {
    if (String(error).includes('members.fob_id')) throw new HttpError(409, 'That fob belongs to another member. Please ask leadership to reassign it.');
    throw error;
  }
  if (changed) await pushFobs(env);
  return linkedPage();
}

// ────────────────────────────────────────────────────────────────────────
// Printer dashboard credentials; the browser fetches status from the edge
// ────────────────────────────────────────────────────────────────────────

export async function machinesData(request: Request, env: Env) {
  const member = await memberQuery(env, await readSession(request, env), `member_id, COALESCE(${memberAccessSQL}, 0) AS printer_access`)
    .first<{ member_id: string; printer_access: number }>();
  if (!member) throw new HttpError(401, 'Sign in to view the printers.');
  if (!member.printer_access) throw new HttpError(403, 'An active membership with access eligibility is required to view the printers.');
  return json({ edge: edgeOrigin(env), token: await edgeToken(env, { scope: 'printers:read', memberID: member.member_id }) });
}
