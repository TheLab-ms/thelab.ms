import { boundedText, cookie, cookieHeader, escapeHTML as e, hash, HttpError, opaque, origin, randomToken, redirect } from './http.js';
import { signedInMember, startLogin } from './auth.js';
import { provider } from './providers.js';
import { logError } from './logging.js';
import { waiverContent } from './waiver-content.js';
import { armEdge, kickEdge } from './edge-sync.js';

// Conway's deliberately small markdown format. All text is escaped at rendering.
export function parseWaiver(content) {
  const result = { title: '', paragraphs: [], agreements: [] };
  let paragraph = [];
  const flush = () => { if (paragraph.length) result.paragraphs.push(paragraph.join(' ')); paragraph = []; };
  for (const line of content.split('\n').map(line => line.trim())) {
    const checkbox = line.match(/^-\s*\[\s*\]\s*(.+)$/);
    if (!line) flush();
    else if (line.startsWith('# ') && !result.title) result.title = line.slice(2).trim();
    else if (checkbox) { flush(); result.agreements.push(checkbox[1]); }
    else paragraph.push(line);
  }
  flush();
  return result;
}

export async function currentWaiver() {
  return { ...waiverContent, ...parseWaiver(waiverContent.content), revision: await hash(waiverContent.content) };
}

function humanVerificationEnabled(env) {
  return Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
}

async function verifyHuman(request, env, token) {
  if (!humanVerificationEnabled(env)) return;
  if (!token || token.length > 2048) throw new HttpError(400, 'Please complete the human verification and try again.');
  const result = await provider('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token,
      ...(request.headers.get('CF-Connecting-IP') ? { remoteip: request.headers.get('CF-Connecting-IP') } : {}) }).toString(),
  }, 'Cloudflare verification', { ...env, TURNSTILE_RESPONSE_TOKEN: token });
  if (result.success !== true || result.hostname !== new URL(origin(env)).hostname || result.action !== 'waiver') {
    throw new HttpError(400, 'Human verification failed or expired. Please complete it again.');
  }
}

const text = waiver => `<h1>${e(waiver.title || 'Liability waiver')}</h1><p class="signup-help">Version ${waiver.version}</p>${waiver.paragraphs.map(p => `<p>${e(p)}</p>`).join('')}`;

function publicPage(content, status = 200, verify = false) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Liability waiver | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css">${verify ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}</head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/">TheLab</a><section class="card waiver-page">${content}</section></main></body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
  });
}

function signingForm(waiver, env, { signup, csrf, name = '', email = '', error = '', status = 200 }) {
  return publicPage(`${text(waiver)}${error ? `<p class="waiver-error" role="alert">${e(error)}</p>` : ''}
    <p>${signup ? 'Sign this waiver to continue to membership checkout. Your signature will be linked to your signed-in membership, even if you use a different name or email.' : 'Anyone can sign. No Discord login is needed. Use the email on your Discord account to link this waiver when you join.'}</p>
    <form class="waiver-form" method="post" action="/waiver${signup ? '?signup=1' : ''}">
    <input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="version" value="${waiver.version}"><input type="hidden" name="revision" value="${waiver.revision}">
    ${waiver.agreements.map((label, i) => `<label class="waiver-agreement"><input type="checkbox" name="agree${i}" required>${e(label)}</label>`).join('')}
    <label for="name">Legal name</label><input id="name" name="name" autocomplete="name" maxlength="160" value="${e(name)}" required>
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" value="${e(email)}" required>
    ${humanVerificationEnabled(env) ? `<div class="cf-turnstile" data-sitekey="${e(env.TURNSTILE_SITE_KEY)}" data-action="waiver"></div>` : ''}
    <button class="btn btn-primary" type="submit">${signup ? 'Sign and continue' : 'Sign waiver'}</button></form>`, status, humanVerificationEnabled(env));
}

export async function waiverRequest(request, env) {
  const url = new URL(request.url), signup = url.searchParams.get('signup') === '1';
  const member = signup ? await signedInMember(request, env) : null;
  if (signup && !member) {
    if (request.method === 'GET') return startLogin(request, env, 'member');
    return publicPage('<h1>Please sign in again</h1><p>Your session expired. Sign in and review the waiver again before submitting.</p><a class="btn btn-primary" href="/waiver?signup=1">Continue</a>', 401);
  }
  const waiver = await currentWaiver();
  const existingNonce = cookie(request, 'thelab_waiver');
  const nonce = opaque.test(existingNonce || '') ? existingNonce : randomToken();
  // Bind signup consent to the exact login, so a switched account cannot inherit
  // a form opened for somebody else. Public forms remain independent of login.
  const csrf = await hash(`waiver:${nonce}:${signup ? cookie(request, 'thelab_member') : 'public'}`);
  const options = { signup, csrf, email: member?.discord_email || '', name: '' };
  if (request.method === 'GET') {
    const response = signingForm(waiver, env, options);
    response.headers.set('Set-Cookie', cookieHeader(env, 'thelab_waiver', nonce, 86400));
    return response;
  }
  try {
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the waiver form.');
    const form = new URLSearchParams(await boundedText(request, 16 * 1024));
    if (nonce !== existingNonce || form.get('csrf') !== csrf || [...form.keys()].some(key => form.getAll(key).length !== 1)) throw new HttpError(403, 'The form expired. Reload the waiver and try again.');
    options.name = (form.get('name') || '').trim();
    options.email = (form.get('email') || '').trim().toLowerCase();
    if (!options.name || options.name.length > 160 || /[\x00-\x1f\x7f]/.test(options.name)) throw new HttpError(400, 'Enter your legal name (up to 160 characters).');
    if (options.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(options.email)) throw new HttpError(400, 'Enter a valid email address.');
    if (form.get('version') !== String(waiver.version) || form.get('revision') !== waiver.revision) throw new HttpError(409, 'The waiver has changed. Please review the new version and agree again.');
    if (!waiver.agreements.length || waiver.agreements.some((_, i) => form.get(`agree${i}`) !== 'on')) throw new HttpError(400, 'You must agree to all waiver terms.');
    await verifyHuman(request, env, form.get('cf-turnstile-response'));
    const evidence = [waiver.version, waiver.content, options.name, options.email, JSON.stringify(waiver.agreements)];
    let signed;
    await armEdge(env);
    if (signup) {
      signed = await env.DB.prepare(`INSERT INTO waivers (version, content, name, email, agreements, member_id)
        SELECT ?, ?, ?, ?, ?, member_id FROM members WHERE member_id = ? AND discord_user_id = ? AND auth_version = ?
        RETURNING id`).bind(...evidence, member.member_id, member.discord_user_id, member.auth_version).first();
    } else {
      // Match canonical or current verified Discord email, but do not pick an
      // arbitrary account if an admin transfer/email change made it ambiguous.
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO members (email) SELECT ? WHERE NOT EXISTS
          (SELECT 1 FROM members WHERE email = ? OR discord_email = ?) ON CONFLICT DO NOTHING`)
          .bind(options.email, options.email, options.email),
        env.DB.prepare(`INSERT INTO waivers (version, content, name, email, agreements, member_id)
          SELECT ?, ?, ?, ?, ?, member_id FROM members WHERE (email = ? OR discord_email = ?)
          AND (SELECT COUNT(*) FROM members WHERE email = ? OR discord_email = ?) = 1 RETURNING id`)
          .bind(...evidence, options.email, options.email, options.email, options.email),
      ]);
      signed = results[1].results[0];
    }
    if (!signed) throw new HttpError(409, 'We couldn’t link your waiver to your membership. Please reload or contact leadership.');
    await kickEdge(env);
    if (signup) return redirect('/payment/resume');
    return publicPage(`<h1>Waiver signed</h1><p role="status">Your waiver has been submitted successfully. You can print this page for your records.</p><p>Signature #${signed.id} · ${e(new Date().toISOString())}</p>${text(waiver)}<ul>${waiver.agreements.map(a => `<li>${e(a)}</li>`).join('')}</ul><p>Signed by ${e(options.name)} · ${e(options.email)}</p><a class="btn btn-primary" href="/">Done</a>`);
  } catch (error) {
    logError('waiver.failed', error, { operation: 'sign' }, env);
    return signingForm(waiver, env, { ...options, error: error instanceof HttpError ? error.message : 'Signing failed. Please try again.', status: error instanceof HttpError ? error.status : 500 });
  }
}

export async function memberWaivers(env, member) {
  const { results } = await env.DB.prepare('SELECT * FROM waivers WHERE member_id = ? ORDER BY id DESC').bind(member.member_id).all();
  return `<section class="card admin-section"><h2>Signed waivers</h2>${results.length ? results.map(w => `<details><summary>Signature #${w.id} · Version ${w.version} · ${e(new Date(w.created * 1000).toISOString())}</summary><p>${e(w.name)} · ${e(w.email)}</p>${text({ ...w, ...parseWaiver(w.content) })}<ul>${JSON.parse(w.agreements).map(a => `<li>${e(a)}</li>`).join('')}</ul></details>`).join('') : '<p>No linked waiver.</p>'}</section>`;
}
