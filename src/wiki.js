import { signedInMember, startLogin } from './auth.js';
import { boundedBytes, boundedText, cookie, escapeHTML as e, hash, HttpError, json, origin, redirect } from './http.js';
import { eligibleEditor, wikiCall } from './wiki-store.js';
import { IMAGE_PATH, MAX_IMAGE, MAX_MARKDOWN, renderMarkdown, validSlug } from './wiki-markdown.js';
import { wikiArticle, wikiEditor, wikiIndex, wikiPage } from './wiki-views.js';
import { logError } from './logging.js';

// Bump when changing published HTML/Markdown rendering so deploys cannot reuse it.
const CACHE_VERSION = 'v1';

async function cached(request, revision, render) {
  const url = new URL(request.url);
  url.search = new URLSearchParams({ wiki_cache: CACHE_VERSION, revision }).toString();
  const key = new Request(url.href);
  let response;
  try { response = await caches.default.match(key); } catch { /* Cache is an optimization. */ }
  if (!response) {
    response = await render();
    if (response.status === 200) {
      response.headers.set('Cache-Control', 'public, max-age=86400');
      response.headers.set('ETag', `"wiki-${CACHE_VERSION}-${revision}"`);
      try { await caches.default.put(key, response.clone()); } catch { /* Still serve fresh R2 content. */ }
    }
  }
  const headers = new Headers(response.headers);
  // Always revisit the Worker and its authoritative revision, including images.
  headers.set('Cache-Control', 'public, no-cache');
  headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  if (response.status === 200 && request.headers.get('If-None-Match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === headers.get('ETag'))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}

async function readMarkdown(env, page) {
  if (!page) return '';
  const object = await env.WIKI_BUCKET.get(page.blob);
  if (!object) throw new HttpError(503, 'Page content is temporarily unavailable. Please retry.');
  return object.text();
}

async function readJSON(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') throw new HttpError(415, 'Send JSON from the wiki editor.');
  let value;
  try { value = JSON.parse(await boundedText(request, MAX_MARKDOWN * 6 + 4096)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid wiki request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Invalid wiki request.');
  return value;
}

export async function wikiRequest(request, env) {
  const url = new URL(request.url), path = url.pathname, reading = ['GET', 'HEAD'].includes(request.method);
  try {
    if (path === '/wiki/' && reading) return redirect('/wiki');
    const image = path.match(IMAGE_PATH);
    const match = path.match(/^\/wiki\/([^/]+)(?:\/(edit|delete))?$/);
    const slug = match?.[1], action = match?.[2];
    const index = path === '/wiki', newPage = path === '/wiki/new';
    const preview = path === '/wiki/preview', upload = path === '/wiki/images';
    if (!index && !newPage && !preview && !upload && !image && !(validSlug(slug) && match)) throw new HttpError(404, 'Wiki page not found.');
    const methods = image || index ? ['GET', 'HEAD'] : preview || upload || action === 'delete' ? ['POST'] : newPage || action === 'edit' ? ['GET'] : ['GET', 'HEAD', 'POST'];
    if (!methods.includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: methods.join(', '), 'Cache-Control': 'no-store' } });

    if (reading && !newPage && action !== 'edit') {
      // Public reads deliberately never inspect membership cookies or D1.
      if (index) {
        const data = await wikiCall(env, 'index');
        return await cached(request, data.revision, async () => wikiIndex(data.pages));
      }
      if (image) {
        const metadata = await wikiCall(env, 'image', { id: image[1] });
        if (!metadata) throw new HttpError(404, 'Image not found.');
        return await cached(request, metadata.id, async () => {
          const object = await env.WIKI_BUCKET.get(`images/${metadata.id}`);
          if (!object) throw new HttpError(404, 'Image not found.');
          return new Response(object.body, { headers: { 'Content-Type': metadata.type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
        });
      }
      const page = await wikiCall(env, 'page', { slug });
      if (!page) return wikiPage('Page not found', `<h1>Page not found</h1><p>This page has not been created, or has been deleted.</p><p><a href="/wiki/${e(slug)}/edit">Create this page</a> · <a href="/wiki">All pages</a></p>`, { status: 404 });
      return await cached(request, page.revision, async () => wikiArticle(page, renderMarkdown(await readMarkdown(env, page), origin(env)).html));
    }

    const member = await signedInMember(request, env);
    if (!member) {
      if (reading) return startLogin(request, env, 'member');
      throw new HttpError(401, 'Your sign-in expired. Copy your draft and sign in again before saving.');
    }
    if (!await eligibleEditor(env, member)) throw new HttpError(403, 'Wiki editing requires non-billable membership, or a signed waiver with legacy billing or an active subscription.');
    const csrf = await hash(`wiki-csrf:${cookie(request, 'thelab_member')}`);
    if (reading) {
      const page = newPage ? null : await wikiCall(env, 'page', { slug });
      return wikiEditor(page, await readMarkdown(env, page), csrf, newPage ? '' : slug);
    }
    if (request.headers.get('Origin') !== origin(env) || request.headers.get('X-Wiki-CSRF') !== csrf) throw new HttpError(403, 'Invalid editor token or origin. Copy your draft and reload the editor.');
    if (upload) return json(await wikiCall(env, 'upload', { member, bytes: await boundedBytes(request, MAX_IMAGE) }), 201);
    const input = await readJSON(request);
    if (preview) {
      if (typeof input.markdown !== 'string' || new TextEncoder().encode(input.markdown).length > MAX_MARKDOWN) throw new HttpError(413, 'Markdown must be 128 KiB or smaller.');
      return json({ html: renderMarkdown(input.markdown, origin(env)).html });
    }
    return json(await wikiCall(env, action === 'delete' ? 'delete' : 'save', { ...input, slug, member }));
  } catch (error) {
    logError('wiki.request_failed', error, { path }, env);
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof HttpError ? error.message : 'The wiki is temporarily unavailable. Please retry.';
    if (!reading) return json({ error: message }, status);
    return wikiPage('Wiki unavailable', `<h1>Let’s try that again.</h1><p>${e(message)}</p><p><a href="/wiki">Return to the wiki</a></p>`, { status });
  }
}
