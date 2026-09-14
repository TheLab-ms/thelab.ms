import { DurableObject } from 'cloudflare:workers';
import { HttpError, randomToken } from './http.js';
import { memberAccessSQL } from './fob-access.js';
import { imageType, renderMarkdown, validatePage, validSlug } from './wiki-markdown.js';
import { logError } from './logging.js';
import { authorizeImport, MAX_IMPORT_FILE } from './wiki-import.js';

export const UNUSED_AGE = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000;

export async function wikiCall(env, operation, input = {}) {
  const result = await env.WIKI.get(env.WIKI.idFromName('wiki')).execute(operation, input);
  if (!result.ok) throw new HttpError(result.status, result.error);
  return result.value;
}

export async function eligibleEditor(env, member) {
  return member && await env.DB.prepare(`SELECT member_id FROM members WHERE member_id = ?
    AND discord_user_id = ? AND auth_version = ? AND ${memberAccessSQL}`)
    .bind(member.member_id, member.discord_user_id, member.auth_version).first();
}

export class Wiki extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tail = Promise.resolve();
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS wiki_pages (slug TEXT PRIMARY KEY, title TEXT NOT NULL, revision TEXT NOT NULL, blob TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wiki_meta (id INTEGER PRIMARY KEY, revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wiki_blobs (key TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wiki_images (id TEXT PRIMARY KEY, type TEXT NOT NULL, expires INTEGER, ready INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS wiki_references (slug TEXT NOT NULL, image TEXT NOT NULL, PRIMARY KEY (slug, image));
      CREATE INDEX IF NOT EXISTS wiki_references_image ON wiki_references(image);
      CREATE TABLE IF NOT EXISTS wiki_files (id TEXT PRIMARY KEY, type TEXT NOT NULL, size INTEGER NOT NULL);
    `);
  }

  rows(query, ...values) { return this.ctx.storage.sql.exec(query, ...values).toArray(); }
  page(slug) { return this.rows('SELECT * FROM wiki_pages WHERE slug = ?', slug)[0] || null; }
  serialize(fn) {
    const work = this.tail.then(fn);
    this.tail = work.catch(() => {});
    return work;
  }

  async execute(operation, input) {
    return this.serialize(async () => {
      try {
        if (['save', 'delete', 'upload'].includes(operation) && !await eligibleEditor(this.env, input.member)) {
          throw new HttpError(403, 'Wiki editing requires an active membership.');
        }
        if (['importPage', 'importFile'].includes(operation)) await authorizeImport(this.env, input.token);
        let value;
        if (operation === 'index') value = { revision: this.rows('SELECT revision FROM wiki_meta WHERE id = 1')[0]?.revision || 'empty', pages: this.rows('SELECT slug, title, updated FROM wiki_pages ORDER BY title COLLATE NOCASE, slug') };
        else if (operation === 'page') value = this.page(input.slug);
        else if (operation === 'image') value = this.rows('SELECT id, type FROM wiki_images WHERE id = ? AND ready = 1', input.id)[0] || null;
        else if (operation === 'save') value = await this.save(input);
        else if (operation === 'delete') value = await this.remove(input);
        else if (operation === 'upload') value = await this.upload(input);
        else if (operation === 'file') value = this.rows('SELECT * FROM wiki_files WHERE id = ?', input.id)[0] || null;
        else if (operation === 'importPage') value = await this.importPage(input);
        else if (operation === 'importFile') value = await this.importFile(input);
        else throw new HttpError(400, 'Unknown wiki operation.');
        return { ok: true, value };
      } catch (error) {
        logError('wiki.failed', error, { operation }, this.env);
        return { ok: false, status: error instanceof HttpError ? error.status : 503, error: error instanceof HttpError ? error.message : 'The wiki is temporarily unavailable. Please retry.' };
      }
    });
  }

  async arm() {
    if (!await this.ctx.storage.getAlarm()) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL);
  }

  checkRevision(input) {
    const page = this.page(input.slug);
    if ((page?.revision || '') !== input.revision) throw new HttpError(409, 'This page changed since you opened it. Your text is still in the editor. Copy your draft, reload the editor, then merge your changes with the latest version.');
    return page;
  }

  async save(input) {
    validatePage(input);
    const previous = this.checkRevision(input);
    const { images, files } = renderMarkdown(input.markdown, this.env.SITE_URL);
    for (const id of files) {
      if (!this.rows('SELECT id FROM wiki_files WHERE id = ?', id).length) throw new HttpError(400, 'An imported attachment is missing.');
    }
    if (images.length > 100) throw new HttpError(400, 'A page can reference at most 100 uploaded images.');
    for (const id of images) {
      if (!this.rows('SELECT id FROM wiki_images WHERE id = ? AND ready = 1', id).length) throw new HttpError(400, 'An image in this page has expired or was deleted. Upload it again before saving.');
    }
    await this.arm();
    const revision = randomToken(), blob = `pages/${input.slug}/${revision}.md`;
    // Register first: a crash or ambiguous R2 write leaves a durable cleanup job.
    this.rows('INSERT INTO wiki_blobs (key, expires) VALUES (?, ?)', blob, Date.now() + UNUSED_AGE);
    await this.env.WIKI_BUCKET.put(blob, input.markdown, { httpMetadata: { contentType: 'text/markdown; charset=utf-8' } });
    this.ctx.storage.transactionSync(() => {
      this.rows('INSERT OR REPLACE INTO wiki_pages (slug, title, revision, blob, updated) VALUES (?, ?, ?, ?, ?)', input.slug, input.title.trim(), revision, blob, new Date().toISOString());
      if (previous) this.rows('UPDATE wiki_blobs SET expires = ? WHERE key = ?', Date.now() + UNUSED_AGE, previous.blob);
      this.updateReferences(input.slug, images);
      this.rows('INSERT OR REPLACE INTO wiki_meta (id, revision) VALUES (1, ?)', revision);
    });
    return { slug: input.slug, revision };
  }

  updateReferences(slug, images) {
    const previous = this.rows('SELECT image FROM wiki_references WHERE slug = ?', slug);
    this.rows('DELETE FROM wiki_references WHERE slug = ?', slug);
    for (const id of images) {
      this.rows('INSERT INTO wiki_references (slug, image) VALUES (?, ?)', slug, id);
      this.rows('UPDATE wiki_images SET expires = NULL WHERE id = ?', id);
    }
    for (const { image } of previous) {
      this.rows(`UPDATE wiki_images SET expires = ? WHERE id = ? AND NOT EXISTS
        (SELECT 1 FROM wiki_references WHERE image = ?)`, Date.now() + UNUSED_AGE, image, image);
    }
  }

  async remove(input) {
    if (!validSlug(input.slug)) throw new HttpError(400, 'Invalid page address.');
    const page = this.checkRevision(input);
    if (!page) throw new HttpError(404, 'Page not found.');
    await this.arm();
    this.ctx.storage.transactionSync(() => {
      this.rows('DELETE FROM wiki_pages WHERE slug = ?', input.slug);
      this.rows('UPDATE wiki_blobs SET expires = ? WHERE key = ?', Date.now() + UNUSED_AGE, page.blob);
      this.updateReferences(input.slug, []);
      this.rows('INSERT OR REPLACE INTO wiki_meta (id, revision) VALUES (1, ?)', randomToken());
    });
    return { deleted: true };
  }

  async upload(input) {
    const bytes = new Uint8Array(input.bytes), type = imageType(bytes), id = randomToken();
    await this.arm();
    this.rows('INSERT INTO wiki_images (id, type, expires) VALUES (?, ?, ?)', id, type, Date.now() + UNUSED_AGE);
    await this.env.WIKI_BUCKET.put(`images/${id}`, bytes, { httpMetadata: { contentType: type } });
    this.rows('UPDATE wiki_images SET ready = 1 WHERE id = ?', id);
    return { url: `/wiki/images/${id}` };
  }

  async importFile(input) {
    const bytes = new Uint8Array(input.bytes);
    if (!bytes.length || bytes.length > MAX_IMPORT_FILE) throw new HttpError(413, 'Imported files must be between 1 byte and 25 MiB.');
    const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    if (id !== input.id) throw new HttpError(400, 'Attachment checksum mismatch.');
    // Only verified raster signatures and SVGs may render as images. Everything
    // else is served as a download with a sandbox policy by the public route.
    let type = 'application/octet-stream';
    try { type = imageType(bytes.slice(0, 64)); } catch { /* Other original attachment. */ }
    if (type === 'application/octet-stream' && input.type === 'image/svg+xml'
      && /<svg[\s>]/i.test(new TextDecoder().decode(bytes.slice(0, 4096)))) type = 'image/svg+xml';
    const existing = this.rows('SELECT * FROM wiki_files WHERE id = ?', id)[0];
    if (existing && await this.env.WIKI_BUCKET.head(`files/${id}`)) return { id, skipped: true };
    await this.env.WIKI_BUCKET.put(`files/${id}`, bytes, { httpMetadata: { contentType: type } });
    this.rows('INSERT OR REPLACE INTO wiki_files (id, type, size) VALUES (?, ?, ?)', id, type, bytes.length);
    return { id, skipped: false };
  }

  async importPage(input) {
    // Imports are create-only, with content comparison for safe retries after
    // an ambiguous HTTP result. Never replace a member's existing edits.
    input = { ...input, revision: '' };
    validatePage(input);
    if (input.updated && !Number.isFinite(Date.parse(input.updated))) throw new HttpError(400, 'Invalid source timestamp.');
    const previous = this.page(input.slug);
    if (previous) {
      const object = await this.env.WIKI_BUCKET.get(previous.blob);
      if (previous.title === input.title.trim() && object && await object.text() === input.markdown) return { slug: input.slug, revision: previous.revision, skipped: true };
      throw new HttpError(409, `Import conflicts with existing page: ${input.slug}`);
    }
    const result = await this.save(input);
    if (input.updated) this.rows('UPDATE wiki_pages SET updated = ? WHERE slug = ?', new Date(input.updated).toISOString(), input.slug);
    return { ...result, skipped: false };
  }

  async alarm() {
    return this.serialize(async () => {
      // Rearm before external deletes, so outages and interrupted batches retry.
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL);
      const images = this.rows(`SELECT id FROM wiki_images WHERE expires <= ? AND NOT EXISTS
        (SELECT 1 FROM wiki_references WHERE image = wiki_images.id) LIMIT 100`, Date.now());
      for (const { id } of images) {
        this.rows('UPDATE wiki_images SET ready = 0 WHERE id = ?', id);
        await this.env.WIKI_BUCKET.delete(`images/${id}`);
        this.rows('DELETE FROM wiki_images WHERE id = ?', id);
      }
      const blobs = this.rows(`SELECT key FROM wiki_blobs WHERE expires <= ? AND NOT EXISTS
        (SELECT 1 FROM wiki_pages WHERE blob = wiki_blobs.key) LIMIT 100`, Date.now());
      for (const { key } of blobs) {
        await this.env.WIKI_BUCKET.delete(key);
        this.rows('DELETE FROM wiki_blobs WHERE key = ?', key);
      }
      if (!this.rows('SELECT 1 FROM wiki_images WHERE expires IS NOT NULL LIMIT 1').length
        && !this.rows('SELECT 1 FROM wiki_blobs WHERE NOT EXISTS (SELECT 1 FROM wiki_pages WHERE blob = wiki_blobs.key) LIMIT 1').length) await this.ctx.storage.deleteAlarm();
    });
  }
}
