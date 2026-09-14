import { boundedBytes, hash, HttpError, json } from './http.js';
import { wikiCall } from './wiki-store.js';
import { MAX_MARKDOWN } from './wiki-markdown.js';

export const MAX_IMPORT_FILE = 25 * 1024 * 1024;

export async function authorizeImport(env, token) {
  if (!env.WIKI_IMPORT_TOKEN) throw new HttpError(404, 'Wiki import is disabled.');
  if (typeof token !== 'string' || !token || await hash(token) !== await hash(env.WIKI_IMPORT_TOKEN)) throw new HttpError(403, 'Invalid wiki import token.');
}

export async function importRequest(request, env) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  await authorizeImport(env, token);
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const path = new URL(request.url).pathname;
  if (path === '/wiki/import/file') {
    const bytes = await boundedBytes(request, MAX_IMPORT_FILE);
    return json(await wikiCall(env, 'importFile', { token, bytes, id: request.headers.get('X-Content-SHA256'), type: request.headers.get('Content-Type') }));
  }
  if (path !== '/wiki/import/page') throw new HttpError(404, 'Import operation not found.');
  let input;
  try { input = JSON.parse(new TextDecoder().decode(await boundedBytes(request, MAX_MARKDOWN * 6 + 4096))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid import JSON.'); }
  return json(await wikiCall(env, 'importPage', { ...input, token }));
}
