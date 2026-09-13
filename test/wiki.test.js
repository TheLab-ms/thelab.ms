import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { loginDestination, memberToken, verifyToken } from '../src/auth.js';
import { hash } from '../src/http.js';
import { MAX_IMAGE, MAX_MARKDOWN, renderMarkdown } from '../src/wiki-markdown.js';
import { wikiCall } from '../src/wiki-store.js';

const stub = () => env.WIKI.get(env.WIKI.idFromName('wiki'));
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
let token, member;
const request = (path, init = {}, bindings = env) => worker.fetch(new Request(`${env.SITE_URL}${path}`, init), bindings);
const authHeaders = async () => ({ Cookie: `thelab_member=${token}`, Origin: env.SITE_URL, 'X-Wiki-CSRF': await hash(`wiki-csrf:${token}`) });
const post = async (path, value, headers = {}) => request(path, { method: 'POST', headers: { ...await authHeaders(), 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
const save = (slug, markdown = 'Hello **makers**.', revision = '', title = 'Workshop guide') => post(`/wiki/${slug}`, { title, markdown, revision });
const upload = async () => {
  const response = await request('/wiki/images', { method: 'POST', headers: await authHeaders(), body: png });
  expect(response.status).toBe(201);
  return (await response.json()).url;
};
const expire = () => runInDurableObject(stub(), instance => {
  instance.rows('UPDATE wiki_images SET expires = 0 WHERE expires IS NOT NULL');
  instance.rows('UPDATE wiki_blobs SET expires = 0');
});

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  member = await env.DB.prepare(`INSERT INTO members (discord_user_id, non_billable) VALUES ('333333333333333333', 1) RETURNING *`).first();
  token = await memberToken(env, member);
});
afterEach(() => vi.restoreAllMocks());

it('lets anonymous visitors read R2-backed pages and the index without D1 or personalized cookies', async () => {
  const created = await save('first-page');
  expect(created.status).toBe(200);
  const metadata = await wikiCall(env, 'page', { slug: 'first-page' });
  expect(await (await env.WIKI_BUCKET.get(metadata.blob)).text()).toBe('Hello **makers**.');
  const publicEnv = { ...env, DB: { prepare() { throw new Error('Public read used D1'); } } };
  const response = await request('/wiki/first-page', { headers: { Cookie: 'thelab_member=invalid' } }, publicEnv);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('<strong>makers</strong>');
  expect(response.headers.has('Set-Cookie')).toBe(false);
  expect(response.headers.get('Cache-Control')).toBe('public, no-cache');
  expect(await (await request('/wiki', {}, publicEnv)).text()).toContain('href="/wiki/first-page"');
  expect((await request('/wiki/first-page', { method: 'HEAD' })).status).toBe(200);
  expect((await request('/wiki/', {})).headers.get('Location')).toBe('/wiki');
});

it('returns editors through member OAuth and rejects unauthenticated writes rather than redirecting drafts', async () => {
  const response = await request('/wiki/first-page/edit');
  const oauth = new URL(response.headers.get('Location')).searchParams.get('state');
  expect(await verifyToken(env, oauth, 'oauth')).toMatchObject({ purpose: 'member', return_to: '/wiki/first-page/edit' });
  expect(loginDestination('/wiki/new', 'member')).toBe('/wiki/new');
  expect(loginDestination('//evil.example/wiki/new', 'member')).toBe('/payment/resume');
  const denied = await request('/wiki/first-page', { method: 'POST', body: '{}' });
  expect(denied.status).toBe(401);
  expect(denied.headers.get('Location')).toBeNull();
  expect((await denied.json()).error).toContain('sign-in');
  const editor = await request('/wiki/new', { headers: await authHeaders() });
  expect(editor.status).toBe(200);
  expect(editor.headers.get('Cache-Control')).toBe('no-store');
  expect(await editor.text()).toContain('id="wiki-markdown"');
});

it.each([
  ['active', true, 0, 0, 200], ['active', false, 0, 0, 403],
  ['trialing', true, 0, 0, 403], ['past_due', true, 0, 0, 403],
  ['canceled', true, 0, 1, 200], [null, false, 0, 1, 403],
  [null, false, 1, 0, 200], [null, false, 1, 1, 200],
])('uses door membership eligibility without requiring a fob: %s waiver=%s non-billable=%s legacy=%s', async (state, waiver, nonBillable, legacy, status) => {
  await env.DB.prepare('UPDATE members SET stripe_subscription_state = ?, non_billable = ?, legacy_billing = ?').bind(state, nonBillable, legacy).run();
  if (waiver) await env.DB.prepare(`INSERT INTO waivers(member_id, version, content, name, email, agreements) VALUES (?, 1, 'Terms', 'Maker', 'maker@example.com', '[]')`).bind(member.member_id).run();
  expect((await save('guide')).status).toBe(status);
  expect((await request('/wiki/new', { headers: await authHeaders() })).status).toBe(status);
  expect((await request('/wiki/images', { method: 'POST', headers: await authHeaders(), body: png })).status).toBe(status === 200 ? 201 : status);
});

it('rechecks membership, identity revocation, CSRF, and origin for writes', async () => {
  expect((await save('guide')).status).toBe(200);
  expect((await post('/wiki/preview', { markdown: 'draft' }, { Origin: 'https://evil.example' })).status).toBe(403);
  expect((await post('/wiki/guide/delete', { revision: '' }, { 'X-Wiki-CSRF': 'bad' })).status).toBe(403);
  await env.DB.prepare('UPDATE members SET non_billable = 0').run();
  expect((await save('another')).status).toBe(403);
  // The coordinator independently rejects an old member snapshot.
  await expect(wikiCall(env, 'save', { member, slug: 'another', title: 'Title', markdown: '', revision: '' })).rejects.toThrow('eligible membership');
  await env.DB.prepare('UPDATE members SET non_billable = 1, auth_version = auth_version + 1').run();
  expect((await save('another')).status).toBe(401);
  expect((await request('/wiki/guide')).status).toBe(200);
});

it('serializes competing creates/edits, rejects stale deletes, and changes page and index cache keys', async () => {
  const creates = await Promise.all([save('guide', 'First'), save('guide', 'Second')]);
  expect(creates.map(r => r.status).sort()).toEqual([200, 409]);
  const page = await wikiCall(env, 'page', { slug: 'guide' });
  const old = await request('/wiki/guide'), etag = old.headers.get('ETag');
  const oldIndex = await request('/wiki'), indexTag = oldIndex.headers.get('ETag');
  expect((await request('/wiki/guide', { headers: { 'If-None-Match': etag } })).status).toBe(304);
  // Simulate two edge caches populated with the old revision.
  const oldCacheKey = `${env.SITE_URL}/wiki/guide?wiki_cache=v1&revision=${page.revision}`;
  expect(await caches.default.match(oldCacheKey)).toBeDefined();
  const edits = await Promise.all([save('guide', 'Updated one', page.revision, 'New title'), save('guide', 'Updated two', page.revision, 'New title')]);
  expect(edits.map(r => r.status).sort()).toEqual([200, 409]);
  const fresh = await request('/wiki/guide?ignored=1', { headers: { 'If-None-Match': etag } });
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get('ETag')).not.toBe(etag);
  expect(await fresh.text()).toContain('Updated');
  const index = await request('/wiki', { headers: { 'If-None-Match': indexTag } });
  expect(index.status).toBe(200);
  expect(await index.text()).toContain('New title');
  // Old entries may remain, but authoritative revision selection bypasses them.
  expect(await caches.default.match(oldCacheKey)).toBeDefined();
  expect((await post('/wiki/guide/delete', { revision: page.revision })).status).toBe(409);
  const current = await wikiCall(env, 'page', { slug: 'guide' });
  expect((await post('/wiki/guide/delete', { revision: current.revision })).status).toBe(200);
  expect((await request('/wiki/guide', { headers: { 'If-None-Match': etag } })).status).toBe(404);
  expect(await (await request('/wiki')).text()).not.toContain('href="/wiki/guide"');
});

it('serves cached reads without retrieving R2 and never caches editor credentials', async () => {
  await save('cached');
  await request('/wiki/cached');
  const failing = { ...env, WIKI_BUCKET: { get() { throw new Error('Cache miss'); } } };
  expect((await request('/wiki/cached', {}, failing)).status).toBe(200);
  const editor = await request('/wiki/cached/edit', { headers: await authHeaders() });
  expect(editor.headers.get('Cache-Control')).toBe('no-store');
  expect(await editor.text()).toContain('Hello **makers**.');
  expect(await caches.default.match(`${env.SITE_URL}/wiki/cached/edit`)).toBeUndefined();
});

it('uses the same safe Markdown rendering in previews and published pages', async () => {
  const image = await upload();
  const markdown = `## Heading\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![bad](https://evil.example/track.png)\n\n![local](${image})\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n\`code\``;
  const preview = await post('/wiki/preview', { markdown });
  const { html } = await preview.json();
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="https://evil.example');
  expect(html).toContain('<table>');
  expect(html).toContain(`src="${image}"`);
  await save('safe', markdown, '', '</textarea><script>bad</script>');
  expect(await (await request('/wiki/safe')).text()).toContain(html);
  const editor = await request('/wiki/safe/edit', { headers: await authHeaders() });
  expect(await editor.text()).toContain('&lt;/textarea&gt;&lt;script&gt;bad&lt;/script&gt;');
});

it('validates image bytes, request limits, missing images, and page addresses', async () => {
  const bad = await request('/wiki/images', { method: 'POST', headers: { ...await authHeaders(), 'Content-Type': 'image/png' }, body: '<svg onload="alert(1)"></svg>' });
  expect(bad.status).toBe(415);
  expect((await request('/wiki/images', { method: 'POST', headers: await authHeaders(), body: new Uint8Array(MAX_IMAGE + 1) })).status).toBe(413);
  expect((await save('guide', 'x'.repeat(MAX_MARKDOWN + 1))).status).toBe(413);
  expect((await save('guide', `![missing](/wiki/images/${'a'.repeat(64)})`)).status).toBe(400);
  expect((await save('BAD')).status).toBe(404);
  expect((await save('x'.repeat(81))).status).toBe(404);
  expect((await request('/wiki/new', { method: 'POST' })).status).toBe(405);
  expect((await request('/wiki/images/not-an-id')).status).toBe(404);
  const url = await upload(), response = await request(url);
  expect(response.headers.get('Content-Type')).toBe('image/png');
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
});

it('tracks reference-style, absolute, encoded, and linked images while ignoring code and HTML', () => {
  const id = 'b'.repeat(64);
  expect(renderMarkdown(`![one][pic]\n\n[pic]: ${env.SITE_URL}/wiki/images/${id}\n\n[download](/wiki/images/${id})`, env.SITE_URL).images).toEqual([id]);
  expect(renderMarkdown(`![encoded](/wiki/images/%62${id.slice(1)})`, env.SITE_URL).images).toEqual([id]);
  expect(renderMarkdown(`\`![example](/wiki/images/${id})\`\n\n<img src="/wiki/images/${id}">`, env.SITE_URL).images).toEqual([]);
});

it('cleans abandoned uploads and old blobs, preserving images used by any page', async () => {
  const shared = await upload(), abandoned = await upload();
  const first = await (await save('one', `![shared](${shared})`)).json();
  const second = await (await save('two', `[image](${shared})`)).json();
  await request(shared); await request(abandoned);
  await save('one', 'Image removed', first.revision);
  await expire(); await runDurableObjectAlarm(stub());
  expect((await request(shared)).status).toBe(200);
  expect((await request(abandoned)).status).toBe(404);
  expect(await env.WIKI_BUCKET.head(abandoned.slice('/wiki/'.length))).toBeNull();
  await post('/wiki/two/delete', { revision: second.revision });
  // Last-reference removal starts a new 24-hour grace period.
  await runDurableObjectAlarm(stub());
  expect((await request(shared)).status).toBe(200);
  await expire(); await runDurableObjectAlarm(stub());
  expect((await request(shared)).status).toBe(404);
  expect(await env.WIKI_BUCKET.head(shared.slice('/wiki/'.length))).toBeNull();
  const current = await wikiCall(env, 'page', { slug: 'one' });
  expect(await env.WIKI_BUCKET.head(current.blob)).not.toBeNull();
  expect((await env.WIKI_BUCKET.list({ prefix: 'pages/' })).objects.map(object => object.key)).toEqual([current.blob]);
});

it('cancels image deletion on reuse, and prevents resurrecting already-deleted uploads', async () => {
  const image = await upload();
  const first = await (await save('one', `![photo](${image})`)).json();
  await save('one', 'Removed', first.revision);
  await expire();
  expect((await save('two', `![reused](${image})`)).status).toBe(200);
  await runDurableObjectAlarm(stub());
  expect((await request(image)).status).toBe(200);
  const abandoned = await upload();
  await expire(); await runDurableObjectAlarm(stub());
  expect((await save('three', `![expired](${abandoned})`)).status).toBe(400);
});

it('does not publish failed R2 writes; alarms clean ambiguous uploads and retry failed deletes', async () => {
  await save('guide', 'Original');
  const original = await wikiCall(env, 'page', { slug: 'guide' });
  await runInDurableObject(stub(), instance => {
    const bucket = instance.env.WIKI_BUCKET;
    instance.env = { ...instance.env, WIKI_BUCKET: {
      async put(...args) { await bucket.put(...args); throw new Error('Ambiguous storage write'); },
    } };
  });
  expect((await save('guide', 'Failed', original.revision)).status).toBe(503);
  expect((await request('/wiki/images', { method: 'POST', headers: await authHeaders(), body: png })).status).toBe(503);
  expect((await wikiCall(env, 'page', { slug: 'guide' })).revision).toBe(original.revision);
  expect(await (await request('/wiki/guide')).text()).toContain('Original');
  await runInDurableObject(stub(), instance => { instance.env = { ...instance.env, WIKI_BUCKET: env.WIKI_BUCKET }; });
  const image = await upload();
  await expire();
  await runInDurableObject(stub(), async instance => {
    const bucket = instance.env.WIKI_BUCKET;
    instance.env = { ...instance.env, WIKI_BUCKET: { delete() { throw new Error('Temporary delete failure'); } } };
    await expect(instance.alarm()).rejects.toThrow('Temporary delete failure');
    expect(await instance.ctx.storage.getAlarm()).not.toBeNull();
    instance.env = { ...instance.env, WIKI_BUCKET: bucket };
  });
  await runDurableObjectAlarm(stub());
  expect((await request(image)).status).toBe(404);
  expect((await env.WIKI_BUCKET.list({ prefix: 'images/' })).objects).toHaveLength(0);
  expect((await env.WIKI_BUCKET.list({ prefix: 'pages/' })).objects.map(object => object.key)).toEqual([original.blob]);
});
