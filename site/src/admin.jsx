// Admin pages for members and their history.
import { h, Fragment } from './html.js';
import { page } from './page.jsx';
import {
  HttpError, discordID, fobEnabledSQL, grantsMembership, logError, loginRedirect, memberName,
  memberPath, readForm, readSession, redirect, stripe, guildUsername, validEmail,
} from './lib.js';
import { checkoutLink, setDiscordRole, syncDiscordRole, syncMember } from './billing.js';
import { pushFobs } from './edge.jsx';

const PAGE_SIZE = 25;
const discounts = ['', 'military', 'retired', 'firstResponder', 'student', 'family'];
const labelDiscount = value => ({ '': 'Standard rate', firstResponder: 'First responder' })[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
const pageNumber = params => Math.max(1, Math.min(1e7, parseInt(params.get('page'), 10) || 1));

// ────────────────────────────────────────────────────────────────────────
// Shared rendering
// ────────────────────────────────────────────────────────────────────────

const date = value => value ? new Date(value * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC') : '—';

function statusBadge(member) {
  const state = member.stripe_subscription_state;
  const tone = grantsMembership(state) ? 'active' : state ? 'inactive' : 'unknown';
  const text = state ? state.charAt(0).toUpperCase() + state.slice(1).replaceAll('_', ' ') : member.stripe_subscription_id ? 'Unknown — not yet synced' : 'No subscription';
  return <span class={`admin-status admin-status--${tone}`}>{text}</span>;
}

function subscriptionLink(member, env) {
  if (!/^sub_[A-Za-z0-9]+$/.test(member.stripe_subscription_id || '')) return '';
  const mode = /^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY || '') ? 'test/' : '';
  return <a href={`https://dashboard.stripe.com/${mode}subscriptions/${member.stripe_subscription_id}`} target="_blank" rel="noopener noreferrer">View in Stripe <span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>;
}

function input(name, label, value, max, help = '', type = 'text') {
  return <div class="admin-field">
    <label for={name}>{label}</label>
    <input id={name} name={name} type={type} value={value ?? ''} maxlength={max} aria-describedby={help ? `${name}-help` : undefined} />
    {help && <p class="admin-help" id={`${name}-help`}>{help}</p>}
  </div>;
}

const options = (choices, value) => choices.map(([key, text]) => <option value={key} selected={key === value}>{text}</option>);

function select(name, label, value, choices) {
  return <div class="admin-field">
    <label for={name}>{label}</label>
    <select id={name} name={name}>{options(choices, value)}</select>
  </div>;
}

function checkbox(name, label, value) {
  return <div class="admin-field">
    <label class="admin-checkbox" for={name}><input id={name} name={name} type="checkbox" checked={value === 1 || value === 'on'} />{label}</label>
  </div>;
}

const notice = (message, error) => message ? <p class={`admin-notice${error ? ' admin-notice--error' : ''}`} role={error ? 'alert' : 'status'}>{message}</p> : null;
const billingSelects = f => <div class="admin-field-grid">
  {select('billing', 'Billing cycle', f.billing, [['monthly', 'Monthly'], ['yearly', 'Yearly']])}
  {select('discount_type', 'Discount category', f.discount_type, discounts.map(key => [key, labelDiscount(key)]))}
</div>;

function pagination(label, current, pages, url) {
  return <nav class="admin-pagination" aria-label={label}>
    {current > 1 && <a class="btn btn-outline" href={url(current - 1)}>Previous</a>}
    <span>Page {current} of {pages}</span>
    {current < pages && <a class="btn btn-outline" href={url(current + 1)}>Next</a>}
  </nav>;
}

// ────────────────────────────────────────────────────────────────────────
// Member list
// ────────────────────────────────────────────────────────────────────────

const filters = [
  { name: 'waiver', label: 'Waiver status', defaultValue: 'signed', choices: [['all', 'Any waiver'], ['signed', 'Waiver signed'], ['unsigned', 'No waiver']] },
  { name: 'discord', label: 'Discord status', defaultValue: 'linked', choices: [['all', 'Any Discord'], ['linked', 'Discord linked'], ['unlinked', 'No Discord']] },
  { name: 'payment', label: 'Payment status', defaultValue: 'all', choices: [['all', 'Any payment'], ['stripe_active', 'Stripe active'], ['legacy_billing', 'Legacy billing'], ['non_billable', 'Non-billable'], ['inactive', 'Inactive']] },
];

// Filter selects have visually hidden labels and apply on change (see static/admin.js).
const filterSelect = ({ name, label, choices }, value, disabled = false) =>
  <>
    <label class="sr-only" for={name}>{label}</label>
    <select id={name} name={name} disabled={disabled} data-autosubmit>{options(choices, value)}</select>
  </>;

function listURL(current, query, values) {
  const params = new URLSearchParams({ page: String(current) });
  if (query) params.set('q', query);
  for (const { name, defaultValue } of filters) if (values[name] !== defaultValue) params.set(name, values[name]);
  return `/admin?${params}`;
}

// Searches cover all members; filters apply only when not searching.
async function memberList(url, env) {
  const params = url.searchParams;
  const query = (params.get('q') || '').trim().slice(0, 254);
  const values = Object.fromEntries(filters.map(({ name, defaultValue, choices }) => [name, choices.some(([key]) => key === params.get(name)) ? params.get(name) : defaultValue]));
  const columns = ['discord_user_id', 'discord_username', 'discord_email', 'billing_name', 'billing_email', 'name_override', 'email', 'waiver_name', 'fob_id'];
  const conditions = [], bindings = [];
  if (query) {
    conditions.push(`(${columns.map(column => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    bindings.push(...columns.map(() => `%${query.replace(/[\\%_]/g, '\\$&')}%`));
  } else {
    if (values.waiver !== 'all') conditions.push(`waiver_signed = ${values.waiver === 'signed' ? 1 : 0}`);
    if (values.discord !== 'all') conditions.push(`discord_user_id IS ${values.discord === 'linked' ? 'NOT ' : ''}NULL`);
    if (values.payment !== 'all') {
      conditions.push(`(CASE WHEN non_billable = 1 THEN 'non_billable' WHEN legacy_billing = 1 THEN 'legacy_billing'
        WHEN stripe_subscription_state IN ('active', 'trialing') THEN 'stripe_active' ELSE 'inactive' END) = ?`);
      bindings.push(values.payment);
    }
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const current = pageNumber(params);
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM members${where}`).bind(...bindings),
    env.DB.prepare(`SELECT * FROM members${where}
      ORDER BY created DESC, discord_user_id DESC, member_id DESC LIMIT ? OFFSET ?`).bind(...bindings, PAGE_SIZE, (current - 1) * PAGE_SIZE),
  ]);
  const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (current > pages) return redirect(listURL(pages, query, values));
  const filtered = query || filters.some(({ name }) => values[name] !== 'all');
  const changed = query || filters.some(({ name, defaultValue }) => values[name] !== defaultValue);
  const tableRows = rows.results.map(m => <tr>
    <th scope="row">
      <a class="admin-member-name" href={memberPath(m)}>{memberName(m)}</a>
      <small>{m.discord_email || m.email || 'No email'}</small>
      {m.non_billable ? <small>Non-billable</small> : null}
      {m.legacy_billing ? <small>Legacy billing</small> : null}
    </th>
    <td>{statusBadge(m)}<small>{subscriptionLink(m, env)}</small></td>
  </tr>);
  return page('Registered members', <>
    <form method="get" action="/admin" role="search" class="admin-form admin-search-panel">
      <div class="admin-search-row">
        <label class="sr-only" for="member-search">Search members</label>
        <input id="member-search" type="search" name="q" value={query} maxlength="254" placeholder="Search name, email, Discord, or fob ID" data-search />
        <button class="btn btn-primary" type="submit">Search</button>
        <a class="btn btn-accent-outline" href="/admin/members/new">New member</a>
      </div>
      <div class="admin-filter-row">
        <span class="admin-filter-label" aria-hidden="true">Filter</span>
        {filters.map(filter => filterSelect(filter, values[filter.name], !!query))}
        {changed && <a href="/admin">Clear</a>}
      </div>
    </form>
    <div class="admin-list-summary">
      <p><strong>{total} {filtered ? 'matching' : 'registered'} member{total === 1 ? '' : 's'}</strong>{query ? ` for “${query}”` : ''}</p>
      <p class="admin-help">{query ? 'Searching all members; filters are ignored' : 'Newest first'}</p>
    </div>
    <div class="admin-table" role="region" aria-label="Registered members" tabindex="0">
      <table class="admin-member-table">
        <thead><tr><th scope="col">Member</th><th scope="col">Subscription</th></tr></thead>
        <tbody>{tableRows.length ? tableRows : <tr><td colspan="2" class="admin-empty">{filtered ? 'No members match your search and filters.' : 'No members have registered yet.'}</td></tr>}</tbody>
      </table>
    </div>
    {pagination('Member pages', current, pages, n => listURL(n, query, values))}
  </>, { admin: true });
}

// ────────────────────────────────────────────────────────────────────────
// Member history
// ────────────────────────────────────────────────────────────────────────

const eventTypes = {
  ConwayEvent: 'Conway event',
  FobChanged: 'Fob assignment changed',
  NonBillableChanged: 'Non-billable changed',
  LegacyBillingChanged: 'Legacy billing changed',
  FobSwipe: 'Fob swipe',
  MemberRegistered: 'Member registered',
  WaiverSigned: 'Waiver signed',
  DiscordAccountChanged: 'Discord account changed',
  DiscordUsernameChanged: 'Discord username changed',
  DiscordEmailChanged: 'Discord email changed',
  BillingNameChanged: 'Billing name changed',
  BillingEmailChanged: 'Billing email changed',
  NameOverrideChanged: 'Name override changed',
  NotesUpdated: 'Notes updated',
  BillingCycleChanged: 'Billing cycle changed',
  DiscountTypeModified: 'Discount changed',
  StripeCustomerChanged: 'Stripe customer changed',
  StripeSubscriptionChanged: 'Stripe subscription changed',
  SubscriptionStatusChanged: 'Subscription status changed',
};

function eventDetails(event) {
  if (event.event_type === 'MemberRegistered') return 'Membership registered.';
  if (event.event_type === 'NotesUpdated') return 'Internal notes updated.';
  const details = JSON.parse(event.details);
  if (event.event_type === 'ConwayEvent') return `${details.event}: ${details.details}`;
  if (event.event_type === 'FobSwipe') return `Fob ${details.fob} · ${details.allowed ? 'Allowed' : 'Denied'} · Controller ${details.controller} · ${details.time}`;
  if (event.event_type === 'WaiverSigned') return `Signature #${details.waiver_id}.`;
  const value = item => {
    if (item === null) return 'Not set';
    if (event.event_type === 'BillingCycleChanged') return item ? 'Yearly' : 'Monthly';
    if (['NonBillableChanged', 'LegacyBillingChanged'].includes(event.event_type)) return item ? 'Enabled' : 'Disabled';
    if (event.event_type === 'DiscountTypeModified' && item === '') return 'Standard rate';
    return item === '' ? '(blank)' : String(item);
  };
  return `${value(details.from)} → ${value(details.to)}`;
}

function eventTable(events, showMember = true) {
  const rows = events.map(event => {
    const member = event.member_id ? <a href={memberPath(event)}>{memberName(event)}</a> : 'Unknown or deleted member';
    return <tr>
      <td>{date(event.created)}</td><td>{eventTypes[event.event_type] || event.event_type}</td>
      {showMember && <td>{member}</td>}<td>{eventDetails(event)}</td>
    </tr>;
  });
  return <div class="admin-table" role="region" aria-label="Member history" tabindex="0">
    <table>
      <thead><tr><th scope="col">Timestamp</th><th scope="col">Event</th>{showMember && <th scope="col">Member</th>}<th scope="col">Details</th></tr></thead>
      <tbody>{rows.length ? rows : <tr><td colspan={showMember ? 4 : 3}>No member history found.</td></tr>}</tbody>
    </table>
  </div>;
}

async function history(url, env, member) {
  const type = Object.hasOwn(eventTypes, url.searchParams.get('event_type')) ? url.searchParams.get('event_type') : '';
  const current = pageNumber(url.searchParams);
  const clauses = [], values = [];
  if (member) { clauses.push('e.member_id = ?'); values.push(member.member_id); }
  if (type) { clauses.push('e.event_type = ?'); values.push(type); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM member_events e${where}`).bind(...values),
    env.DB.prepare(`SELECT e.*, m.discord_username, m.billing_name, m.name_override, m.email, m.waiver_name
      FROM member_events e LEFT JOIN members m ON m.member_id = e.member_id${where}
      ORDER BY e.created DESC, e.id DESC LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (current - 1) * PAGE_SIZE),
  ]);
  const total = count.results[0].total, pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageURL = n => `${url.pathname}?${new URLSearchParams({ page: n, ...(type ? { event_type: type } : {}) })}`;
  if (current > pages) return redirect(pageURL(pages));
  return page(member ? `History for ${memberName(member)}` : 'Events', <>
    {member && <p><a href={memberPath(member)}>← Back to member</a></p>}
    <p>Member changes are retained indefinitely. Timestamps are UTC.</p>
    <form method="get" action={url.pathname} class="admin-form admin-toolbar">
      <label class="sr-only" for="event-type">Event type</label>
      <select id="event-type" name="event_type" data-autosubmit>{options([['', 'All event types'], ...Object.entries(eventTypes)], type)}</select>
      <button class="btn btn-primary" type="submit">Filter</button>
      {type && <a href={url.pathname}>Clear</a>}
    </form>
    <p>{total} event{total === 1 ? '' : 's'}.</p>
    {eventTable(rows.results, !member)}
    {pagination('History pages', current, pages, pageURL)}
  </>, { admin: true });
}

// ────────────────────────────────────────────────────────────────────────
// Member create, edit, and delete
// ────────────────────────────────────────────────────────────────────────

function billingFields(form) {
  const value = { bill_annually: form.billing === 'yearly' ? 1 : 0, discount_type: form.discount_type ?? '' };
  if (!discounts.includes(value.discount_type)) throw new HttpError(400, 'Choose standard rate or a valid discount category.');
  return value;
}

function validate(form, { create = false } = {}) {
  const text = (key, label, max) => {
    const value = (form[key] ?? '').trim();
    if (value.length > max) throw new HttpError(400, `${label} must be at most ${max} characters.`);
    return value;
  };
  const value = {
    name_override: text('name_override', 'Name', 160),
    notes: text('notes', 'Notes', 5000),
    discord_user_id: text('discord_user_id', 'Discord ID', 20) || null,
  };
  if (value.discord_user_id && !discordID.test(value.discord_user_id)) throw new HttpError(400, 'Enter a valid Discord ID.');
  Object.assign(value, billingFields(form));
  if (create) {
    value.email = text('email', 'Email', 254).toLowerCase();
    if (!validEmail(value.email)) throw new HttpError(400, 'Enter a valid email address.');
    return value;
  }
  value.stripe_customer_id = text('stripe_customer_id', 'Stripe customer ID', 255) || null;
  if (value.stripe_customer_id && !/^cus_[A-Za-z0-9]+$/.test(value.stripe_customer_id)) throw new HttpError(400, 'Enter a valid Stripe customer ID.');
  const fob = text('fob_id', 'Fob ID', 10);
  if (fob && (!/^[1-9]\d{0,9}$/.test(fob) || Number(fob) > 4294967295)) throw new HttpError(400, 'Enter a fob ID from 1 through 4294967295, or leave blank.');
  value.fob_id = fob ? Number(fob) : null;
  value.non_billable = form.non_billable === 'on' ? 1 : 0;
  value.legacy_billing = form.legacy_billing === 'on' ? 1 : 0;
  value.metadata_version = Number(form.metadata_version);
  return value;
}

const conflict = error => {
  for (const [column, message] of [['fob_id', 'That fob already belongs to another member.'], ['discord_user_id', 'That Discord account already belongs to another member.'], ['stripe_customer_id', 'That Stripe customer already belongs to another member.'], ['email', 'That email already belongs to another member.']]) {
    if (String(error).includes(`members.${column}`)) return new HttpError(409, message);
  }
  return error;
};

function newMemberForm(fields, message = '', status = 200) {
  const f = fields || { billing: 'monthly', discount_type: '' };
  return page('New member', <>
    <p class="admin-back"><a href="/admin">← All members</a></p>
    {notice(message, true)}
    <form method="post" action="/admin/members/new" class="admin-form admin-section">
      {input('name_override', 'Member name', f.name_override, 160)}
      {input('email', 'Member email', f.email, 254, 'Use the member’s Discord email so their account and waiver link when they sign in.', 'email')}
      {input('discord_user_id', 'Discord ID (optional)', f.discord_user_id, 20, 'Leave blank if the member has not joined Discord yet.')}
      {billingSelects(f)}
      <div class="admin-field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" maxlength="5000" rows="4">{f.notes}</textarea></div>
      <div class="admin-actions"><button class="btn btn-primary" type="submit">Create member</button><a href="/admin">Cancel</a></div>
    </form>
  </>, { status, admin: true });
}

async function createMember(env, form) {
  const value = validate(form, { create: true });
  const username = value.discord_user_id ? await guildUsername(env, value.discord_user_id) : '';
  let member;
  try {
    member = await env.DB.prepare(`INSERT INTO members (email, name_override, notes, discord_user_id, discord_username, bill_annually, discount_type)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM members WHERE discord_email = ?1) RETURNING *`)
      .bind(value.email, value.name_override, value.notes, value.discord_user_id, username, value.bill_annually, value.discount_type).first();
  } catch (error) { throw conflict(error); }
  if (!member) throw new HttpError(409, 'That email already belongs to another member.');
  return member;
}

async function updateMember(env, member, value) {
  if (member.metadata_version !== value.metadata_version) throw new HttpError(409, 'This member was changed after you opened the form. Reload the member and reapply your edits.');
  if (member.discord_user_id && !value.discord_user_id) throw new HttpError(400, 'A linked Discord account can be transferred to another account, but not removed.');
  const discordChanged = member.discord_user_id !== value.discord_user_id;
  const customerChanged = member.stripe_customer_id !== value.stripe_customer_id;
  const username = discordChanged ? await guildUsername(env, value.discord_user_id) : member.discord_username;
  if (customerChanged && value.stripe_customer_id && (await stripe(env, `/customers/${value.stripe_customer_id}`)).deleted) {
    throw new HttpError(400, 'This Stripe customer has been deleted.');
  }
  let updated;
  try {
    updated = await env.DB.prepare(`UPDATE members SET discord_user_id = ?, ${discordChanged ? "discord_username = ?, discord_email = ''," : ''}
      name_override = ?, notes = ?, bill_annually = ?, discount_type = ?, fob_id = ?, non_billable = ?, legacy_billing = ?,
      stripe_customer_id = ?, ${customerChanged ? "stripe_subscription_id = NULL, stripe_subscription_state = NULL, billing_name = '', billing_email = ''," : ''}
      metadata_version = metadata_version + 1 WHERE member_id = ? AND metadata_version = ? RETURNING *`)
      .bind(value.discord_user_id, ...(discordChanged ? [username] : []),
        value.name_override, value.notes, value.bill_annually, value.discount_type, value.fob_id, value.non_billable, value.legacy_billing,
        value.stripe_customer_id,
        member.member_id, value.metadata_version).first();
  } catch (error) { throw conflict(error); }
  if (!updated) throw new HttpError(409, 'This member was changed after you opened the form. Reload the member and reapply your edits.');
  await pushFobs(env);
  return async () => {
    if (discordChanged) await setDiscordRole(env, member.discord_user_id, false);
    if (customerChanged) await syncMember(env, updated);
    else if (discordChanged) await syncDiscordRole(env, updated.member_id);
  };
}

const notices = {
  saved: 'Member saved.', created: 'Member created. Open Billing info to generate a checkout link.', synced: 'Stripe and Discord synchronized.',
  sync_failed: 'Saved, but Stripe or Discord synchronization failed. Use Sync with Stripe to retry.',
};

async function editor(env, member, { fields, message = '', status = 200, checkout = '' } = {}) {
  const f = fields || { ...member, billing: member.bill_annually ? 'yearly' : 'monthly' };
  const { results: events } = await env.DB.prepare('SELECT * FROM member_events WHERE member_id = ? ORDER BY created DESC, id DESC LIMIT 10').bind(member.member_id).all();
  const account = [
    ['Member email', member.email], ['Waiver name', member.waiver_name],
    ['Discord username', member.discord_username], ['Discord email', member.discord_email],
    ['Billing name (Stripe)', member.billing_name], ['Billing email (Stripe)', member.billing_email],
  ];
  const path = memberPath(member);
  return page(`Edit ${memberName(member)}`, <>
    <p class="admin-back"><a href="/admin">← All members</a></p>
    {notice(message, status >= 400)}
    <section class="admin-member-summary" aria-label="Subscription summary">
      <div class="admin-summary-line">{statusBadge(member)}{subscriptionLink(member, env)}</div>
    </section>
    <div class="admin-editor-layout">
      <form method="post" action={path} class="admin-form admin-editor">
        <button class="sr-only" type="submit" tabindex="-1" aria-hidden="true">Save changes</button>
        <input type="hidden" name="metadata_version" value={f.metadata_version ?? ''} />
        <section class="admin-section" aria-labelledby="member-settings">
          <h2 id="member-settings">Member settings</h2>
          {input('name_override', 'Name override', f.name_override, 160)}
          <div class="admin-field" aria-label="Saved fob status"><span class={`admin-status admin-status--${member.fob_enabled ? 'active' : 'inactive'}`}>Fob {member.fob_enabled ? 'enabled' : 'disabled'}</span></div>
          {input('fob_id', 'Fob ID', f.fob_id, 10)}
          {checkbox('non_billable', 'Non-billable', f.non_billable)}
          {checkbox('legacy_billing', 'Legacy billing', f.legacy_billing)}
          <details class="admin-billing admin-linked-accounts" open={!!checkout || status >= 400}>
            <summary>Billing info</summary>
            <p class="admin-help">Used for new checkouts only. Generating a link saves these choices. Manage existing subscriptions in Stripe.</p>
            {billingSelects(f)}
            <div class="admin-actions"><button class="btn btn-outline" type="submit" formaction={`${path}/checkout`}>Generate checkout link</button></div>
            <p class="admin-help">Share this Stripe link with the member, even before they link Discord. A signed waiver is still required for door access.</p>
            {checkout && <div class="admin-field"><label for="checkout-url">Shareable Stripe checkout URL</label><input id="checkout-url" type="url" readonly value={checkout} /></div>}
          </details>
          <div class="admin-field"><label for="notes">Internal notes</label><textarea id="notes" name="notes" maxlength="5000" rows="4">{f.notes}</textarea></div>
        </section>
        <details class="admin-section admin-linked-accounts" open={status >= 400}>
          <summary>Linked accounts <span>Edit Discord and Stripe IDs</span></summary>
          <div class="admin-linked-fields">
            {input('discord_user_id', 'Discord ID', f.discord_user_id, 20, 'Changing this ID transfers membership to that Discord account.')}
            {input('stripe_customer_id', 'Stripe customer ID', f.stripe_customer_id, 255, 'The current subscription is read from this customer.')}
          </div>
        </details>
        <div class="admin-actions">
          <button class="btn btn-primary" type="submit">Save changes</button>
          <a href={path}>Reload member</a>
          <button class="btn btn-outline" type="submit" form="sync-member">Sync with Stripe</button>
          <button class="btn btn-outline admin-delete" type="submit" form="delete-member" disabled>Delete member</button>
        </div>
      </form>
      <aside class="admin-section admin-account" aria-labelledby="account-details">
        <h2 id="account-details">Account details</h2>
        <dl class="admin-account-fields">
          {account.map(([label, value]) => <div><dt>{label}</dt><dd>{value || '—'}</dd></div>)}
          <div><dt>Registered</dt><dd>{date(member.created)}</dd></div>
        </dl>
      </aside>
    </div>
    <form id="sync-member" method="post" action={`${path}/sync`} />
    <form id="delete-member" method="post" action={`${path}/delete`} data-confirm={`Delete ${memberName(member)}? This cannot be undone. Cancel any Stripe subscription separately.`} />
    <noscript><p class="admin-help">Enable JavaScript to delete a member with confirmation.</p></noscript>
    <section class="card admin-section">
      <h2>Recent member history</h2>
      {eventTable(events, false)}
      <p><a href={`${path}/events`}>View full member history</a></p>
    </section>
  </>, { status, admin: true });
}

// ────────────────────────────────────────────────────────────────────────
// Routing
// ────────────────────────────────────────────────────────────────────────

export async function adminRequest(request, env) {
  const url = new URL(request.url);
  const session = await readSession(request, env);
  if (!session) {
    if (request.method === 'GET') return loginRedirect(url.pathname + url.search);
    throw new HttpError(401, 'Your session expired. Sign in again.');
  }
  if (!session.admin) throw new HttpError(403, 'Admin access is required to view this page.');
  const path = url.pathname.replace(/\/$/, '');
  const route = `${request.method} ${path}`;
  if (route === 'GET /admin') return memberList(url, env);
  if (route === 'GET /admin/events') return history(url, env);
  if (route === 'GET /admin/members/new') return newMemberForm();
  if (route === 'POST /admin/members/new') {
    const form = await readForm(request);
    try { return redirect(`${memberPath(await createMember(env, form))}?notice=created`); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return newMemberForm(form, error.message, error.status);
    }
  }
  const match = path.match(/^\/admin\/members\/([a-f0-9]{32})(\/events|\/checkout|\/sync|\/delete)?$/);
  if (!match) throw new HttpError(404, 'Admin page not found.');
  const member = await env.DB.prepare(`SELECT *, COALESCE(${fobEnabledSQL}, 0) AS fob_enabled FROM members WHERE member_id = ?`).bind(match[1]).first();
  if (!member) throw new HttpError(404, 'Member not found.');
  const action = `${request.method} ${match[2] || ''}`;
  if (action === 'GET ') return editor(env, member, { message: notices[url.searchParams.get('notice')] });
  if (action === 'GET /events') return history(url, env, member);
  if (action === 'POST ') {
    const form = await readForm(request);
    let sideEffects;
    try { sideEffects = await updateMember(env, member, validate(form)); }
    catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return editor(env, member, { fields: form, message: error.message, status: error.status });
    }
    try { await sideEffects(); }
    catch (error) {
      logError('admin.sync_failed', error, { member_id: member.member_id });
      return redirect(`${memberPath(member)}?notice=sync_failed`);
    }
    return redirect(`${memberPath(member)}?notice=saved`);
  }
  if (action === 'POST /sync') {
    await syncMember(env, member);
    return redirect(`${memberPath(member)}?notice=synced`);
  }
  if (action === 'POST /checkout') {
    // Submitted with the editor form: save the billing choices the link uses and
    // keep the admin's other unsaved edits in the redisplayed form.
    const form = await readForm(request);
    let current = member, fields = form;
    const redisplay = options => editor(env, current, { ...options, fields });
    try {
      if (Number(form.metadata_version) !== member.metadata_version) throw new HttpError(409, 'This member was changed after you opened the form. Reload the member and reapply your edits.');
      const billing = billingFields(form);
      if (billing.bill_annually !== member.bill_annually || billing.discount_type !== member.discount_type) {
        const updated = await env.DB.prepare(`UPDATE members SET bill_annually = ?, discount_type = ?, metadata_version = metadata_version + 1
          WHERE member_id = ? AND metadata_version = ? RETURNING *`)
          .bind(billing.bill_annually, billing.discount_type, member.member_id, Number(form.metadata_version)).first();
        if (!updated) throw new HttpError(409, 'This member was changed after you opened the form. Reload the member and reapply your edits.');
        current = { ...member, ...updated };
        fields = { ...form, metadata_version: updated.metadata_version };
      }
      const checkout = await checkoutLink(env, current, { shared: true });
      fields = { ...fields, metadata_version: checkout.member.metadata_version,
        ...(fields.stripe_customer_id === (current.stripe_customer_id || '') ? { stripe_customer_id: checkout.member.stripe_customer_id || '' } : {}) };
      current = checkout.member;
      return redisplay({ checkout: checkout.url, message: 'Checkout link ready to share.' });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return redisplay({ message: error.message, status: error.status });
    }
  }
  if (action === 'POST /delete') {
    await setDiscordRole(env, member.discord_user_id, false);
    // Foreign keys retain waivers and history; triggers close fob assignments.
    await env.DB.prepare('DELETE FROM members WHERE member_id = ?').bind(member.member_id).run();
    await pushFobs(env);
    return redirect('/admin');
  }
  throw new HttpError(405, 'Method not allowed.');
}
