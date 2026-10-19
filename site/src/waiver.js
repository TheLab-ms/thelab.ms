// Waiver signatures. The waiver text and form live in static/waiver.html.
import {
  HttpError, currentMember, escapeHTML as e, grantsMembership, origin, page, provider, readForm, redirect, validEmail,
} from './lib.js';
import { pushFobs } from './edge.js';

// Increment with static/waiver.html whenever the waiver text changes.
export const WAIVER_VERSION = 2;

async function verifyHuman(request, env, token) {
  if (!env.TURNSTILE_SECRET_KEY) return;
  if (!token) throw new HttpError(400, 'Please complete the human verification and try again.');
  const result = await provider('Cloudflare verification', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get('CF-Connecting-IP') || '' }).toString(),
  });
  if (result.success !== true || result.hostname !== new URL(origin(env)).hostname || result.action !== 'waiver') {
    throw new HttpError(400, 'Human verification failed or expired. Please go back and complete it again.');
  }
}

export async function signWaiver(request, env) {
  const form = await readForm(request);
  const name = (form.name || '').trim(), email = (form.email || '').trim().toLowerCase();
  if (form.version !== String(WAIVER_VERSION)) throw new HttpError(409, 'The waiver has changed. Please reload it, review the new version, and sign again.');
  if (form.agree_signature !== 'on' || form.agree_terms !== 'on') throw new HttpError(400, 'You must agree to all waiver terms.');
  if (!name || name.length > 160 || /[\x00-\x1f\x7f]/.test(name)) throw new HttpError(400, 'Enter your legal name (up to 160 characters).');
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  await verifyHuman(request, env, form['cf-turnstile-response']);

  // Signed-in members sign for their own membership. Otherwise match the
  // email, creating a pre-registered member, but never pick between two.
  const member = await currentMember(request, env);
  const insert = `INSERT INTO waivers (version, name, email, content, agreements, member_id)`;
  let signed;
  if (member) {
    signed = await env.DB.prepare(`${insert} VALUES (?, ?, ?, '', '[]', ?) RETURNING id`).bind(WAIVER_VERSION, name, email, member.member_id).first();
  } else {
    const [, inserted] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO members (email) SELECT ?1 WHERE NOT EXISTS
        (SELECT 1 FROM members WHERE email = ?1 OR discord_email = ?1) ON CONFLICT DO NOTHING`).bind(email),
      env.DB.prepare(`${insert} SELECT ?1, ?2, ?3, '', '[]', member_id FROM members WHERE (email = ?3 OR discord_email = ?3)
        AND (SELECT COUNT(*) FROM members WHERE email = ?3 OR discord_email = ?3) = 1 RETURNING id`).bind(WAIVER_VERSION, name, email),
    ]);
    signed = inserted.results[0];
  }
  if (!signed) throw new HttpError(409, 'We couldn’t link your waiver to a membership. Please contact leadership.');
  await pushFobs(env);
  if (member && !member.non_billable && !member.legacy_billing && !grantsMembership(member.stripe_subscription_state)) return redirect('/checkout');
  return page('Waiver signed', `<p role="status">Thanks, ${e(name)}. Your waiver has been recorded.</p>
    <p>Signature #${signed.id} · version ${WAIVER_VERSION} · ${e(email)} · ${e(new Date().toISOString())}</p>
    <div class="membership-actions"><a class="btn btn-primary" href="/">Done</a></div>`);
}
