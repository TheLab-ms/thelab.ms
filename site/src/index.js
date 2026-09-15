// HTTP presentation and Worker entrypoints. State changes use membership coordination.
import {
  HttpError, boundedText, cookie, cookieHeader, discordID, errorPage, escapeHTML as e,
  hash, json, logError, opaque, origin, randomToken, redirect, requestContext,
  finishLogin, issueToken, loginDestination, memberToken, signedInMember, startLogin,
  verifyOAuthState, verifyToken, discord, discordIdentity, edgeJWKS, provider, stripe, verifyStripe,
  githubConfigured, githubIdentity, requireGithubMember, startGithub,
  discounts, fobEnabledSQL, grantsMembership, memberName, memberPath, waiverSignedSQL,
  MAX_SEARCH_LENGTH, defaultMemberFilters, memberFilters, memberListParams, memberListURL,
  eventListParams, eventListURL, eventTypes, queryEvents, recentMemberEvents,
} from './services.js';
import {
  cleanupFobClaims, coordinated, createMember, edgeCall, edgeEnabled, fobClaim,
  kickEdge, nightlyDate, registerMember, swipeWebhook,
} from './membership.js';
export { Membership, EdgeSync } from './membership.js';

// ────────────────────────────────────────────────────────────────────────
// Admin member pages
// ────────────────────────────────────────────────────────────────────────

export function page(title, content, csrf, status = 200, env = {}) {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab admin</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"></head>
    <body class="membership-page admin-page"><main class="container membership-main admin-main"><header class="admin-header"><a class="membership-brand" href="/">TheLab</a><nav aria-label="Admin navigation"><a href="/admin">Members</a><a href="/admin/events">Member history</a></nav>${csrf ? `<div class="admin-toolbar-actions"><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="btn btn-outline" type="submit">Log Out</button></form></div>` : ''}</header><h1>${e(title)}</h1>${content}</main></body></html>`, {
		status,
		headers: {
			// no-referrer can turn the Origin of a native form POST into "null".
			'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
			'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
		},
	});
}

const date = value => value ? new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';
const labelDiscount = value => ({ '': 'Standard rate', firstResponder: 'First responder' })[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

function timestamp(value, compact = false) {
	if (!value) return '—';
	return `<time datetime="${e(new Date(value * 1000).toISOString())}" title="${e(date(value))}">${e(compact ? date(value).slice(0, 10) : date(value))}</time>`;
}

function subscriptionStatus(member) {
	const state = member.stripe_subscription_state;
	if (!state) return member.stripe_subscription_id ? 'Unknown — not yet synced' : 'No subscription';
	return state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ');
}

function statusBadge(member) {
	const tone = grantsMembership(member.stripe_subscription_state) ? 'active' : member.stripe_subscription_state ? 'inactive' : 'unknown';
	return `<span class="admin-status admin-status--${tone}">${e(subscriptionStatus(member))}</span>`;
}

function subscriptionLink(member, env) {
	if (!/^sub_[A-Za-z0-9]+$/.test(member.stripe_subscription_id || '')) return '';
	const mode = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || '') ? 'test/' : '';
	return `<a href="https://dashboard.stripe.com/${mode}subscriptions/${e(member.stripe_subscription_id)}" target="_blank" rel="noopener noreferrer">View in Stripe <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>`;
}

export function memberList(members, { total, current, pages, query = '', filters = defaultMemberFilters }, env, csrf) {
	const rows = members.map(m => `<tr><th scope="row"><a class="admin-member-name" href="${e(memberPath(m))}">${e(memberName(m))}</a><small>${e(m.discord_email || m.email || 'No email')}</small><small class="admin-id">Discord ID: ${e(m.discord_user_id || 'Not linked')}</small><small>${m.waiver_signed ? 'Waiver signed' : 'No linked waiver'}</small>${m.non_billable ? '<small>Non-billable</small>' : ''}${m.legacy_billing ? '<small>Legacy billing</small>' : ''}</th><td>${statusBadge(m)}<small>${subscriptionLink(m, env)}</small></td></tr>`).join('');
	const filtered = query || Object.values(filters).some(value => value !== 'all');
	const empty = filtered ? 'No members match your search and filters.' : 'No members have registered yet.';
	return page('Registered members', `<div class="admin-actions"><a class="btn btn-primary" href="/admin/members/new">New member</a></div><form method="get" action="/admin" role="search" class="admin-form admin-search">
    <label for="member-search">Search members</label>
    <div class="admin-search-controls"><input id="member-search" type="search" name="q" value="${e(query)}" maxlength="${MAX_SEARCH_LENGTH}" placeholder="Name, email, Discord handle or ID, fob ID">${query ? `<a class="btn btn-outline" href="${e(memberListURL(1, '', filters))}">Clear search</a>` : ''}</div>
    <div class="admin-list-filters">${memberFilters.map(({ name, label, choices }) => select(name, label, filters[name], choices)).join('')}</div>
    <div class="admin-actions"><button class="btn btn-primary" type="submit">Apply filters</button><a href="/admin">Reset</a></div></form>
    <div class="admin-list-summary"><p><strong>${total} ${filtered ? 'matching' : 'registered'} member${total === 1 ? '' : 's'}</strong>${query ? ` for “${e(query)}”` : ''}</p><p class="admin-help">${filters.payment === 'all' ? 'Any payment status · ' : ''}Newest first</p></div><div class="admin-table" role="region" aria-label="Registered members" tabindex="0"><table class="admin-member-table"><thead><tr><th scope="col">Member</th><th scope="col">Subscription</th></tr></thead><tbody>${rows || `<tr><td colspan="2" class="admin-empty">${empty}${filtered ? '<p>Try changing your search or filters.</p>' : ''}</td></tr>`}</tbody></table></div><nav class="admin-pagination" aria-label="Member pages">${current > 1 ? `<a class="btn btn-outline" href="${e(memberListURL(current - 1, query, filters))}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="${e(memberListURL(current + 1, query, filters))}">Next</a>` : ''}</nav>`, csrf, 200, env);
}

function input(name, label, value, max, help = '', required = false) {
	return `<div class="admin-field"><label for="${name}">${e(label)}</label><input id="${name}" name="${name}" type="text" value="${e(value ?? '')}" maxlength="${max}"${required ? ' required' : ''}${help ? ` aria-describedby="${name}-help"` : ''}>${help ? `<p class="admin-help" id="${name}-help">${e(help)}</p>` : ''}</div>`;
}

function select(name, label, value, choices) {
	return `<div class="admin-field"><label for="${name}">${e(label)}</label><select id="${name}" name="${name}">${choices.map(([key, text]) => `<option value="${e(key)}"${key === value ? ' selected' : ''}>${e(text)}</option>`).join('')}</select></div>`;
}

function checkbox(name, label, value, help) {
	return `<div class="admin-field"><label class="admin-checkbox" for="${name}"><input id="${name}" name="${name}" type="checkbox"${value === 1 || value === 'on' ? ' checked' : ''} aria-describedby="${name}-help">${e(label)}</label><p class="admin-help" id="${name}-help">${e(help)}</p></div>`;
}

export function newMember(fields, csrf, env, message = '', status = 200) {
	const f = fields || { billing: 'monthly', discount_type: '' };
	return page('New member', `<p class="admin-back"><a href="/admin">← All members</a></p>${message ? `<p class="admin-notice admin-notice--error" role="alert">${e(message)}</p>` : ''}
    <form method="post" action="/admin/members/new" class="admin-form admin-section">
    <input type="hidden" name="csrf" value="${e(csrf)}">
    ${input('name_override', 'Member name', f.name_override, 160)}
    <div class="admin-field"><label for="email">Member email</label><input id="email" name="email" type="email" value="${e(f.email || '')}" maxlength="254" required aria-describedby="email-help"><p class="admin-help" id="email-help">Use the member’s Discord email so their account and waiver can link when they sign in.</p></div>
    ${input('discord_user_id', 'Discord ID (optional)', f.discord_user_id, 20, 'Leave blank if the member has not joined Discord yet.')}
    <div class="admin-field-grid">${select('billing', 'Billing cycle', f.billing, [['monthly', 'Monthly'], ['yearly', 'Yearly']])}${select('discount_type', 'Discount category', f.discount_type, discounts.map(key => [key, labelDiscount(key)]))}</div>
    <div class="admin-field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" maxlength="5000" rows="4">${e(f.notes || '')}</textarea></div>
    <p class="admin-help">After creating the member, open Billing info to generate a shareable checkout link.</p><div class="admin-actions"><button class="btn btn-primary" type="submit">Create member</button><a href="/admin">Cancel</a></div></form>`, csrf, status, env);
}

export function editor(member, fields, csrf, env, message = '', status = 200, events = [], waivers = '', checkoutURL = '') {
	const f = fields || { ...member, billing: member.bill_annually ? 'yearly' : 'monthly' };
	const account = [
		['Member email', member.email], ['Waiver name', member.waiver_name],
		['Discord username', member.discord_username], ['Discord email', member.discord_email],
		['GitHub account ID', member.github_user_id], ['GitHub username', member.github_username],
		['Billing name (Stripe)', member.billing_name], ['Billing email (Stripe)', member.billing_email],
	];
	const dates = [['Registered', member.created], ['Stripe last synced', member.stripe_synced_at], ['Discord last synced', member.discord_last_synced]];
	return page(`Edit ${memberName(member)}`, `<p class="admin-back"><a href="/admin">← All members</a></p>${message ? `<p class="admin-notice${status >= 400 ? ' admin-notice--error' : ''}" role="${status >= 400 ? 'alert' : 'status'}">${e(message)}</p>` : ''}
    <section class="admin-member-summary" aria-label="Subscription summary"><div class="admin-summary-line">${statusBadge(member)}${subscriptionLink(member, env)}</div></section>
    <div class="admin-editor-layout"><form method="post" action="${e(memberPath(member))}" class="admin-form admin-editor">
    <input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="metadata_version" value="${e(f.metadata_version)}">
    <section class="admin-section" aria-labelledby="member-settings"><h2 id="member-settings">Member settings</h2>
    ${input('name_override', 'Name override', f.name_override, 160, 'Leave blank to use the Stripe billing name, then Discord username.')}
    <div class="admin-field" aria-label="Saved fob status"><span class="admin-status admin-status--${member.fob_enabled ? 'active' : 'inactive'}">Fob ${member.fob_enabled ? 'enabled' : 'disabled'}</span><p class="admin-help">${member.fob_id ? `Fob ID ${e(member.fob_id)}. ` : 'No fob assigned. '}Based on saved member settings and waiver eligibility. Door changes take effect after synchronization.</p></div>
    ${input('fob_id', 'Fob ID', f.fob_id, 10, 'One unique ID from 1 through 4294967295. Leave blank to remove. By default, door access requires an active or trialing Stripe subscription and a linked signed waiver or imported Conway waiver eligibility.')}
    ${checkbox('non_billable', 'Non-billable', f.non_billable, 'Activates the assigned fob regardless of payment or waiver status. Takes precedence over legacy billing.')}
    ${checkbox('legacy_billing', 'Legacy billing', f.legacy_billing, 'Activates the assigned fob with a linked signed waiver or imported Conway waiver eligibility, regardless of Stripe status.')}
    <details class="admin-billing admin-linked-accounts"${checkoutURL || status >= 400 ? ' open' : ''}><summary>Billing info</summary><p class="admin-help">For future checkout only. Manage existing subscriptions and invoices in Stripe. Changing these preferences expires open checkout links.</p><div class="admin-field-grid">
    ${select('billing', 'Saved billing cycle', f.billing, [['monthly', 'Monthly'], ['yearly', 'Yearly']])}
    ${select('discount_type', 'Discount category', f.discount_type, discounts.map(key => [key, labelDiscount(key)]))}
    </div><p class="admin-help">Discounts apply automatically and can only be changed by admins. Choose “Standard rate” to remove a discount. Save any changes before generating a link.</p>
    <div class="admin-actions"><button class="btn btn-outline" type="submit" form="generate-checkout">Generate checkout link</button></div>
    <p class="admin-help">Share this Stripe link directly with the member, even before they link Discord. Links expire after 24 hours. A signed waiver is still required for normal door access.</p>
    ${checkoutURL ? `<div class="admin-field"><label for="checkout-url">Shareable Stripe checkout URL</label><input id="checkout-url" type="url" readonly value="${e(checkoutURL)}" aria-describedby="checkout-help"><p class="admin-help" id="checkout-help">Select and copy this URL to send it to the member. Generating again reuses the current open link.</p></div>` : ''}
    </details><div class="admin-field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" maxlength="5000" rows="4">${e(f.notes ?? '')}</textarea></div>
    </section><details class="admin-section admin-linked-accounts"${status >= 400 ? ' open' : ''}><summary>Linked accounts <span>Edit Discord and Stripe IDs</span></summary><div class="admin-linked-fields">
    ${input('discord_user_id', 'Discord ID', f.discord_user_id, 20, 'Changing this ID transfers membership to that Discord account. Its email appears after it signs in. Waiver-only members can leave it blank.', Boolean(member.discord_user_id))}
    ${input('stripe_customer_id', 'Stripe customer ID', f.stripe_customer_id, 255)}
    ${input('stripe_subscription_id', 'Stripe subscription ID', f.stripe_subscription_id, 255, 'Must belong to the customer above. Stripe sync selects the current membership subscription and may replace this ID.')}
    </div></details><div class="admin-actions"><button class="btn btn-primary" type="submit">Save changes</button><a href="${e(memberPath(member))}">Reload member</a><button class="btn btn-outline admin-delete" type="submit" form="delete-member" disabled>Delete member</button></div></form>
    <aside class="admin-section admin-account" aria-labelledby="account-details"><h2 id="account-details">Account details</h2><p class="admin-help">Read-only · Updated from Discord sign-in and Stripe sync.</p><dl class="admin-account-fields">${account.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value || '—')}</dd></div>`).join('')}</dl><dl class="admin-account-dates">${dates.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${timestamp(value)}</dd></div>`).join('')}</dl></aside></div>
    <form id="generate-checkout" method="post" action="${e(memberPath(member))}/checkout"><input type="hidden" name="csrf" value="${e(csrf)}"></form>
    <form id="delete-member" method="post" action="/admin/members/${e(member.member_id)}/delete" data-confirm="${e(`Delete ${memberName(member)}? This cannot be undone. Existing Stripe subscriptions must be canceled separately in Stripe.`)}"><input type="hidden" name="csrf" value="${e(csrf)}"></form><script src="/script.js" defer></script><noscript><p class="admin-help">Enable JavaScript to delete a member with confirmation.</p></noscript>${waivers}${recentHistory(member, events)}`, csrf, status, env);
}

// ────────────────────────────────────────────────────────────────────────
// Admin history rendering
// ────────────────────────────────────────────────────────────────────────

function eventDetails(event) {
  if (event.event_type === 'MemberRegistered') return 'Membership registered.';
  if (event.event_type === 'NotesUpdated') return 'Internal notes updated.';
  const details = JSON.parse(event.details);
  if (event.event_type === 'ConwayEvent') return `${details.event}: ${details.details}`;
  if (event.event_type === 'FobSwipe') return `Fob ${details.fob} · ${details.allowed ? 'Allowed' : 'Denied'} · Controller ${details.controller} · ${details.time}`;
  if (event.event_type === 'WaiverSigned') return `Signature #${details.waiver_id}, waiver version ${details.version}.`;
  const value = item => {
    if (item === null) return 'Not set';
    if (event.event_type === 'BillingCycleChanged') return item ? 'Yearly' : 'Monthly';
    if (['NonBillableChanged', 'LegacyBillingChanged'].includes(event.event_type)) return item ? 'Enabled' : 'Disabled';
    if (event.event_type === 'DiscountTypeModified' && item === '') return 'Standard rate';
    return item === '' ? '(blank)' : String(item);
  };
  return `${value(details.from)} → ${value(details.to)}`;
}

export function eventTable(events, showMember = true) {
  const rows = events.map(event => {
    const timestamp = new Date(event.created * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
    const member = event.member_id ? `<a href="${e(memberPath(event))}">${e(memberName(event))}</a>` : event.event_type === 'FobSwipe' ? 'Unknown or deleted member' : 'Deleted member';
    return `<tr><td>${e(timestamp)}</td><td>${e(eventTypes[event.event_type] || event.event_type)}</td>${showMember ? `<td>${member}</td>` : ''}<td>${e(eventDetails(event))}</td></tr>`;
  }).join('');
  return `<div class="admin-table" role="region" aria-label="Member history" tabindex="0"><table><thead><tr><th scope="col">Timestamp</th><th scope="col">Event</th>${showMember ? '<th scope="col">Member</th>' : ''}<th scope="col">Details</th></tr></thead><tbody>${rows || `<tr><td colspan="${showMember ? 4 : 3}">No member history found.</td></tr>`}</tbody></table></div>`;
}

export function recentHistory(member, events) {
  return `<section class="card admin-section"><h2>Recent member history</h2>${eventTable(events, false)}<p><a href="${e(memberPath(member))}/events">View full member history</a></p></section>`;
}

export function eventList(history, path, member) {
  const { events, total, current, pages, type } = history;
  return `${member ? `<p><a href="${e(memberPath(member))}">← Back to member</a></p>` : ''}
    <p>Member changes are retained indefinitely. Timestamps are UTC.</p>
    <form method="get" action="${e(path)}" class="admin-form admin-search"><label for="event-type">Event type</label>
    <div class="admin-search-controls"><select id="event-type" name="event_type"><option value="">All event types</option>${Object.entries(eventTypes).map(([key, label]) => `<option value="${key}"${key === type ? ' selected' : ''}>${e(label)}</option>`).join('')}</select><button class="btn btn-primary" type="submit">Filter</button></div></form>
    <p>${total} event${total === 1 ? '' : 's'}.</p>${eventTable(events, !member)}
    <nav class="admin-pagination" aria-label="History pages">${current > 1 ? `<a class="btn btn-outline" href="${e(eventListURL(path, current - 1, type))}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="${e(eventListURL(path, current + 1, type))}">Next</a>` : ''}</nav>`;
}

// ────────────────────────────────────────────────────────────────────────
// Admin requests and authorization
// ────────────────────────────────────────────────────────────────────────

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
  const methods = path === '/admin' || path === '/admin/' || path === '/admin/events' || match?.[2] === '/events' ? ['GET'] : path === '/admin/logout' || ['/checkout', '/delete'].includes(match?.[2]) ? ['POST'] : match || creating ? ['GET', 'POST'] : [];
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
    return page('Admin access', `<p role="alert">${e(error instanceof HttpError ? error.message : 'Admin is temporarily unavailable. Please try again.')}</p><p><a href="${e(path + url.search)}">Retry</a> · <a href="/admin">Return to members</a> · <a href="/admin/login">Sign in again</a></p>`, csrf, error instanceof HttpError ? error.status : 500, env);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Versioned liability waiver
// ────────────────────────────────────────────────────────────────────────

// TheLab's waiver from https://members.thelab.ms/waiver. Increment version
// whenever this text changes. Every signature stores its own immutable snapshot.
export const waiverContent = Object.freeze({
  version: 2,
  content: `# TheLab Liability Waiver

I agree and acknowledge as follows:

1. I WAIVE ANY AND ALL RIGHTS OF RECOVERY, CLAIM, ACTION OR CAUSE OF ACTION AGAINST THELAB.MS FOR ANY INJURY OR DAMAGE THAT MAY OCCUR, REGARDLESS OF CAUSE OR ORIGIN, INCLUDING NEGLIGENCE AND GROSS NEGLIGENCE.

2. I also understand that I am personally responsible for my safety and actions and that I will follow all safety instructions and signage while at TheLab.ms.

3. I affirm that I am at least 18 years of age and mentally competent to sign this liability waiver.

- [ ] By checking here, you are consenting to the use of your electronic signature in lieu of an original signature on paper.
- [ ] By checking this box, I agree and acknowledge to be bound by this waiver and release and further agree and acknowledge that this waiver and release shall also apply to all of my future participation in TheLab.`,
});

// ────────────────────────────────────────────────────────────────────────
// Public and member waiver signing
// ────────────────────────────────────────────────────────────────────────

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
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Liability waiver | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css">${verify ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}</head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/">TheLab</a><section class="card waiver-page">${content}</section></main></body></html>`, {
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
  const legacy = member.legacy_waiver_signed ? '<p>Conway recorded a signed waiver. The original signature record was not included in the export; imported waiver eligibility is retained.</p>' : '';
  return `<section class="card admin-section"><h2>Signed waivers</h2>${legacy}${results.length ? results.map(w => `<details><summary>Signature #${w.id} · Version ${w.version} · ${e(new Date(w.created * 1000).toISOString())}</summary><p>${e(w.name)} · ${e(w.email)}</p>${text({ ...w, ...parseWaiver(w.content) })}<ul>${JSON.parse(w.agreements).map(a => `<li>${e(a)}</li>`).join('')}</ul></details>`).join('') : legacy ? '' : '<p>No linked waiver.</p>'}</section>`;
}

// ────────────────────────────────────────────────────────────────────────
// Member fob binding
// ────────────────────────────────────────────────────────────────────────

function fobPage(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"></head><body class="membership-page"><main class="container membership-main"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="48" height="48">TheLab</a><section class="card membership-message"><h1>${e(title)}</h1>${body}</section></main></body></html>`, {
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
    return fobPage('Link your fob', `<p>Signed in as <strong>${e(member.discord_username)}</strong> (Discord ${e(member.discord_user_id)}).</p><p>Link fob <strong>${claim.fob_id}</strong> to your membership.</p>
      ${member.fob_id && member.fob_id !== claim.fob_id ? `<p>This replaces fob <strong>${member.fob_id}</strong>. Your previous fob will lose your membership’s door access after synchronization.</p>` : ''}
      <p>This code expires at ${e(new Date(claim.expires * 1000).toISOString())}. Door access follows your membership and waiver status.</p>
      <form method="post" action="/keyfob/bind?token=${e(token)}"><input type="hidden" name="csrf" value="${csrf}"><button class="btn btn-primary" type="submit">Link fob</button></form>`);
  }
  if (request.headers.get('Origin') !== origin(env)) throw new HttpError(403, 'We couldn’t process your request. Reload this page and try again.');
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'Submit the enrollment form.');
  const form = new URLSearchParams(await boundedText(request, 2048));
  if (form.getAll('csrf').length !== 1 || form.get('csrf') !== csrf) throw new HttpError(403, 'Invalid enrollment form. Reload this page and try again.');
  await coordinated(env, member.member_id, 'linkFob', { token, discord_user_id: member.discord_user_id, auth_version: member.auth_version });
  return fobPage('Fob linked', `<p role="status">Fob ${claim.fob_id} is now linked to your membership.</p><p>Door access follows your membership and waiver status. Door changes take effect after synchronization.</p><p>You can close this page.</p>`);
}

// ────────────────────────────────────────────────────────────────────────
// Printer dashboard redirect
// ────────────────────────────────────────────────────────────────────────

export function printerOrigin(env) {
  try {
    const url = new URL(env.PRINTER_EDGE_URL);
    if (url.protocol === 'https:' && url.origin === env.PRINTER_EDGE_URL) return url.origin;
  } catch { /* Report a configuration error below. */ }
  throw new HttpError(503, 'Machine status is temporarily unavailable. Please try again later.');
}

export function printerAccess(_request, env) {
  const response = redirect(`${printerOrigin(env)}/machines`);
  response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return response;
}

// ────────────────────────────────────────────────────────────────────────
// GitHub member onboarding
// ────────────────────────────────────────────────────────────────────────

const wikiURL = 'https://github.com/TheLab-ms/wiki/wiki';

async function githubOnboarding(request, env) {
  githubConfigured(env);
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  requireGithubMember(member);
  return startGithub(request, env, member);
}

async function githubCallback(request, env) {
  githubConfigured(env);
  const params = new URL(request.url).searchParams;
  const browser = cookie(request, 'thelab_github_oauth');
  const pending = await verifyToken(env, params.get('state'), 'oauth');
  const member = await signedInMember(request, env);
  if (params.getAll('state').length !== 1 || !opaque.test(browser || '') || !pending || pending.purpose !== 'github'
    || pending.sub !== await hash(browser) || !member || pending.member_id !== member.member_id
    || pending.session !== await hash(cookie(request, 'thelab_member'))) {
    throw new HttpError(400, 'Invalid or expired GitHub sign-in. Please start again at /github.');
  }
  requireGithubMember(member);
  const code = params.get('code');
  if (params.has('error') || params.getAll('code').length !== 1 || !code || code.length > 2048 || /[^\x21-\x7e]/.test(code)) {
    throw new HttpError(400, 'GitHub sign-in was not authorized. Please start again at /github.');
  }
  const user = await githubIdentity(env, code, browser);
  const result = await coordinated(env, member.member_id, 'linkGithub', {
    user, discord_user_id: member.discord_user_id, auth_version: member.auth_version,
  });
  const response = result.state === 'active' ? redirect(wikiURL) : fobPage('Accept your GitHub invitation',
    `<p>Your GitHub account <strong>${e(user.username)}</strong> is linked. Accept the organization invitation to join the members team and access the wiki.</p>
    <p><a class="btn btn-primary" href="https://github.com/orgs/${e(env.GITHUB_ORG)}/invitation">Accept invitation</a></p><p>Then <a href="${wikiURL}">open the wiki</a>.</p>`);
  response.headers.append('Set-Cookie', cookieHeader(env, 'thelab_github_oauth', '', 0));
  return response;
}

// ────────────────────────────────────────────────────────────────────────
// Public routes, payments, and Worker entrypoints
// ────────────────────────────────────────────────────────────────────────

const events = new Set([
  'customer.updated',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'invoice.paid', 'invoice.payment_failed',
]);

function configured(env, admin = false) {
  origin(env);
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET || (!admin && !env.STRIPE_SECRET_KEY)) throw new HttpError(503, 'Sign-in is temporarily unavailable. Please contact leadership.');
}

async function signup(request, env, admin = false) {
  configured(env, admin);
  if (admin) adminConfigured(env);
  return startLogin(request, env, admin ? 'admin' : 'signup');
}

async function resume(request, env) {
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  const result = await coordinated(env, member.member_id, 'checkout', {
    user: { id: member.discord_user_id, username: member.discord_username, email: member.discord_email },
  });
  return redirect(result.url);
}

async function callback(request, env) {
  configured(env, true);
  const url = new URL(request.url);
  const state = url.searchParams.get('state'), browser = cookie(request, 'thelab_oauth');
  if (url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const pending = await verifyOAuthState(env, state, browser);
  if (!pending) throw new HttpError(400, 'Invalid or expired Discord sign-in. Please start again.');
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || !code || code.length > 2048 || /[^\x21-\x7e]/.test(code) || url.searchParams.getAll('code').length !== 1) throw new HttpError(400, 'Discord sign-in was not authorized. Please start again.');
  const user = await discordIdentity(env, code);
  let guildMember;
  try {
    guildMember = await discord(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${user.id}`);
  } catch (error) {
    if (error.providerStatus === 404) throw new HttpError(403, 'Please join TheLab’s Discord server using the link below, then return to signup.');
    throw error;
  }
  if (pending.purpose === 'admin') return finishAdminLogin(env, user, guildMember, pending.return_to);
  if (pending.purpose === 'member') {
    let member = await env.DB.prepare('SELECT * FROM members WHERE discord_user_id = ?').bind(user.id).first();
    if (!member) {
      const pendingMember = await env.DB.prepare('SELECT member_id FROM members WHERE email = ? AND discord_user_id IS NULL').bind(user.email.trim().toLowerCase()).first();
      if (!pendingMember) throw new HttpError(404, 'No membership found for this Discord account. Please choose a membership to sign up.');
      member = await registerMember(env, user);
    }
    member = await coordinated(env, member.member_id, 'refreshIdentity', { user });
    return finishLogin(env, `${origin(env)}${loginDestination(pending.return_to, 'member')}`, 'member', await memberToken(env, member));
  }
  configured(env);
  const registered = await registerMember(env, user);
  const result = await coordinated(env, registered.member_id, 'checkout', { user });
  return finishLogin(env, result.url, 'member', await memberToken(env, registered));
}

async function success(request, env) {
  const url = new URL(request.url);
  const sessionID = url.searchParams.get('session_id');
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionID || '') || url.searchParams.getAll('session_id').length !== 1) throw new HttpError(400, 'Invalid checkout session.');
  const member = await signedInMember(request, env);
  if (!member) return startLogin(request, env, 'member');
  const session = await stripe(env, `/checkout/sessions/${encodeURIComponent(sessionID)}`);
  if (session.mode !== 'subscription' || session.customer !== member.stripe_customer_id || session.client_reference_id !== member.discord_user_id || session.metadata?.thelab_discord_id !== member.discord_user_id) throw new HttpError(403, 'This checkout does not belong to your membership.');
  if (session.status !== 'complete' || !['paid', 'no_payment_required'].includes(session.payment_status)) throw new HttpError(409, 'Your payment is not complete yet. Please finish Stripe Checkout or contact leadership.');
  const subscriptionID = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
  if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionID || '')) throw new HttpError(409, 'Stripe is still setting up your membership. Please try again shortly.');
  const subscription = await stripe(env, `/subscriptions/${subscriptionID}`);
  if (subscription.customer !== member.stripe_customer_id || subscription.metadata?.thelab_discord_id !== member.discord_user_id) throw new HttpError(403, 'This subscription does not belong to your membership.');
  if (!grantsMembership(subscription.status)) throw new HttpError(409, 'Your membership payment is still being processed. Please try again shortly.');
  await env.MEMBERSHIP_QUEUE.send({ customer_id: member.stripe_customer_id });
  return redirect(`${origin(env)}/welcome`);
}

async function webhook(request, env) {
  const text = await boundedText(request);
  await verifyStripe(request, env, text);
  let event;
  try { event = JSON.parse(text); } catch { throw new HttpError(400, 'Invalid Stripe event.'); }
  if (!event || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || typeof event.type !== 'string' || !event.data?.object) throw new HttpError(400, 'Invalid Stripe event.');
  if (!events.has(event.type)) return new Response(null, { status: 204 });
  const object = event.data.object;
  const customer = event.type === 'customer.updated' ? object.id : typeof object.customer === 'string' ? object.customer : object.customer?.id;
  if (!/^cus_[A-Za-z0-9]+$/.test(customer || '')) throw new HttpError(400, 'Stripe event has no customer.');
  // Acknowledge only after enqueueing so Stripe retries failed sends.
  await env.MEMBERSHIP_QUEUE.send({ customer_id: customer });
  return new Response(null, { status: 204 });
}

export async function processMessage(body, env) {
  // Operator messages are published through the authenticated Cloudflare API.
  if (body?.type !== undefined) {
    if (body.type !== 'edge.sync' || body.mode !== 'full' || Object.keys(body).some(key => !['type', 'mode'].includes(key))) {
      throw new HttpError(400, 'Invalid queue message.');
    }
    await edgeCall(env, 'full');
    return;
  }
  if (body?.member_id && /^[a-f0-9]{32}$/.test(body.member_id) && !body.customer_id) {
    await coordinated(env, body.member_id, 'sync');
    return;
  }
  if (!body || !/^cus_[A-Za-z0-9]+$/.test(body.customer_id || '')) throw new HttpError(400, 'Invalid queue message.');
  const member = await env.DB.prepare('SELECT member_id FROM members WHERE stripe_customer_id = ?').bind(body.customer_id).first();
  // Other Stripe customers (e.g. donations or Conway) are outside this app.
  if (!member) return;
  await coordinated(env, member.member_id, 'sync', { customer_id: body.customer_id });
}

const routes = new Map([
  ['/.well-known/edge-jwks.json', ['GET', edgeJWKS]],
  ['/signup', ['GET', signup]],
  ['/waiver', ['GET, POST', waiverRequest]],
  ['/login/discord/callback', ['GET', callback]],
  ['/github', ['GET', githubOnboarding]],
  ['/login/github/callback', ['GET', githubCallback]],
  ['/payment/success', ['GET', success]],
  ['/payment/resume', ['GET', resume]],
  ['/machines', ['GET', printerAccess]],
  ['/kiosk', ['GET', () => redirect('https://edge.thelab.ms/kiosk')]],
  ['/keyfob/bind', ['GET, POST', bindFob]],
  ['/webhooks/stripe', ['POST', webhook]],
  ['/webhooks/edge/swipes', ['POST', swipeWebhook]],
  ['/admin/login', ['GET', (request, env) => signup(request, env, true)]],
]);

export default {
  async scheduled(event, env) {
    await cleanupFobClaims(env);
    const date = nightlyDate(event.scheduledTime);
    if (date && edgeEnabled(env)) await edgeCall(env, 'nightly', date);
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const context = requestContext(request);
    const route = routes.get(path);
    const isAdmin = path === '/admin' || path.startsWith('/admin/');
    try {
      if (!route && !isAdmin) {
        const response = await env.ASSETS.fetch(request);
        if (response.status >= 400) logError('assets.failed', new HttpError(response.status, 'Asset request failed.'), context, env);
        return response;
      }
      if (route && !route[0].split(', ').includes(request.method)) {
        logError('request.rejected', new HttpError(405, 'Method not allowed.'), context, env);
        return new Response('Method not allowed', { status: 405, headers: { Allow: route[0], 'Cache-Control': 'no-store' } });
      }
      if (url.origin !== origin(env)) throw new HttpError(400, 'Please use the configured membership site address.');
      return route ? await route[1](request, env) : await adminRequest(request, env, context);
    } catch (error) {
      logError('request.failed', error, context, env);
      if (path === '/webhooks/stripe') return json({ error: 'Webhook could not be accepted.' }, error instanceof HttpError ? error.status : 500);
      const response = errorPage(error);
      if (path === '/github' || path === '/login/github/callback') {
        const retry = fobPage('GitHub onboarding', `<p role="alert">${e(error instanceof HttpError ? error.message : 'GitHub onboarding failed. Please try again.')}</p><p><a href="/github">Try again</a> · <a href="/signup">Manage billing</a></p>`);
        retry.headers.append('Set-Cookie', `thelab_github_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.url.startsWith('https:') ? '; Secure' : ''}`);
        return new Response(retry.body, { status: error instanceof HttpError ? error.status : 500, headers: retry.headers });
      }
      if (path === '/login/discord/callback') {
        // Clearing an OAuth cookie must still work when SITE_URL itself is invalid.
        response.headers.append('Set-Cookie', `thelab_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${request.url.startsWith('https:') ? '; Secure' : ''}`);
      }
      return response;
    }
  },
  async queue(batch, env) {
    // Reconcile current Stripe state once per customer in this batch. Operator
    // and invalid messages stay separate so they retain their own validation.
    const groups = Map.groupBy(batch.messages, message => message.body?.type === undefined
      && /^cus_[A-Za-z0-9]+$/.test(message.body?.customer_id || '') ? message.body.customer_id : message);
    for (const messages of groups.values()) {
      try {
        await processMessage(messages[0].body, env);
        for (const message of messages) message.ack();
      } catch (error) {
        for (const message of messages) {
          const delaySeconds = Math.min(43200, Math.max(error.retryAfter || 0, 30 * 2 ** Math.min(message.attempts - 1, 10)));
          logError('queue.failed', error, { message_id: message.id, attempt: message.attempts, retry_delay_seconds: delaySeconds }, env);
          message.retry({ delaySeconds });
        }
      }
    }
  },
};
