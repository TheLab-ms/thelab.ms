import { boundedText, cookie, cookieHeader, discordID, escapeHTML as e, hash, HttpError, origin, redirect } from './http.js';
import { discord } from './providers.js';
import { finishLogin, issueToken, loginDestination, startLogin, verifyToken } from './auth.js';
import { coordinated } from './membership.js';
import { logError, requestContext } from './logging.js';
import { editor, memberList, page } from './admin-views.js';

const PAGE_SIZE = 25;

export function adminConfigured(env) {
  if (!discordID.test(env.DISCORD_ADMIN_ROLE_ID || '')) throw new HttpError(503, 'Admin access is not configured. Set DISCORD_ADMIN_ROLE_ID to the leadership/admin Discord role ID.');
}

function requireRole(env, member) {
  adminConfigured(env);
  if (!Array.isArray(member.roles) || !member.roles.includes(env.DISCORD_ADMIN_ROLE_ID)) throw new HttpError(403, 'You need TheLab’s configured admin Discord role to access this page.');
}

export async function finishAdminLogin(env, user, guildMember, destination) {
  requireRole(env, guildMember);
  return finishLogin(env, `${origin(env)}${loginDestination(destination, 'admin')}`, 'admin', await issueToken(env, user.id, 'admin'));
}

async function list(request, env, csrf) {
  const params = new URL(request.url).searchParams;
  const raw = params.get('page') || '1';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  const current = Number(raw);
  const [count, members] = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) AS total FROM members'),
    env.DB.prepare(`SELECT discord_user_id, discord_username, discord_email, created, bill_annually, discount_type,
      name_override, billing_name, stripe_subscription_id, stripe_subscription_state, stripe_synced_at FROM members ORDER BY created DESC, discord_user_id DESC LIMIT ? OFFSET ?`).bind(PAGE_SIZE, (current - 1) * PAGE_SIZE),
  ]);
  const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (current > pages) return redirect(`/admin?page=${pages}`);
  return memberList(members.results, { total, current, pages }, env, csrf);
}

async function readForm(request, env, csrf) {
  if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'Invalid form origin. Reload this page and try again.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the member edit form.');
  const form = new URLSearchParams(await boundedText(request, 128 * 1024));
  if ([...form.keys()].some(key => form.getAll(key).length !== 1) || form.get('csrf') !== csrf) throw new HttpError(403, 'Invalid form token. Reload this page and try again.');
  return Object.fromEntries(form);
}

export async function adminRequest(request, env, context = requestContext(request)) {
  const url = new URL(request.url), path = url.pathname;
  const match = path.match(/^\/admin\/members\/([1-9][0-9]{16,19})$/);
  const methods = path === '/admin' || path === '/admin/' ? ['GET'] : path === '/admin/logout' ? ['POST'] : match ? ['GET', 'POST'] : [];
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
      if (error.providerStatus === 404) throw new HttpError(403, 'You must be in TheLab’s Discord server with the admin role.');
      throw error;
    }
    requireRole(env, guildMember);
    if (!match) return await list(request, env, csrf);
    const member = await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(match[1]).first();
    if (!member) throw new HttpError(404, 'Member not found.');
    if (fields) {
      try { await coordinated(env, member.member_id, 'updateMetadata', { fields }); }
      catch (error) {
        logError('admin.save_failed', error, context, env);
        return editor(member, fields, csrf, env, error instanceof HttpError ? error.message : 'Saving failed. Please try again.', error instanceof HttpError ? error.status : 500);
      }
      return redirect(`/admin/members/${fields.discord_user_id.trim()}?saved=1`);
    }
    return editor(member, null, csrf, env, url.searchParams.get('saved') === '1' ? 'Member metadata saved.' : '');
  } catch (error) {
    logError('admin.failed', error, context, env);
    return page('Admin access', `<p role="alert">${e(error instanceof HttpError ? error.message : 'Admin is temporarily unavailable. Please try again.')}</p><p><a href="/admin">Return to members</a> · <a href="/admin/login">Sign in again</a></p>`, csrf, error instanceof HttpError ? error.status : 500);
  }
}
