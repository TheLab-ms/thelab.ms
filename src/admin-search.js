import { HttpError } from './http.js';

export const MAX_SEARCH_LENGTH = 254;

export function memberListParams(params) {
  const raw = params.get('page') || '1';
  if (!/^[1-9]\d{0,7}$/.test(raw) || params.getAll('page').length > 1) throw new HttpError(400, 'Invalid page number.');
  const query = (params.get('q') || '').trim();
  if (params.getAll('q').length > 1 || query.length > MAX_SEARCH_LENGTH) throw new HttpError(400, `Enter a single search of at most ${MAX_SEARCH_LENGTH} characters.`);
  return { current: Number(raw), query };
}

export function memberListURL(current, query) {
  const params = new URLSearchParams({ page: String(current) });
  if (query) params.set('q', query);
  return `/admin?${params}`;
}
