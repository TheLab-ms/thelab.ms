import { boundedText, cookie, cookieHeader, discordID, escapeHTML as e, hash, HttpError, origin, redirect } from './http.js';
import { discord } from './providers.js';
import { finishLogin, issueToken, loginDestination, startLogin, verifyToken } from './auth.js';
import { coordinated } from './membership.js';
import { logError, requestContext } from './logging.js';
import { editor, memberList, page } from './admin-views.js';
import { memberListParams, memberListURL } from './admin-search.js';
import { eventListParams, eventListURL, queryEvents } from './member-events.js';
import { eventList } from './event-views.js';
import { memberName, memberPath } from './member-metadata.js';
import { memberWaivers } from './waiver.js';
import { edgeCall, edgeEnabled } from './edge-sync.js';
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
  const { current, query } = memberListParams(new URL(request.url).searchParams);
  const columns = ['discord_user_id', 'discord_username', 'discord_email', 'billing_name', 'billing_email', 'name_override', 'email', 'waiver_name'];
  const filter = query ? ` WHERE ${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')}` : '';
  const values = query ? columns.map(() => `%${query.replace(/[\\%_]/g, '\\$&')}%`) : [];
  const [count, members] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM members${filter}`).bind(...values),
    env.DB.prepare(`SELECT member_id, email, waiver_name, discord_user_id, discord_username, discord_email, created, bill_annually, discount_type, non_billable, legacy_billing,
      ${waiverSignedSQL} AS waiver_signed,
      name_override, billing_name, stripe_subscription_id, stripe_subscription_state, stripe_synced_at FROM members${filter} ORDER BY created DESC, discord_user_id DESC, member_id DESC LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (current - 1) * PAGE_SIZE),
  ]);
  const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (current > pages) return redirect(memberListURL(pages, query));
  return memberList(members.results, { total, current, pages, query }, env, csrf);
}

async function readForm(request, env, csrf) {
  if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'We couldn’t submit your changes. Reload this page and try again.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the member edit form.');
  const form = new URLSearchParams(await boundedText(request, 128 * 1024));
  if ([...form.keys()].some(key => form.getAll(key).length !== 1) || form.get('csrf') !== csrf) throw new HttpError(403, 'Your form expired. Reload this page and try again.');
  return Object.fromEntries(form);
}

async function history(request, env, csrf, member) {
  const url = new URL(request.url);
  const params = eventListParams(url.searchParams);
  if (edgeEnabled(env) && (!params.type || params.type === 'FobSwipe')) await edgeCall(env, 'swipes');
  const result = await queryEvents(env, { ...params, memberID: member?.member_id });
  if (result.current > result.pages) return redirect(eventListURL(url.pathname, result.pages, params.type));
  return page(member ? `History for ${memberName(member)}` : 'Member history', eventList(result, url.pathname, member), csrf);
}

export async function adminRequest(request, env, context = requestContext(request)) {
  const url = new URL(request.url), path = url.pathname;
  const match = path.match(/^\/admin\/members\/([1-9][0-9]{16,19}|[a-f0-9]{32})(\/events)?$/);
  const methods = path === '/admin' || path === '/admin/' || path === '/admin/events' || match?.[2] ? ['GET'] : path === '/admin/logout' || path === '/admin/edge/resync' ? ['POST'] : match ? ['GET', 'POST'] : [];
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
    let guildMember;
    try { guildMember = await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${claims.sub}`); }
    catch (error) {
      if (error.providerStatus === 404) throw new HttpError(403, 'Admin access is required to view this page.');
      throw error;
    }
    requireRole(env, guildMember);
    if (path === '/admin/edge/resync') {
      await edgeCall(env, 'full');
      return page('Full resync complete', '<p role="status">The complete authorized fob set was sent to edgeproxy and swipe history was backed up.</p><p><a href="/admin/events?event_type=FobSwipe">View swipes</a></p>', csrf);
    }
    if (path === '/admin/events') return await history(request, env, csrf);
    if (!match) return await list(request, env, csrf);
    const member = await env.DB.prepare(`SELECT *, COALESCE(${fobEnabledSQL}, 0) AS fob_enabled
      FROM members WHERE ${match[1].length === 32 ? 'member_id' : 'discord_user_id'} = ?`).bind(match[1]).first();
    if (!member) throw new HttpError(404, 'Member not found.');
    if (match[2]) return await history(request, env, csrf, member);
    if (fields) {
      try { await coordinated(env, member.member_id, 'updateMetadata', { fields }); }
      catch (error) {
        logError('admin.save_failed', error, context, env);
        let message = error instanceof HttpError ? error.message : 'Saving failed. Please try again.';
        let events = [], waivers = '';
        try {
          if (edgeEnabled(env)) await edgeCall(env, 'swipes');
          ({ events } = await queryEvents(env, { memberID: member.member_id, limit: 10 }));
          waivers = await memberWaivers(env, member);
        } catch (refreshError) {
          // Keep the submitted draft even if ancillary reads fail. Never render
          // stale history as though its required refresh succeeded.
          logError('admin.refresh_failed', refreshError, context, env);
          message += ` ${refreshError instanceof HttpError ? refreshError.message : 'Could not refresh member history. Reload to retry.'}`;
        }
        return editor(member, fields, csrf, env, message, error instanceof HttpError ? error.status : 500, events, waivers);
      }
      return redirect(`${memberPath({ ...member, discord_user_id: fields.discord_user_id.trim() })}?saved=1`);
    }
    if (edgeEnabled(env)) await edgeCall(env, 'swipes');
    const { events } = await queryEvents(env, { memberID: member.member_id, limit: 10 });
    return editor(member, null, csrf, env, url.searchParams.get('saved') === '1' ? 'Member metadata saved.' : '', 200, events, await memberWaivers(env, member));
  } catch (error) {
    logError('admin.failed', error, context, env);
    if (path === '/admin/edge/resync' && csrf && error.status === 503) {
      return page('Full resync pending', `<p role="alert">${e(error.message)}</p><form method="post" action="/admin/edge/resync"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="btn btn-primary" type="submit">Retry full resync</button></form><p><a href="/admin">Return to members</a></p>`, csrf, 503);
    }
    return page('Admin access', `<p role="alert">${e(error instanceof HttpError ? error.message : 'Admin is temporarily unavailable. Please try again.')}</p><p><a href="${e(path + url.search)}">Retry</a> · <a href="/admin">Return to members</a> · <a href="/admin/login">Sign in again</a></p>`, csrf, error instanceof HttpError ? error.status : 500);
  }
}
