import { verifyToken } from './auth.js';
import { HttpError, now } from './http.js';
import { armEdge, kickEdge } from './edge-sync.js';

export async function fobClaim(env, token) {
  const claims = await verifyToken(env, token, 'fob');
  if (!claims || !Number.isInteger(claims.fob_id) || claims.fob_id < 1 || claims.fob_id > 4294967295) {
    throw new HttpError(410, 'This QR code is invalid or expired. Scan your fob at the kiosk again.');
  }
  const claim = await env.DB.prepare('SELECT * FROM fob_claims WHERE id = ? AND fob_id = ? AND expires = ? AND expires > ?')
    .bind(claims.sub, claims.fob_id, claims.exp, now()).first();
  if (!claim) throw new HttpError(410, 'This QR code expired. Scan your fob at the kiosk again.');
  return claim;
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
