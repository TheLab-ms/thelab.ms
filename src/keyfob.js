import { signedInMember, startLogin } from './auth.js';
import { boundedText, cookie, escapeHTML as e, hash, HttpError, origin } from './http.js';
import { fobClaim } from './fob-claims.js';
import { coordinated } from './membership.js';

function page(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"></head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1>${e(title)}</h1>${body}</section></main></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export async function bindFob(request, env) {
  const params = new URL(request.url).searchParams;
  if (params.getAll('token').length !== 1) throw new HttpError(400, 'Scan a fob enrollment QR code at the makerspace first.');
  const token = params.get('token');
  const claim = await fobClaim(env, token);
  if (claim.claimed_by !== null) throw new HttpError(409, 'This QR code has already been used. Scan your fob again.');
  const member = await signedInMember(request, env);
  if (!member) {
    if (request.method === 'GET') return startLogin(request, env, 'member');
    throw new HttpError(401, 'Your sign-in expired. Reload this enrollment link to sign in again.');
  }
  const csrf = await hash(`fob-csrf:${cookie(request, 'thelab_member')}:${token}`);
  if (request.method === 'GET') {
    return page('Link your fob', `<p>Signed in as <strong>${e(member.discord_username)}</strong> (Discord ${e(member.discord_user_id)}).</p><p>Link fob <strong>${claim.fob_id}</strong> to your membership.</p>
      ${member.fob_id && member.fob_id !== claim.fob_id ? `<p>This replaces fob <strong>${member.fob_id}</strong>. Your previous fob will lose your membership’s door access after synchronization.</p>` : ''}
      <p>This code expires at ${e(new Date(claim.expires * 1000).toISOString())}. Door access follows your membership and waiver status.</p>
      <form method="post" action="/keyfob/bind?token=${e(token)}"><input type="hidden" name="csrf" value="${csrf}"><button class="btn btn-primary" type="submit">Link fob</button></form>`);
  }
  if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'We couldn’t process your request. Reload this page and try again.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the enrollment form.');
  const form = new URLSearchParams(await boundedText(request, 2048));
  if (form.getAll('csrf').length !== 1 || form.get('csrf') !== csrf) throw new HttpError(403, 'Invalid enrollment form. Reload this page and try again.');
  await coordinated(env, member.member_id, 'linkFob', { token, discord_user_id: member.discord_user_id, auth_version: member.auth_version });
  return page('Fob linked', `<p role="status">Fob ${claim.fob_id} is now linked to your membership.</p><p>Door access follows your membership and waiver status. Door changes take effect after synchronization.</p><p>You can close this page.</p>`);
}
