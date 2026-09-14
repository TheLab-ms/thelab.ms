import { HttpError } from './http.js';

export const MAX_SEARCH_LENGTH = 254;
export const memberFilters = [
  { name: 'waiver', label: 'Waiver status', defaultValue: 'signed', choices: [['all', 'Any waiver status'], ['signed', 'Waiver signed'], ['unsigned', 'Waiver not signed']] },
  { name: 'discord', label: 'Discord status', defaultValue: 'linked', choices: [['all', 'Any Discord status'], ['linked', 'Discord linked'], ['unlinked', 'Discord not linked']] },
  { name: 'payment', label: 'Payment status', defaultValue: 'all', choices: [['all', 'Any payment status'], ['inactive', 'Inactive'], ['non_billable', 'Non-billable'], ['legacy_billing', 'Legacy billing'], ['stripe_active', 'Stripe active']] },
];
export const defaultMemberFilters = Object.fromEntries(memberFilters.map(({ name, defaultValue }) => [name, defaultValue]));

export function memberListParams(params) {
  const raw = params.get('page') || '1';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  const query = (params.get('q') || '').trim();
  if (params.getAll('q').length > 1 || query.length > MAX_SEARCH_LENGTH) throw new HttpError(400, `Enter a single search of at most ${MAX_SEARCH_LENGTH} characters.`);
  const filters = Object.fromEntries(memberFilters.map(({ name, defaultValue, choices }) => {
    const value = params.get(name) ?? defaultValue;
    if (params.getAll(name).length > 1 || !choices.some(([key]) => key === value)) throw new HttpError(400, `Invalid ${name} filter.`);
    return [name, value];
  }));
  return { current: Number(raw), query, filters };
}

export function memberListURL(current, query, filters = defaultMemberFilters) {
  const params = new URLSearchParams({ page: String(current) });
  if (query) params.set('q', query);
  for (const { name, defaultValue } of memberFilters) {
    if (filters[name] !== defaultValue) params.set(name, filters[name]);
  }
  return `/admin?${params}`;
}
