import { HttpError, redirect } from './http.js';

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
