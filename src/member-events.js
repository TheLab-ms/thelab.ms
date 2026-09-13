import { HttpError } from './http.js';

export const eventTypes = {
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

export function eventListParams(params) {
  const raw = params.get('page') || '1';
  const type = params.get('event_type') || '';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  if (params.getAll('event_type').length > 1 || (type && !Object.hasOwn(eventTypes, type))) throw new HttpError(400, 'Invalid event type.');
  if ([...params.keys()].some(key => !['page', 'event_type'].includes(key))) throw new HttpError(400, 'Invalid history parameters.');
  return { current: Number(raw), type };
}

export function eventListURL(path, current, type = '') {
  const params = new URLSearchParams({ page: String(current) });
  if (type) params.set('event_type', type);
  return `${path}?${params}`;
}

export async function queryEvents(env, { memberID, type = '', current = 1, limit = 25 } = {}) {
  const clauses = [], values = [];
  if (memberID) { clauses.push('e.member_id = ?'); values.push(memberID); }
  if (type) { clauses.push('e.event_type = ?'); values.push(type); }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS total FROM member_events e${where}`).bind(...values),
    env.DB.prepare(`SELECT e.*, m.discord_user_id, m.discord_username, m.billing_name, m.name_override, m.email, m.waiver_name
      FROM member_events e LEFT JOIN members m ON m.member_id = e.member_id${where}
      ORDER BY e.created DESC, e.id DESC LIMIT ? OFFSET ?`).bind(...values, limit, (current - 1) * limit),
  ]);
  const total = count.results[0].total;
  return { events: rows.results, total, current, pages: Math.max(1, Math.ceil(total / limit)), type };
}
