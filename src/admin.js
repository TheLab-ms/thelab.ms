import { boundedText, cookie, cookieHeader, discordID, escapeHTML as e, hash, HttpError, origin, redirect } from './http.js';
import { finishLogin, issueToken, loginDestination, startLogin, verifyToken } from './auth.js';
import { coordinated, createMember } from './membership.js';
import { logError, requestContext } from './logging.js';
import { editor, memberList, newMember, page } from './admin-views.js';
import { memberListParams, memberListURL } from './admin-search.js';
import { eventListParams, eventListURL, queryEvents, recentMemberEvents } from './member-events.js';
import { eventList } from './event-views.js';
import { memberName, memberPath } from './member-metadata.js';
import { memberWaivers } from './waiver.js';
import { edgeCall } from './edge-sync.js';
import { fobEnabledSQL, waiverSignedSQL } from './fob-access.js';

const PAGE_SIZE = 25;

export function adminConfigured(env) {
  if (!discordID.test(env.DISCORD_ADMIN_ROLE_ID || '')) throw new HttpError(503, 'Admin access is temporarily unavailable. Please contact leadership.');
}

function requireRole(env, member) {
  adminConfigured(env);
  if (!Array.isArray(member.roles) || !member.roles.includes(env.DISCORD_ADMIN_ROLE_ID)) throw new HttpError(403, 'Admin access is required to view this page.');
}

export async function finishAdminLogin(env, user, guildMember, destination) {
  requireRole(env, guildMember);
  return finishLogin(env, `${origin(env)}${loginDestination(destination, 'admin')}`, 'admin', await issueToken(env, user.id, 'admin'));
}

async function list(request, env, csrf) {
  const { current, query, filters } = memberListParams(new URL(request.url).searchParams);
  const columns = ['discord_user_id', 'discord_username', 'discord_email', 'billing_name', 'billing_email', 'name_override', 'email', 'waiver_name', 'fob_id'];
  const conditions = query ? [`(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`] : [];
  const values = query ? columns.map(() => `%${query.replace(/[\\%_]/g, '\\$&')}%`) : [];
  if (filters.waiver !== 'all') conditions.push(`${waiverSignedSQL} = ${filters.waiver === 'signed' ? 1 : 0}`);
  if (filters.discord !== 'all') conditions.push(`discord_user_id IS ${filters.discord === 'linked' ? 'NOT ' : ''}NULL`);
  if (filters.payment !== 'all') {
    conditions.push(`(CASE WHEN non_billable = 1 THEN 'non_billable'
      WHEN legacy_billing = 1 THEN 'legacy_billing'
      WHEN stripe_subscription_state IN ('active', 'trialing') THEN 'stripe_active'
      ELSE 'inactive' END) = ?`);
    values.push(filters.payment);
  }
  const filter = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const [count, members] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM members${filter}`).bind(...values),
    env.DB.prepare(`SELECT member_id, email, waiver_name, discord_user_id, discord_username, discord_email, created, bill_annually, discount_type, non_billable, legacy_billing,
      ${waiverSignedSQL} AS waiver_signed,
      name_override, billing_name, stripe_subscription_id, stripe_subscription_state, stripe_synced_at FROM members${filter} ORDER BY created DESC, discord_user_id DESC, member_id DESC LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (current - 1) * PAGE_SIZE),
  ]);
  const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (current > pages) return redirect(memberListURL(pages, query, filters));
  return memberList(members.results, { total, current, pages, query, filters }, env, csrf);
}

async function readForm(request, env, csrf) {
  const submittedOrigin = request.headers.get('Origin'), expectedOrigin = origin(env);
  if (submittedOrigin !== expectedOrigin) {
    // Report only a parsed origin, never raw headers, credentials, or URL queries.
    let received = submittedOrigin === null ? 'missing' : submittedOrigin === 'null' ? 'null (opaque origin; check the page Referrer-Policy)' : 'invalid';
    if (submittedOrigin && submittedOrigin !== 'null') {
      try {
        const url = new URL(submittedOrigin);
        if (['http:', 'https:'].includes(url.protocol)) received = url.origin;
      } catch { /* Keep malformed header contents out of traces. */ }
    }
    const error = new HttpError(403, 'The form’s origin could not be verified. Reload the admin page from the configured site address and try again.');
    error.cause = new Error(`Admin form Origin check failed: expected ${expectedOrigin}; received ${received}. Request rejected before performing the admin action.`);
    throw error;
  }
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the member edit form.');
  const form = new URLSearchParams(await boundedText(request, 128 * 1024));
  if ([...form.keys()].some(key => form.getAll(key).length !== 1) || form.get('csrf') !== csrf) throw new HttpError(403, 'Your form expired. Reload this page and try again.');
  return Object.fromEntries(form);
}

async function history(request, env, csrf, member) {
  const url = new URL(request.url);
  const params = eventListParams(url.searchParams);
  const result = await queryEvents(env, { ...params, memberID: member?.member_id });
  if (result.current > result.pages) return redirect(eventListURL(url.pathname, result.pages, params.type));
  return page(member ? `History for ${memberName(member)}` : 'Member history', eventList(result, url.pathname, member), csrf, 200, env);
}

export async function adminRequest(request, env, context = requestContext(request)) {
  const url = new URL(request.url), path = url.pathname;
  const match = path.match(/^\/admin\/members\/([1-9][0-9]{16,19}|[a-f0-9]{32})(\/events|\/checkout|\/delete)?$/);
  const creating = path === '/admin/members/new';
  const methods = path === '/admin' || path === '/admin/' || path === '/admin/events' || match?.[2] === '/events' ? ['GET'] : path === '/admin/logout' || path === '/admin/edge/resync' || ['/checkout', '/delete'].includes(match?.[2]) ? ['POST'] : match || creating ? ['GET', 'POST'] : [];
  if (!methods.length) {
    logError('admin.rejected', new HttpError(404, 'Admin page not found.'), context, env);
    return page('Not found', '<p>This admin page does not exist. <a href="/admin">Return to members</a>.</p>', null, 404);
  }
  if (!methods.includes(request.method)) {
    logError('admin.rejected', new HttpError(405, 'Method not allowed.'), context, env);
    return new Response('Method not allowed', { status: 405, headers: { Allow: methods.join(', '), 'Cache-Control': 'no-store' } });
  }
  let csrf;
  try {
    adminConfigured(env);
    const token = cookie(request, 'thelab_admin');
    const claims = await verifyToken(env, token, 'admin');
    if (!claims) return startLogin(request, env, 'admin');
    csrf = await hash(`admin-csrf:${token}`);
    const fields = request.method === 'POST' ? await readForm(request, env, csrf) : null;
    if (path === '/admin/logout') {
      const response = redirect('/');
      response.headers.set('Set-Cookie', cookieHeader(env, 'thelab_admin', '', 0));
      return response;
    }
    // Admin tokens are issued only after the OAuth role check. Trust that
    // authorization until the signed session expires, without a Discord round trip.
    if (path === '/admin/edge/resync') {
      await edgeCall(env, 'full');
      return page('Cache sync complete', '<p role="status">The complete authorized fob set and event signing key were sent to edgeproxy. Swipe events are pushed automatically.</p><p><a href="/admin/events?event_type=FobSwipe">View swipes</a></p>', csrf, 200, env);
    }
    if (path === '/admin/events') return await history(request, env, csrf);
    if (creating) {
      if (!fields) return newMember(null, csrf, env);
      try {
        const member = await createMember(env, fields);
        return redirect(`${memberPath(member)}?created=1`);
      } catch (error) {
        logError('admin.create_failed', error, context, env);
        return newMember(fields, csrf, env, error instanceof HttpError ? error.message : 'Creating the member failed. Please try again.', error instanceof HttpError ? error.status : 500);
      }
    }
    if (!match) return await list(request, env, csrf);
    const member = await env.DB.prepare(`SELECT *, COALESCE(${fobEnabledSQL}, 0) AS fob_enabled
      FROM members WHERE ${match[1].length === 32 ? 'member_id' : 'discord_user_id'} = ?`).bind(match[1]).first();
    if (!member) throw new HttpError(404, 'Member not found.');
    if (match[2] === '/delete') {
      await coordinated(env, member.member_id, 'deleteMember');
      return redirect('/admin');
    }
    if (match[2] === '/events') return await history(request, env, csrf, member);
    if (match[2] === '/checkout') {
      let checkoutURL = '', message = 'Checkout link ready to share.', status = 200;
      try { checkoutURL = (await coordinated(env, member.member_id, 'adminCheckout')).url; }
      catch (error) {
        logError('admin.checkout_failed', error, context, env);
        message = error instanceof HttpError ? error.message : 'Generating the checkout link failed. Please try again.';
        status = error instanceof HttpError ? error.status : 500;
      }
      const [updated, events, waivers] = await Promise.all([
        env.DB.prepare(`SELECT *, COALESCE(${fobEnabledSQL}, 0) AS fob_enabled FROM members WHERE member_id = ?`).bind(member.member_id).first(),
        recentMemberEvents(env, member.member_id), memberWaivers(env, member),
      ]);
      return editor(updated, null, csrf, env, message, status, events, waivers, checkoutURL);
    }
    if (fields) {
      try { await coordinated(env, member.member_id, 'updateMetadata', { fields }); }
      catch (error) {
        logError('admin.save_failed', error, context, env);
        let message = error instanceof HttpError ? error.message : 'Saving failed. Please try again.';
        let events = [], waivers = '';
        try {
          [events, waivers] = await Promise.all([
            recentMemberEvents(env, member.member_id), memberWaivers(env, member),
          ]);
        } catch (refreshError) {
          // Keep the submitted draft even if ancillary reads fail.
          logError('admin.refresh_failed', refreshError, context, env);
          message += ` ${refreshError instanceof HttpError ? refreshError.message : 'Could not refresh member history. Reload to retry.'}`;
        }
        return editor(member, fields, csrf, env, message, error instanceof HttpError ? error.status : 500, events, waivers);
      }
      return redirect(`${memberPath({ ...member, discord_user_id: fields.discord_user_id.trim() })}?saved=1`);
    }
    const [events, waivers] = await Promise.all([
      recentMemberEvents(env, member.member_id), memberWaivers(env, member),
    ]);
    return editor(member, null, csrf, env, url.searchParams.get('saved') === '1' ? 'Member metadata saved.' : url.searchParams.get('created') === '1' ? 'Member created. Open Billing info to generate a checkout link.' : '', 200, events, waivers);
  } catch (error) {
    logError('admin.failed', error, context, env);
    if (path === '/admin/edge/resync' && csrf && error.status === 503) {
      return page('Cache sync pending', `<p role="alert">${e(error.message)}</p><p><a href="/admin">Return to members</a></p>`, csrf, 503, env);
    }
    return page('Admin access', `<p role="alert">${e(error instanceof HttpError ? error.message : 'Admin is temporarily unavailable. Please try again.')}</p><p><a href="${e(path + url.search)}">Retry</a> · <a href="/admin">Return to members</a> · <a href="/admin/login">Sign in again</a></p>`, csrf, error instanceof HttpError ? error.status : 500, env);
  }
}
