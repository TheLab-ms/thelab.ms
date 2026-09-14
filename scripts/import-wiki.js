import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256, fileURL } from './download-wiki.js';
import { renderMarkdown, validatePage, MAX_MARKDOWN } from '../src/wiki-markdown.js';

const MAX_FILE = 25 * 1024 * 1024;
const label = value => String(value).replace(/[\\[\]`*_<>]/g, '\\$&').replaceAll('\n', ' ');

export async function prepareImport(directory, { allowIncomplete = false } = {}) {
  const root = await realpath(resolve(directory));
  const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.pages) || !Array.isArray(manifest.media) || !Array.isArray(manifest.archives)) throw new Error('Unsupported export manifest');
  if (manifest.errors.length && !allowIncomplete) throw new Error(`Export has ${manifest.errors.length} errors. Review manifest.json, then re-download or explicitly use --allow-incomplete.`);
  async function checked(item) {
    const path = await realpath(resolve(root, item.file));
    if (!path.startsWith(`${root}${sep}`)) throw new Error(`Export path escapes directory: ${item.file}`);
    const bytes = await readFile(path);
    if (sha256(bytes) !== item.sha256) throw new Error(`Checksum mismatch: ${item.file}`);
    return bytes;
  }
  const files = new Map();
  for (const item of [...manifest.media, ...manifest.archives]) {
    if (!item.file) { if (allowIncomplete) continue; throw new Error(`Missing attachment: ${item.id}`); }
    const bytes = await checked(item);
    if (!bytes.length || bytes.length > MAX_FILE) throw new Error(`Attachment must be 1 byte to 25 MiB: ${item.file}`);
    files.set(item.sha256, { ...item, bytes });
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), manifestHash = sha256(manifestBytes);
  files.set(manifestHash, { bytes: manifestBytes, sha256: manifestHash, type: 'application/json', file: 'manifest.json' });
  const pages = [], slugs = new Set();
  for (const page of manifest.pages) {
    if (slugs.has(page.slug)) throw new Error(`Duplicate page slug: ${page.slug}`);
    slugs.add(page.slug);
    const original = (await checked(page)).toString('utf8');
    const provenance = `\n\n---\n\nMigrated from [${label(page.id)}](${page.sourceURL}). `
      + `[Original DokuWiki source](${page.raw})${page.history ? ` · [Revision archive](${page.history})` : ''}.\n`;
    const input = { slug: page.slug, title: page.title, markdown: original + provenance, updated: page.updated, revision: '' };
    validatePage(input);
    pages.push(input);
  }
  // Orphaned media and original history stay discoverable and are never GC'd.
  const entries = [
    `# DokuWiki migration archive\n\n[Export manifest and migration report](${fileURL(manifestHash, 'manifest.json')})\n`,
    ...manifest.media.filter(m => m.file).map(m => `- [${label(m.id)}](${m.url})\n`),
  ];
  let markdown = '', part = 1;
  const addArchive = () => {
    const slug = part === 1 ? 'migration-archive' : `migration-archive-${part}`;
    if (slugs.has(slug)) throw new Error(`Archive slug collision: ${slug}`);
    slugs.add(slug);
    const input = { slug, title: `DokuWiki migration archive${part > 1 ? ` (${part})` : ''}`, markdown, revision: '' };
    validatePage(input); pages.push(input); part++; markdown = '';
  };
  for (const entry of entries) {
    if (Buffer.byteLength(markdown + entry) > MAX_MARKDOWN - 1024) {
      markdown += `\n[Next archive page](/wiki/migration-archive-${part + 1})\n`; addArchive();
    }
    markdown += entry;
  }
  addArchive();
  for (const page of pages) {
    const rendered = renderMarkdown(page.markdown, 'https://migration.example');
    for (const id of rendered.files) if (!files.has(id)) throw new Error(`Missing attachment ${id} on ${page.slug}`);
    if (rendered.images.length) throw new Error(`Unexpected member-upload reference on ${page.slug}`);
  }
  return { files: [...files.values()], pages, warnings: manifest.warnings, errors: manifest.errors };
}

export async function importWiki({ directory = 'wiki-export', target, token = process.env.WIKI_IMPORT_TOKEN, dryRun = false, allowIncomplete = false, verifyOnly = false, fetcher = fetch } = {}) {
  const plan = await prepareImport(directory, { allowIncomplete });
  console.log(`Validated ${plan.pages.length} pages and ${plan.files.length} unique files; ${plan.warnings.length} source/conversion warnings.`);
  if (dryRun) return plan;
  if (!target || (!token && !verifyOnly)) throw new Error('Set WIKI_IMPORT_TOKEN and pass --target https://thelab.ms (or use --dry-run).');
  const url = new URL(target);
  if (url.origin !== target || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Target must be an HTTPS origin, or local development origin.');
  async function post(path, body, headers) {
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await fetcher(`${target}/wiki/import/${path}`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body, redirect: 'error', signal: AbortSignal.timeout(120000) });
      } catch (e) { if (attempt === 3) throw e; }
      if (response?.ok) return response.json();
      if (response && response.status < 500 && response.status !== 429) throw new Error(`Import ${path}: HTTP ${response.status}: ${await response.text()}`);
      if (attempt === 3) throw new Error(`Import ${path} failed after retries: ${response?.status}`);
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  for (const file of verifyOnly ? [] : plan.files) {
    const result = await post('file', file.bytes, { 'Content-Type': file.type, 'X-Content-SHA256': file.sha256 });
    console.log(`${result.skipped ? 'Exists' : 'Imported'} file ${file.file}`);
  }
  for (const page of verifyOnly ? [] : plan.pages) {
    const result = await post('page', JSON.stringify(page), { 'Content-Type': 'application/json' });
    console.log(`${result.skipped ? 'Exists' : 'Imported'} page ${page.slug}`);
  }
  for (const file of plan.files) {
    const response = await fetcher(`${target}${fileURL(file.sha256, file.name || file.id || file.file.split('/').at(-1))}`, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== file.sha256) throw new Error(`Published attachment verification failed: ${file.file}`);
  }
  for (const page of plan.pages) {
    const response = await fetcher(`${target}/wiki/${page.slug}`, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !(await response.text()).includes(renderMarkdown(page.markdown, target).html)) throw new Error(`Published page verification failed: ${page.slug}`);
  }
  console.log(`Verified all ${plan.pages.length} published pages and ${plan.files.length} attachment checksums.`);
  if (!verifyOnly) console.log('Import complete. Re-running is safe: matching content is skipped; conflicting pages stop the import.');
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, target: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'allow-incomplete': { type: 'boolean' }, 'verify-only': { type: 'boolean' } } });
  importWiki({ ...values, dryRun: values['dry-run'], allowIncomplete: values['allow-incomplete'], verifyOnly: values['verify-only'] }).catch(e => { console.error(e.message); process.exitCode = 1; });
}
