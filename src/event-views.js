import { escapeHTML as e } from './http.js';
import { memberName } from './member-metadata.js';
import { eventListURL, eventTypes } from './member-events.js';

function eventDetails(event) {
  if (event.event_type === 'MemberRegistered') return 'Membership registered.';
  if (event.event_type === 'NotesUpdated') return 'Internal notes updated.';
  const details = JSON.parse(event.details);
  const value = item => {
    if (item === null) return 'Not set';
    if (event.event_type === 'BillingCycleChanged') return item ? 'Yearly' : 'Monthly';
    if (event.event_type === 'DiscountTypeModified' && item === '') return 'Standard rate';
    return item === '' ? '(blank)' : String(item);
  };
  return `${value(details.from)} → ${value(details.to)}`;
}

export function eventTable(events, showMember = true) {
  const rows = events.map(event => {
    const timestamp = new Date(event.created * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
    const member = event.discord_user_id ? `<a href="/admin/members/${e(event.discord_user_id)}">${e(memberName(event))}</a>` : 'Deleted member';
    return `<tr><td>${e(timestamp)}</td><td>${e(eventTypes[event.event_type] || event.event_type)}</td>${showMember ? `<td>${member}</td>` : ''}<td>${e(eventDetails(event))}</td></tr>`;
  }).join('');
  return `<div class="admin-table" role="region" aria-label="Member history" tabindex="0"><table><thead><tr><th scope="col">Timestamp</th><th scope="col">Event</th>${showMember ? '<th scope="col">Member</th>' : ''}<th scope="col">Details</th></tr></thead><tbody>${rows || `<tr><td colspan="${showMember ? 4 : 3}">No member history found.</td></tr>`}</tbody></table></div>`;
}

export function recentHistory(member, events) {
  return `<section class="card admin-section"><h2>Recent member history</h2>${eventTable(events, false)}<p><a href="/admin/members/${e(member.discord_user_id)}/events">View full member history</a></p></section>`;
}

export function eventList(history, path, member) {
  const { events, total, current, pages, type } = history;
  return `${member ? `<p><a href="/admin/members/${e(member.discord_user_id)}">← Back to member</a></p>` : ''}
    <p>Member changes are retained indefinitely. Timestamps are UTC.</p>
    <form method="get" action="${e(path)}" class="admin-form admin-search"><label for="event-type">Event type</label>
    <div class="admin-search-controls"><select id="event-type" name="event_type"><option value="">All event types</option>${Object.entries(eventTypes).map(([key, label]) => `<option value="${key}"${key === type ? ' selected' : ''}>${e(label)}</option>`).join('')}</select><button class="btn btn-primary" type="submit">Filter</button></div></form>
    <p>${total} event${total === 1 ? '' : 's'}.</p>${eventTable(events, !member)}
    <nav class="admin-pagination" aria-label="History pages">${current > 1 ? `<a class="btn btn-outline" href="${e(eventListURL(path, current - 1, type))}">Previous</a>` : ''}<span>Page ${current} of ${pages}</span>${current < pages ? `<a class="btn btn-outline" href="${e(eventListURL(path, current + 1, type))}">Next</a>` : ''}</nav>`;
}
