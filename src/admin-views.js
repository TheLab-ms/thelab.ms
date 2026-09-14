import { escapeHTML as e } from './http.js';
import { discounts, grantsMembership } from './membership-policy.js';
import { memberName, memberPath } from './member-metadata.js';
import { MAX_SEARCH_LENGTH, memberListURL } from './admin-search.js';
import { recentHistory } from './event-views.js';

export function page(title, content, csrf, status = 200) {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)} | TheLab admin</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"><link rel="stylesheet" href="/admin.css"></head>
    <body class="membership-page admin-page"><main class="container membership-main admin-main"><header class="admin-header"><a class="membership-brand" href="/">TheLab</a><nav aria-label="Admin navigation"><a href="/admin">Members</a><a href="/admin/events">Member history</a></nav>${csrf ? `<form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="btn btn-outline" type="submit">Sign out</button></form>` : ''}</header><h1>${e(title)}</h1>${content}</main></body></html>`, {
		status,
		headers: {
			// no-referrer can turn the Origin of a native form POST into "null".
			'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin',
			'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
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
	return `${grantsMembership(state) ? 'Active' : 'Inactive'} — ${state}`;
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

export function memberList(members, { total, current, pages, query = '' }, env, csrf) {
	const rows = members.map(m => `<tr><th scope="row"><a class="admin-member-name" href="${e(memberPath(m))}">${e(memberName(m))}</a><small>${e(m.discord_email || m.email || 'No email')}</small><small class="admin-id">Discord ID: ${e(m.discord_user_id || 'Not linked')}</small><small>${m.waiver_signed ? 'Waiver signed' : 'No linked waiver'}</small>${m.non_billable ? '<small>Non-billable</small>' : ''}${m.legacy_billing ? '<small>Legacy billing</small>' : ''}</th><td>${statusBadge(m)}<small>Synced: ${timestamp(m.stripe_synced_at, true)}</small><small>${subscriptionLink(m, env)}</small></td><td>${m.bill_annually ? 'Yearly' : 'Monthly'}<small>${e(labelDiscount(m.discount_type))}</small></td><td>${timestamp(m.created, true)}</td></tr>`).join('');
	const empty = query ? 'No members match your search.' : 'No members have registered yet.';
	return page('Registered members', `${env.EDGE_URL ? `<section class="admin-section"><h2>Door access</h2><p><a href="/admin/events?event_type=FobSwipe">View fresh fob swipes</a></p><form method="post" action="/admin/edge/resync"><input type="hidden" name="csrf" value="${e(csrf)}"><button class="btn btn-outline" type="submit">Full resync</button></form><p class="admin-help">Replaces the authorized fob set and backs up swipe history.</p></section>` : ''}<form method="get" action="/admin" role="search" class="admin-form admin-search">
    <label for="member-search">Search members</label>
    <div class="admin-search-controls"><input id="member-search" type="search" name="q" value="${e(query)}" maxlength="${MAX_SEARCH_LENGTH}" placeholder="Name, email, Discord handle or ID" aria-describedby="member-search-help"><button class="btn btn-primary" type="submit">Search</button>${query ? '<a class="btn btn-outline" href="/admin">Clear</a>' : ''}</div><p class="admin-help" id="member-search-help">Matches any part of a name, Discord handle or ID, or Discord / Stripe email.</p></form>
    <div class="admin-list-summary"><p><strong>${total} ${query ? 'matching' : 'registered'} member${total === 1 ? '' : 's'}</strong>${query ? ` for “${e(query)}”` : ''}</p><p class="admin-help">Includes pending and inactive memberships · Newest first</p></div><div class="admin-table" role="region" aria-label="Registered members" tabindex="0"><table class="admin-member-table"><thead><tr><th scope="col">Member</th><th scope="col">Subscription <small>Last synced state</small></th><th scope="col">Saved billing</th><th scope="col">Registered <small>UTC</small></th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="admin-empty">${empty}${query ? '<p>Try a different name, email or Discord ID.</p>' : ''}</td></tr>`}</tbody></table></div><nav class="admin-pagination" aria-label="Member pages">${current > 1 ? `<a class="btn btn-outline" href="${e(memberListURL(current - 1, query))}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="${e(memberListURL(current + 1, query))}">Next</a>` : ''}</nav>`, csrf);
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

export function editor(member, fields, csrf, env, message = '', status = 200, events = [], waivers = '') {
	const f = fields || { ...member, billing: member.bill_annually ? 'yearly' : 'monthly' };
	const account = [
		['Member email', member.email], ['Waiver name', member.waiver_name],
		['Discord username', member.discord_username], ['Discord email', member.discord_email],
		['Billing name (Stripe)', member.billing_name], ['Billing email (Stripe)', member.billing_email],
	];
	const dates = [['Registered', member.created], ['Stripe last synced', member.stripe_synced_at], ['Discord last synced', member.discord_last_synced]];
	return page(`Edit ${memberName(member)}`, `<p class="admin-back"><a href="/admin">← All members</a></p>${message ? `<p class="admin-notice${status >= 400 ? ' admin-notice--error' : ''}" role="${status >= 400 ? 'alert' : 'status'}">${e(message)}</p>` : ''}
    <section class="admin-member-summary" aria-label="Subscription summary"><div class="admin-summary-line">${statusBadge(member)}${subscriptionLink(member, env)}</div><p class="admin-help">Stored subscription state. Active and trialing qualify for membership; Stripe changes appear after sync.</p></section>
    <div class="admin-editor-layout"><form method="post" action="${e(memberPath(member))}" class="admin-form admin-editor">
    <input type="hidden" name="csrf" value="${e(csrf)}"><input type="hidden" name="metadata_version" value="${e(f.metadata_version)}">
    <section class="admin-section" aria-labelledby="member-settings"><h2 id="member-settings">Member settings</h2>
    ${input('name_override', 'Name override', f.name_override, 160, 'Leave blank to use the Stripe billing name, then Discord username.')}
    <div class="admin-field" aria-label="Saved fob status"><span class="admin-status admin-status--${member.fob_enabled ? 'active' : 'inactive'}">Fob ${member.fob_enabled ? 'enabled' : 'disabled'}</span><p class="admin-help">${member.fob_id ? `Fob ID ${e(member.fob_id)}. ` : 'No fob assigned. '}Based on saved member settings and waiver eligibility. Door changes take effect after synchronization.</p></div>
    ${input('fob_id', 'Fob ID', f.fob_id, 10, 'One unique ID from 1 through 4294967295. Leave blank to remove. By default, door access requires an active Stripe subscription and a linked signed waiver or imported Conway waiver eligibility; trialing does not qualify.')}
    ${checkbox('non_billable', 'Non-billable', f.non_billable, 'Activates the assigned fob regardless of payment or waiver status. Takes precedence over legacy billing.')}
    ${checkbox('legacy_billing', 'Legacy billing', f.legacy_billing, 'Activates the assigned fob with a linked signed waiver or imported Conway waiver eligibility, regardless of Stripe status.')}
    <fieldset class="admin-billing"><legend>Billing preferences</legend><p class="admin-help">For future checkout only. Manage existing subscriptions and invoices in Stripe. Changing these preferences expires open checkout links.</p><div class="admin-field-grid">
    ${select('billing', 'Saved billing cycle', f.billing, [['monthly', 'Monthly'], ['yearly', 'Yearly']])}
    ${select('discount_type', 'Discount category', f.discount_type, discounts.map(key => [key, labelDiscount(key)]))}
    </div><p class="admin-help">Discounts apply automatically and can only be changed by admins. Choose “Standard rate” to remove a discount. Send the member to <a href="/payment/resume">/payment/resume</a> to continue checkout.</p>
    </fieldset><div class="admin-field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" maxlength="5000" rows="4">${e(f.notes ?? '')}</textarea></div>
    </section><details class="admin-section admin-linked-accounts"${status >= 400 ? ' open' : ''}><summary>Linked accounts <span>Edit Discord and Stripe IDs</span></summary><div class="admin-linked-fields">
    ${input('discord_user_id', 'Discord ID', f.discord_user_id, 20, 'Changing this ID transfers membership to that Discord account. Its email appears after it signs in. Waiver-only members can leave it blank.', Boolean(member.discord_user_id))}
    ${input('stripe_customer_id', 'Stripe customer ID', f.stripe_customer_id, 255)}
    ${input('stripe_subscription_id', 'Stripe subscription ID', f.stripe_subscription_id, 255, 'Must belong to the customer above. Stripe sync selects the current membership subscription and may replace this ID.')}
    </div></details><div class="admin-actions"><button class="btn btn-primary" type="submit">Save changes</button><a href="${e(memberPath(member))}">Reload member</a></div></form>
    <aside class="admin-section admin-account" aria-labelledby="account-details"><h2 id="account-details">Account details</h2><p class="admin-help">Read-only · Updated from Discord sign-in and Stripe sync.</p><dl class="admin-account-fields">${account.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value || '—')}</dd></div>`).join('')}</dl><dl class="admin-account-dates">${dates.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${timestamp(value)}</dd></div>`).join('')}</dl></aside></div>${waivers}${recentHistory(member, events)}`, csrf, status);
}
