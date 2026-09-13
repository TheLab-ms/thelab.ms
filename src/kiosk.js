import qrcode from 'qrcode-generator';
import { issueToken, signedInMember, startLogin, verifyToken } from './auth.js';
import { boundedText, cookie, escapeHTML as e, hash, HttpError, json, now, origin, randomToken } from './http.js';
import { fobClaim } from './fob-claims.js';
import { requireKioskNetwork } from './kiosk-network.js';
import { coordinated } from './membership.js';

function page(title, body, kiosk = false) {
  const content = kiosk ? body : `<main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1>${e(title)}</h1>${body}</section></main>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"><link rel="stylesheet" href="/kiosk.css">${kiosk ? '<script src="/kiosk.js" defer></script>' : ''}</head><body class="membership-page${kiosk ? ' kiosk-page' : ''}">${content}</body></html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function sameOrigin(request, env) {
  if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'We couldn’t process your request. Reload this page and try again.');
}

export function cleanupFobClaims(env) {
  return env.DB.prepare('DELETE FROM fob_claims WHERE expires <= ?').bind(now()).run();
}

export async function kioskPage(request, env) {
  await requireKioskNetwork(request, env);
  return page('Link your key fob', `<div class="kiosk-shell">
    <header class="kiosk-header"><div class="kiosk-brand"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab<span>Everyone’s makerspace</span></div><span class="kiosk-label">Key fob station</span></header>
    <main id="kiosk" class="kiosk-main" data-state="ready">
      <section id="standby" class="kiosk-standby" aria-labelledby="kiosk-title">
        <div class="kiosk-reader" aria-hidden="true"><svg viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="24" y="39" width="56" height="40" rx="8" transform="rotate(-12 52 59)"/><circle cx="39" cy="60" r="5"/><path d="M86 43a25 25 0 0 1 0 34M96 33a39 39 0 0 1 0 54"/></svg></div>
        <p class="kiosk-eyebrow">Make yourself at home</p><h1 id="kiosk-title">Tap your fob.<br><span>Start making.</span></h1>
        <p class="kiosk-intro">Hold your key fob near the reader<br>to link it to your membership.</p>
      </section>
      <section id="claim" class="kiosk-claim" aria-labelledby="claim-title" hidden>
        <div class="kiosk-claim-copy"><p class="kiosk-eyebrow">One more step</p><h1 id="claim-title">Finish on<br>your phone.</h1><p>Scan this QR code with your phone’s camera, sign in through Discord, then tap <strong>Link fob</strong>.</p><p id="expiry" class="kiosk-expiry"></p><button id="done" type="button" class="btn btn-outline">Cancel / start over</button></div>
        <div class="kiosk-qr-card"><img id="qr" alt="Scan to link your key fob"><p>Your membership. Your key.</p></div>
      </section>
      <div class="kiosk-status"><span class="kiosk-status-dot" aria-hidden="true"></span><p id="status" role="status" aria-live="polite">Ready when you are. Just tap your fob.</p></div>
      <noscript><p class="kiosk-noscript">Enable JavaScript to use the fob reader and display QR codes.</p></noscript>
    </main>
    <footer class="kiosk-footer"><ol><li><span>01</span> Tap your fob</li><li><span>02</span> Scan the QR code</li><li><span>03</span> Link with Discord</li></ol><p>Need a hand? Ask a member.</p></footer>
    </div>`, true);
}

export async function kioskClaims(request, env) {
  await requireKioskNetwork(request, env);
  if (request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    if (params.getAll('token').length !== 1) throw new HttpError(400, 'Scan your fob at the kiosk to get started.');
    const claim = await fobClaim(env, params.get('token'));
    return json({ claimed: claim.claimed_by !== null, expires: claim.expires });
  }
  sameOrigin(request, env);
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Fob not recognized. Scan again.');
  let input;
  try { input = JSON.parse(await boundedText(request, 1024)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Fob not recognized. Scan again.'); }
  const fob = input?.fob_id;
  if (!Number.isInteger(fob) || fob < 1 || fob > 4294967295) throw new HttpError(400, 'Fob not recognized. Scan again.');
  const token = await issueToken(env, randomToken(), 'fob', { fob_id: fob });
  const claims = await verifyToken(env, token, 'fob');
  const url = `${origin(env)}/keyfob/bind?token=${token}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  await cleanupFobClaims(env);
  const saved = await env.DB.prepare(`INSERT INTO fob_claims(id, fob_id, created, expires)
    SELECT ?, ?, ?, ? WHERE (SELECT count(*) FROM fob_claims WHERE created > ?) < 30 RETURNING id`)
    .bind(claims.sub, fob, claims.iat, claims.exp, now() - 60).first();
  if (!saved) throw new HttpError(429, 'Too many scans. Please wait a minute.');
  return json({ token, url, expires: claims.exp, qr: `data:image/svg+xml;base64,${btoa(qr.createSvgTag({ cellSize: 6, margin: 24 }))}` }, 201);
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
  sameOrigin(request, env);
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the enrollment form.');
  const form = new URLSearchParams(await boundedText(request, 2048));
  if (form.getAll('csrf').length !== 1 || form.get('csrf') !== csrf) throw new HttpError(403, 'Invalid enrollment form. Reload this page and try again.');
  await coordinated(env, member.member_id, 'linkFob', { token, discord_user_id: member.discord_user_id, auth_version: member.auth_version });
  return page('Fob linked', `<p role="status">Fob ${claim.fob_id} is now linked to your membership.</p><p>Door access follows your membership and waiver status. Door changes take effect after synchronization.</p><p>You can close this page.</p>`);
}
