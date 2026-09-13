import { signedInMember, startLogin } from './auth.js';
import { HttpError, now, origin, randomToken, redirect } from './http.js';
import { grantsMembership } from './membership-policy.js';
import { encodeBase64URL as encode, encodeJSON as json } from './encoding.js';

export function printerOrigin(env) {
  try {
    const url = new URL(env.PRINTER_EDGE_URL);
    if (url.protocol === 'https:' && url.origin === env.PRINTER_EDGE_URL) return url.origin;
  } catch { /* Report a configuration error below. */ }
  throw new HttpError(503, 'Machine status access is not configured. Set PRINTER_EDGE_URL to the HTTPS edge origin.');
}

export async function printerAccess(request, env) {
  const edge = printerOrigin(env);
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  // A visit from the main site first establishes a nonce cookie on the edge host.
  if (!url.search) return redirect(`${edge}/machines/login`);
  if (!/^[a-f0-9]{64}$/.test(state || '') || url.searchParams.size !== 1) throw new HttpError(400, 'Invalid machine status sign-in. Please start again from the Machines page.');
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  if (!grantsMembership(member.stripe_subscription_state)) throw new HttpError(403, 'An active membership is required to view machine status.');
  let key;
  try {
    const bytes = Uint8Array.from(atob(env.PRINTER_JWT_PRIVATE_KEY), c => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', false, ['sign']);
  } catch {
    throw new HttpError(503, 'Machine status access signing is not configured correctly.');
  }
  const issued = now();
  const data = `${json({ alg: 'EdDSA', typ: 'JWT' })}.${json({
    iss: origin(env), aud: edge, sub: member.discord_user_id, member_id: member.member_id,
    active_member: true, scope: 'printers:read', state, iat: issued, exp: issued + 300, jti: randomToken(),
  })}`;
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(data));
  // Fragments never reach HTTP access logs or the callback's Referer header.
  return redirect(`${edge}/machines/callback#token=${data}.${encode(new Uint8Array(signature))}`);
}
