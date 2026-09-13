import { escapeHTML as e } from './http.js';
import { discounts, grantsMembership } from './membership-policy.js';
import { memberName } from './member-metadata.js';
import { MAX_SEARCH_LENGTH, memberListURL } from './admin-search.js';

export function page(title, content, csrf, status = 200) {
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
	return `${grantsMembership(state) ? 'Active' : 'Inactive'} — ${state}`;
}

function subscriptionLink(member, env) {
	if (!/^sub_[A-Za-z0-9]+$/.test(member.stripe_subscription_id || '')) return '';
	const mode = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || '') ? 'test/' : '';
	return `<a href="https://dashboard.stripe.com/${mode}subscriptions/${e(member.stripe_subscription_id)}" target="_blank" rel="noopener noreferrer">View subscription in Stripe ↗</a>`;
}

export function memberList(members, { total, current, pages, query = '' }, env, csrf) {
	const rows = members.map(m => `<tr><td><a href="/admin/members/${e(m.discord_user_id)}">${e(memberName(m))}</a><small>${e(m.discord_user_id)}</small></td><td>${e(m.discord_email)}</td><td>${e(date(m.created))}</td><td>${m.bill_annually ? 'Yearly' : 'Monthly'}</td><td>${e(labelDiscount(m.discount_type))}</td><td><strong>${e(subscriptionStatus(m))}</strong><small>Last synced: ${e(date(m.stripe_synced_at))}</small>${subscriptionLink(m, env)}</td></tr>`).join('');
	const empty = query ? 'No members match your search.' : 'No members have registered yet.';
	return page('Registered members', `<form method="get" action="/admin" role="search" class="admin-form admin-search">
    <label for="member-search">Search members</label><p id="member-search-help">Search by Discord ID, handle or email, Stripe billing name or email, or name override. Partial matches are supported.</p>
    <div class="admin-search-controls"><input id="member-search" type="search" name="q" value="${e(query)}" maxlength="${MAX_SEARCH_LENGTH}" aria-describedby="member-search-help"><button class="btn btn-primary" type="submit">Search</button>${query ? '<a class="btn btn-outline" href="/admin">Clear</a>' : ''}</div></form>
    <p>${total} ${query ? 'matching' : 'registered'} member${total === 1 ? '' : 's'}${query ? ` for “${e(query)}”` : ''}. Includes pending and inactive memberships.</p><div class="admin-table"><table><thead><tr><th scope="col">Member</th><th scope="col">Discord email</th><th scope="col">Registered</th><th scope="col">Saved billing</th><th scope="col">Discount</th><th scope="col">Last-synced subscription</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${empty}</td></tr>`}</tbody></table></div><nav class="admin-pagination" aria-label="Member pages">${current > 1 ? `<a class="btn btn-outline" href="${e(memberListURL(current - 1, query))}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="${e(memberListURL(current + 1, query))}">Next</a>` : ''}</nav>`, csrf);
}

function input(name, label, value, max, type = 'text', required = false, readonly = false) {
	return `<label for="${name}">${e(label)}</label><input id="${name}" name="${name}" type="${type}" value="${e(value ?? '')}" maxlength="${max}"${required ? ' required' : ''}${readonly ? ' readonly' : ''}>`;
}

function select(name, label, value, choices) {
	return `<label for="${name}">${e(label)}</label><select id="${name}" name="${name}">${choices.map(([key, text]) => `<option value="${e(key)}"${key === value ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>`;
}

export function editor(member, fields, csrf, env, message = '', status = 200) {
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
    <p class="signup-help">Choose “Standard rate” or assign a discount category. Stripe Checkout automatically applies the assigned discount; members cannot change it. The member can continue at <a href="/payment/resume">/payment/resume</a>.</p>
    </fieldset><fieldset class="card admin-section"><legend>Internal metadata</legend>
    <label for="notes">Notes</label><textarea id="notes" name="notes" maxlength="5000" rows="6">${e(f.notes)}</textarea>
    </fieldset><div class="admin-actions"><button class="btn btn-primary" type="submit">Save changes</button><a href="/admin/members/${e(member.discord_user_id)}">Reload member</a><a href="/admin">Back to members</a></div></form>`, csrf, status);
}
