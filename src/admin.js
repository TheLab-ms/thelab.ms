import { boundedText, cookie, cookieHeader, discord, discordID, discounts, escapeHTML as e, hash, HttpError, origin, redirect } from './http.js';
import { issueToken, loginDestination, startLogin, TOKEN_AGE, verifyToken } from './auth.js';
import { coordinated } from './membership.js';
import { logError, requestContext } from './logging.js';
import { memberName } from './member-metadata.js';

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
	const token = await issueToken(env, user.id, 'admin');
	const response = redirect(`${origin(env)}${loginDestination(destination, 'admin')}`);
	response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_admin', token, TOKEN_AGE.admin));
	response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_oauth', '', 0));
	return response;
}

function page(title, content, csrf, status = 200) {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab admin</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"><link rel="stylesheet" href="/admin.css"></head>
    <body class="membership-page"><main class="container membership-main admin-main"><header class="admin-header"><a class="membership-brand" href="/">TheLab</a><a href="/admin">Member admin</a>${csrf ? `<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="btn btn-outline" type="submit">Sign out</button></form>` : ''}</header><h1>${e(title)}</h1>${content}</main></body></html>`, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
		},
	});
}

const date = value => value ? new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
const labelDiscount = value => ({ '': 'Standard rate', firstResponder: 'First responder' })[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

function subscriptionStatus(member) {
	const state = member.stripe_subscription_state;
	if (!state) return member.stripe_subscription_id ? 'Unknown — not yet synced' : 'No subscription';
	return `${['active', 'trialing'].includes(state) ? 'Active' : 'Inactive'} — ${state}`;
}

function subscriptionLink(member, env) {
	if (!/^sub_[A-Za-z0-9]+$/.test(member.stripe_subscription_id || '')) return '';
	const mode = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || '') ? 'test/' : '';
	return `<a href="https://dashboard.stripe.com/${mode}subscriptions/${e(member.stripe_subscription_id)}" target="_blank" rel="noopener noreferrer">View subscription in Stripe ↗</a>`;
}

async function list(request, env, csrf) {
	const params = new URL(request.url).searchParams;
	const raw = params.get('page') || '1';
	if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
	const current = Number(raw);
	const [count, members] = await env.DB.batch([
		env.DB.prepare('SELECT COUNT(*) AS total FROM members'),
		env.DB.prepare(`SELECT discord_user_id, discord_username, discord_email, created, bill_annually, discount_type, discount_status,
      name_override, billing_name, stripe_subscription_id, stripe_subscription_state, stripe_synced_at FROM members ORDER BY created DESC, discord_user_id DESC LIMIT ? OFFSET ?`).bind(PAGE_SIZE, (current - 1) * PAGE_SIZE),
	]);
	const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	if (current > pages) return redirect(`/admin?page=${pages}`);
	const rows = members.results.map(m => `<tr><td><a href="/admin/members/${e(m.discord_user_id)}">${e(memberName(m))}</a><small>${e(m.discord_user_id)}</small></td><td>${e(m.discord_email)}</td><td>${e(date(m.created))}</td><td>${m.bill_annually ? 'Yearly' : 'Monthly'}</td><td>${e(labelDiscount(m.discount_type))}<small>${e(m.discount_status)}</small></td><td><strong>${e(subscriptionStatus(m))}</strong><small>Last synced: ${e(date(m.stripe_synced_at))}</small>${subscriptionLink(m, env)}</td></tr>`).join('');
	return page('Registered members', `<p>${total} registered member${total === 1 ? '' : 's'}. Includes pending and inactive memberships.</p><div class="admin-table"><table><thead><tr><th scope="col">Member</th><th scope="col">Discord email</th><th scope="col">Registered</th><th scope="col">Saved billing</th><th scope="col">Discount</th><th scope="col">Last-synced subscription</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No members have registered yet.</td></tr>'}</tbody></table></div><nav class="admin-pagination" aria-label="Member pages">${current > 1 ? `<a class="btn btn-outline" href="/admin?page=${current - 1}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="/admin?page=${current + 1}">Next</a>` : ''}</nav>`, csrf);
}

function input(name, label, value, max, type = 'text', required = false, readonly = false) {
	return `<label for="${name}">${e(label)}</label><input id="${name}" name="${name}" type="${type}" value="${e(value ?? '')}" maxlength="${max}"${required ? ' required' : ''}${readonly ? ' readonly' : ''}>`;
}

function select(name, label, value, choices) {
	return `<label for="${name}">${e(label)}</label><select id="${name}" name="${name}">${choices.map(([key, text]) => `<option value="${e(key)}"${key === value ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>`;
}

function editor(member, fields, csrf, env, message = '', status = 200) {
	const f = fields || { ...member, billing: member.bill_annually ? 'yearly' : 'monthly' };
	const details = [
		['Registered', date(member.created)], ['Subscription status (database)', subscriptionStatus(member)],
		['Stripe last synced', date(member.stripe_synced_at)], ['Discord last synced', date(member.discord_last_synced)],
	];
	return page(`Edit ${memberName(member)}`, `<p><a href="/admin">← All members</a></p>${message ? `<p class="admin-notice" role="${status >= 400 ? 'alert' : 'status'}">${e(message)}</p>` : ''}
    <section class="card admin-section"><h2>Account details</h2><p>Subscription status reflects the stored database state. Active and trialing subscriptions qualify for membership; Stripe changes appear after synchronization.</p><dl>${details.map(([key, value]) => `<dt>${e(key)}</dt><dd>${e(value || '—')}</dd>`).join('')}${subscriptionLink(member, env) ? `<dt>Stripe Dashboard</dt><dd>${subscriptionLink(member, env)}</dd>` : ''}</dl></section>
    <form method="post" action="/admin/members/${e(member.discord_user_id)}" class="admin-form">
    <input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="metadata_version" value="${e(f.metadata_version)}">
    <fieldset class="card admin-section"><legend>Profile</legend><p>Members are named by their name override, then Stripe billing name, then Discord username. Discord sign-in refreshes username and email; billing details are refreshed from Stripe.</p>
    ${input('name_override', 'Name override', f.name_override, 160)}
    ${input('discord_user_id', 'Discord ID', f.discord_user_id, 20, 'text', true)}
    <p>Changing Discord ID transfers the membership to that account. Its email is available after it signs in.</p>
    ${input('discord_username', 'Discord username', member.discord_username, 80, 'text', false, true)}${input('discord_email', 'Discord email', member.discord_email, 254, 'email', false, true)}
    ${input('billing_name', 'Billing name (Stripe)', member.billing_name, 255, 'text', false, true)}${input('billing_email', 'Billing email (Stripe)', member.billing_email, 254, 'email', false, true)}
    ${input('stripe_customer_id', 'Stripe customer ID', f.stripe_customer_id, 255)}${input('stripe_subscription_id', 'Stripe subscription ID', f.stripe_subscription_id, 255)}
    <p>The subscription must belong to the customer. Stripe synchronization automatically selects the current membership subscription and may replace this ID.</p>
    </fieldset><fieldset class="card admin-section"><legend>Billing metadata</legend><p>These settings apply to future checkout. Existing Stripe subscriptions and invoices are unchanged. Changing pricing settings expires any open checkout link. Use Stripe to manage an existing subscription.</p>
    ${select('billing', 'Saved billing cycle', f.billing, [['monthly', 'Monthly'], ['yearly', 'Yearly']])}
    ${select('discount_type', 'Discount category', f.discount_type, discounts.map(key => [key, labelDiscount(key)]))}
    ${select('discount_status', 'Discount status', f.discount_status, [['', 'None (standard rate)'], ['requested', 'Requested'], ['approved', 'Approved'], ['denied', 'Denied']])}
    <p class="signup-help">Choose “None” for standard rate, or a request status for a discount category. The member can resume their saved selection at <a href="/payment/resume">/payment/resume</a>; choosing a different selection at signup replaces it.</p>
    </fieldset><fieldset class="card admin-section"><legend>Internal metadata</legend>
    <label for="notes">Notes</label><textarea id="notes" name="notes" maxlength="5000" rows="6">${e(f.notes)}</textarea>
    </fieldset><div class="admin-actions"><button class="btn btn-primary" type="submit">Save changes</button><a href="/admin/members/${e(member.discord_user_id)}">Reload member</a><a href="/admin">Back to members</a></div></form>`, csrf, status);
}

export async function adminRequest(request, env, context = requestContext(request)) {
	const path = new URL(request.url).pathname;
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
		let fields;
		if (request.method === 'POST') {
			if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'Invalid form origin. Reload this page and try again.');
			if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the member edit form.');
			const form = new URLSearchParams(await boundedText(request, 128 * 1024));
			if ([...form.keys()].some(key => form.getAll(key).length !== 1) || form.get('csrf') !== csrf) throw new HttpError(403, 'Invalid form token. Reload this page and try again.');
			fields = Object.fromEntries(form);
		}
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
			try { await coordinated(env, member.discord_user_id, '/admin/update', { discord_user_id: member.discord_user_id, fields }); }
      catch (error) {
        logError('admin.save_failed', error, context, env);
        return editor(member, fields, csrf, env, error instanceof HttpError ? error.message : 'Saving failed. Please try again.', error instanceof HttpError ? error.status : 500);
			}
			return redirect(`/admin/members/${fields.discord_user_id.trim()}?saved=1`);
		}
		return editor(member, null, csrf, env, new URL(request.url).searchParams.get('saved') === '1' ? 'Member metadata saved.' : '');
  } catch (error) {
    logError('admin.failed', error, context, env);
		return page('Admin access', `<p role="alert">${e(error instanceof HttpError ? error.message : 'Admin is temporarily unavailable. Please try again.')}</p><p><a href="/admin">Return to members</a> · <a href="/admin/login">Sign in again</a></p>`, csrf, error instanceof HttpError ? error.status : 500);
	}
}
