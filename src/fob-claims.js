import { HttpError, json, now, opaque } from './http.js';
import { armEdge, edgeRequest, kickEdge } from './edge-sync.js';

export function cleanupFobClaims(env) {
  return env.DB.prepare('DELETE FROM fob_claims WHERE expires <= ?').bind(now()).run();
}

export async function fobClaimStatus(request, env) {
  const params = new URL(request.url).searchParams;
  const token = params.get('token');
  if (params.getAll('token').length !== 1 || !opaque.test(token || '')) throw new HttpError(410, 'Invalid enrollment code.');
  const claim = await env.DB.prepare('SELECT claimed_by FROM fob_claims WHERE id = ? AND expires > ?').bind(token, now()).first();
  return json({ claimed: Boolean(claim?.claimed_by) });
}

export async function fobClaim(env, token) {
  if (typeof token !== 'string' || !opaque.test(token)) {
    throw new HttpError(410, 'This QR code is invalid or expired. Scan your fob at the kiosk again.');
  }
  // Once verified, D1 owns redemption so assignment and consumption stay atomic.
  const existing = await env.DB.prepare('SELECT * FROM fob_claims WHERE id = ?').bind(token).first();
  if (existing) {
    if (existing.expires <= now()) throw new HttpError(410, 'This QR code expired. Scan your fob at the kiosk again.');
    return existing;
  }
  let response, claim;
  try {
    response = await edgeRequest(env, `/api/kiosk/claim?token=${token}`);
    if (response.status === 200) claim = JSON.parse(response.text);
  } catch {
    throw new HttpError(503, 'Fob enrollment is temporarily unavailable. Please try again.');
  }
  if (response.status === 410) throw new HttpError(410, 'This QR code expired. Scan your fob at the kiosk again.');
  if (!claim || claim.id !== token || !Number.isInteger(claim.fob_id) || claim.fob_id < 1 || claim.fob_id > 4294967295
    || !Number.isInteger(claim.created) || !Number.isInteger(claim.expires) || claim.created > now() + 5
    || claim.expires <= claim.created || claim.expires - claim.created > 300) {
    throw new HttpError(503, 'Fob enrollment is temporarily unavailable. Please try again.');
  }
  if (claim.expires <= now()) throw new HttpError(410, 'This QR code expired. Scan your fob at the kiosk again.');
  await cleanupFobClaims(env);
  await env.DB.prepare('INSERT INTO fob_claims(id, fob_id, created, expires) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
    .bind(claim.id, claim.fob_id, claim.created, claim.expires).run();
  return env.DB.prepare('SELECT * FROM fob_claims WHERE id = ?').bind(token).first();
}

export async function linkFob(env, member, input) {
  // Executed inside the same member lock as admin edits and identity changes.
  if (member.discord_user_id !== input.discord_user_id || member.auth_version !== input.auth_version) {
    throw new HttpError(401, 'Please sign in again to continue.');
  }
  const claim = await fobClaim(env, input.token);
  await armEdge(env);
  let result;
  try {
    result = await env.DB.prepare(`UPDATE fob_claims SET claimed_by = ?
      WHERE id = ? AND claimed_by IS NULL AND expires > ?
      AND EXISTS (SELECT 1 FROM members WHERE member_id = ? AND discord_user_id = ? AND auth_version = ?)
      RETURNING id`).bind(member.member_id, claim.id, now(), member.member_id, input.discord_user_id, input.auth_version).first();
  } catch (error) {
    if (String(error).includes('members.fob_id')) throw new HttpError(409, 'That fob belongs to another member. Please ask leadership to reassign it.');
    throw error;
  }
  if (!result) throw new HttpError(409, 'This QR code expired or has already been used. Scan your fob again.');
  await kickEdge(env);
}
