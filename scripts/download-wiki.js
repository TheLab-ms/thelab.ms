import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { load } from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const slugFor = id => {
  const slug = id.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug && slug.length <= 65 && !['new', 'images', 'files', 'preview', 'import', 'migration-archive'].includes(slug)
    ? slug : `${slug.slice(0, 60) || 'page'}-${sha256(id).slice(0, 12)}`;
};
const filename = id => id.split(':').at(-1).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'attachment';
export const fileURL = (hash, name) => `/wiki/files/${hash}/${filename(name)}`;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function atomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, data);
  await rename(`${path}.tmp`, path);
}
async function pool(items, fn, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export function mediaID(href, base) {
  const url = new URL(href, base);
  if (url.origin !== new URL(base).origin) return null;
  if (/^\/_media\//.test(url.pathname)) {
    const id = decodeURIComponent(url.pathname.slice(8)).replace(/^:/, '');
    return /^https?:\/\//.test(id) ? null : id;
  }
  if (/^\/_detail\//.test(url.pathname) || ['/lib/exe/fetch.php', '/lib/exe/detail.php'].includes(url.pathname)) {
    const id = (url.searchParams.get('media') || decodeURIComponent(url.pathname.slice(9))).replace(/^:/, '');
    return /^https?:\/\//.test(id) ? null : id;
  }
  return null;
}
export function pageID(href, base) {
  const url = new URL(href, base);
  if (url.origin !== new URL(base).origin || url.searchParams.get('do') || url.searchParams.has('rev')) return null;
  if (url.pathname === '/doku.php') return url.searchParams.get('id') || 'start';
  if (/^\/(?:_|lib\/|feed\.php)/.test(url.pathname)) return null;
  return decodeURIComponent(url.pathname.slice(1)).replaceAll('/', ':') || 'start';
}
export function article(html) {
  const match = html.match(/<!-- wikipage start -->([\s\S]*?)<!-- wikipage stop -->/);
  if (match) return match[1];
  const $ = load(html);
  if ($('.dokuwiki.export').length) return $('.dokuwiki.export').html();
  throw new Error('Response has no DokuWiki article (login/error page?)');
}

// Convert rendered DokuWiki rather than attempting to reimplement its parser/plugins.
export function convert(html, { id, source, slugs, media, warnings }) {
  const $ = load(article(html), null, false);
  $('#dw__toc, script, style, .editbutton_section').remove();
  // Cloudflare obfuscates addresses in HTML; restore the original visible text.
  $('[data-cfemail]').each((_, el) => {
    const value = $(el).attr('data-cfemail');
    if (!/^(?:[a-f0-9]{2})+$/i.test(value)) return;
    const bytes = Buffer.from(value, 'hex'), email = Buffer.from(bytes.subarray(1).map(b => b ^ bytes[0])).toString('utf8');
    const node = $(el), parent = node.parent('a');
    if (parent.length) parent.attr('href', `mailto:${email}`);
    if (el.name === 'a') node.attr('href', `mailto:${email}`);
    node.text(email);
  });
  $('img.icon').each((_, el) => {
    if (($(el).attr('src') || '').includes('/lib/images/smileys/')) $(el).replaceWith($('<span>').text($(el).attr('alt') || ''));
  });
  const title = $('h1,h2,h3').first().text().trim() || id.replaceAll('_', ' ');
  $('iframe,video,audio,object,embed').each((_, el) => {
    const node = $(el), href = node.attr('src') || node.attr('data') || node.find('source').attr('src');
    warnings.push({ page: id, kind: 'embed-converted-to-link', url: href });
    if (href) node.replaceWith($('<p>').append($('<a>').attr('href', new URL(href, source).href).text(node.attr('title') || 'Embedded media')));
  });
  $('a[href],img[src],source[src]').each((_, el) => {
    const node = $(el), attr = el.name === 'a' ? 'href' : 'src', href = node.attr(attr);
    const url = new URL(href, source), mid = mediaID(href, source);
    if (mid) {
      const item = media.get(mid);
      if (item?.url) node.attr(attr, item.url);
      else {
        node.attr(attr, url.href);
        if (el.name === 'img') node.replaceWith($('<a>').attr('href', url.href).text(node.attr('alt') || mid));
        warnings.push({ page: id, kind: 'missing-media', target: mid });
      }
    } else if (el.name === 'a') {
      const target = node.attr('data-wiki-id') || pageID(href, source);
      if (href.startsWith('#')) return;
      if (target && slugs.has(target)) node.attr(attr, `/wiki/${slugs.get(target)}${url.hash}`);
      else {
        node.attr(attr, url.href);
        if (target) warnings.push({ page: id, kind: 'missing-page', target });
      }
    } else {
      node.attr(attr, url.href);
      // External images are linked because the destination only renders local images.
      warnings.push({ page: id, kind: 'external-image-linked', url: url.href });
      node.replaceWith($('<a>').attr('href', url.href).text(node.attr('alt') || 'External image'));
    }
  });
  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    if ($(table).find('[colspan],[rowspan]').length) {
      warnings.push({ page: id, kind: 'table-spans-expanded' });
      const grid = [];
      rows.each((r, row) => {
        grid[r] ||= []; let c = 0;
        $(row).children('td,th').each((_, cell) => {
          while (grid[r][c]) c++;
          const node = $(cell), width = Math.min(100, Number(node.attr('colspan')) || 1), height = Math.min(100, Number(node.attr('rowspan')) || 1);
          for (let y = r; y < r + height; y++) {
            grid[y] ||= [];
            for (let x = c; x < c + width; x++) grid[y][x] = node.clone().removeAttr('colspan').removeAttr('rowspan');
          }
          c += width;
        });
      });
      const width = Math.max(...grid.map(row => row.length));
      $(table).empty();
      for (const row of grid) {
        const tr = $('<tr>');
        for (let c = 0; c < width; c++) tr.append(row[c] || '<td></td>');
        $(table).append(tr);
      }
    }
    // GFM requires a header. Keep all data cells by adding an empty header if needed.
    if (!$(table).find('tr').first().find('th').length) {
      const header = $('<tr>');
      $(table).find('tr').first().children('td,th').each(() => header.append('<th></th>'));
      $(table).prepend($('<thead>').append(header));
    }
  });
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  td.addRule('heading-anchor', {
    filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    replacement: (text, node) => {
      const anchor = node.getAttribute('id');
      return `\n\n${'#'.repeat(Number(node.nodeName[1]))} ${text}${anchor && /^[a-zA-Z0-9_:-]+$/.test(anchor) ? ` {#${anchor}}` : ''}\n\n`;
    },
  });
  td.addRule('underline', { filter: ['u'], replacement: text => text });
  td.addRule('line-break-in-table', { filter: 'br', replacement: (_, node) => node.closest('table') ? ' / ' : '  \n' });
  td.addRule('sup-sub', { filter: ['sup', 'sub'], replacement: text => text });
  return { title: title.slice(0, 120), markdown: `${td.turndown($.html()).trim().replace(/^[\t ]+$/gm, '')}\n` };
}

export async function download({ source = 'https://wiki.thelab.ms', out = 'wiki-export', refresh = false, history = true } = {}) {
  source = new URL(source).origin;
  out = resolve(out);
  const errors = [], warnings = [], pages = new Map(), media = new Map(), pageNamespaces = new Set(['']), mediaNamespaces = new Set(['']);
  const manifest = { version: 1, source, started: new Date().toISOString(), history, pages: [], media: [], archives: [], errors, warnings };
  async function get(path, fields) {
    const url = new URL(path, source).href, key = sha256(url + JSON.stringify(fields || null));
    const cache = `${out}/.cache/${key}`;
    if (!refresh) {
      try {
        const metadata = JSON.parse(await readFile(`${cache}.json`, 'utf8'));
        const bytes = await readFile(cache);
        if (sha256(bytes) === metadata.sha256) return { ...metadata, bytes, text: () => bytes.toString('utf8') };
      } catch { /* Download absent or interrupted cache entries. */ }
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(url, {
          method: fields ? 'POST' : 'GET', body: fields ? new URLSearchParams(fields) : undefined,
          headers: { 'User-Agent': 'TheLab-Wiki-Migration/1.0', ...(process.env.DOKUWIKI_COOKIE ? { Cookie: process.env.DOKUWIKI_COOKIE } : {}) },
          signal: AbortSignal.timeout(90000), redirect: 'error',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const metadata = { url, type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream', sha256: sha256(bytes) };
        await atomic(cache, bytes); await atomic(`${cache}.json`, JSON.stringify(metadata));
        return { ...metadata, bytes, text: () => bytes.toString('utf8') };
      } catch (error) {
        if (attempt === 3) throw error;
        await pause(500 * 2 ** attempt);
      }
    }
  }
  const ajax = async (call, fields) => load((await get('/lib/exe/ajax.php', { call, ...fields })).text());
  const capture = async (stage, id, fn) => { try { await fn(); } catch (e) { errors.push({ stage, id, error: e.message }); console.error(stage, id, e.message); } };
  const addPage = id => { if (id && !pages.has(id)) pages.set(id, { id }); };
  const addMedia = id => { if (id && !media.has(id)) media.set(id, { id }); };
  const discover = html => {
    const $ = load(html);
    $('a.wikilink1[data-wiki-id]').each((_, el) => addPage($(el).attr('data-wiki-id')));
    $('a[href],img[src],source[src],video[poster]').each((_, el) => {
      const href = $(el).attr('href') || $(el).attr('src') || $(el).attr('poster');
      const id = mediaID(href, source); if (id) addMedia(id);
    });
  };
  for (const ns of pageNamespaces) await capture('page-index', ns, async () => {
    const $ = await ajax('index', { idx: ns });
    $('a.idx_dir').each((_, el) => pageNamespaces.add(new URL($(el).attr('href'), source).searchParams.get('idx')));
    discover($.html());
  });
  addPage('start'); addPage('sidebar');
  for (const ns of mediaNamespaces) await capture('media-index', ns, async () => {
    const dirs = await ajax('medians', { ns });
    dirs('a.idx_dir').each((_, el) => mediaNamespaces.add(new URL(dirs(el).attr('href'), source).searchParams.get('ns')));
    const $ = await ajax('medialist', { ns });
    if (!$('#media__ns').length) throw new Error('Media listing unavailable');
    discover($.html());
  });
  // Repeat the frontier: content links can expose pages hidden from the sitemap.
  const visited = new Set();
  while ([...pages.keys()].some(id => !visited.has(id))) {
    await pool([...pages.values()].filter(p => !visited.has(p.id)), async page => {
      visited.add(page.id);
      await capture('page', page.id, async () => {
        const path = `/doku.php?${new URLSearchParams({ id: page.id })}`;
        const html = (await get(path)).text();
        if (!load(html)('.docInfo time').length) throw new Error('No existing-page metadata (missing or access denied)');
        page.html = article(html);
        page.updated = load(html)('.docInfo time').attr('datetime');
        page.author = load(html)('.docInfo bdi').last().text();
        page.sourceURL = `${source}/${encodeURIComponent(page.id)}`;
        page.raw = (await get(`/doku.php?${new URLSearchParams({ id: page.id, do: 'export_raw' })}`)).text();
        if (/^\s*<!doctype html/i.test(page.raw)) throw new Error('Raw export returned HTML');
        discover(html);
        page.revisions = [];
        if (history) {
          let offset = '0'; const offsets = new Set();
          while (offset !== null && !offsets.has(offset)) {
            offsets.add(offset);
            const listing = (await get(`/doku.php?${new URLSearchParams({ id: page.id, do: 'revisions', first: offset })}`)).text();
            const $ = load(listing);
            if (!$('#page__revisions').length && !$('#old_revisions').length) throw new Error('Revision listing unavailable');
            $('#page__revisions li').each((_, el) => {
              const rev = $(el).find('input[name="rev2[]"]').val();
              if (rev && !page.revisions.some(r => r.revision === rev)) page.revisions.push({ revision: rev, author: $(el).find('.user').text(), summary: $(el).find('.sum').text() });
            });
            let next = null;
            $('.pagenav a[href]').each((_, el) => {
              const n = new URL($(el).attr('href'), source).searchParams.get('first');
              if (n && Number(n) > Number(offset)) next = n;
            });
            // DokuWiki also uses GET forms for pagination.
            $('.pagenav form').each((_, el) => {
              const n = $(el).find('[name=first]').val();
              if (n && Number(n) > Number(offset)) next = n;
            });
            offset = next;
          }
          await pool(page.revisions, async rev => capture('revision', `${page.id}@${rev.revision}`, async () => {
            const args = { id: page.id, rev: rev.revision };
            rev.raw = (await get(`/doku.php?${new URLSearchParams({ ...args, do: 'export_raw' })}`)).text();
            rev.html = article((await get(`/doku.php?${new URLSearchParams(args)}`)).text());
            discover(rev.html);
          }), 1);
        }
        console.log(`Page ${page.id} (${page.revisions.length} revisions)`);
      });
    });
  }
  await pool([...media.values()], async item => capture('media', item.id, async () => {
    const response = await get(`/_media/${encodeURIComponent(item.id)}`);
    if (response.type === 'text/html') throw new Error('Media returned HTML');
    Object.assign(item, { sha256: response.sha256, type: response.type, size: response.bytes.length, file: `media/${response.sha256}/${filename(item.id)}`, url: fileURL(response.sha256, item.id) });
    await atomic(`${out}/${item.file}`, response.bytes);
    console.log(`Media ${item.id} (${item.size} bytes)`);
  }));
  const slugs = new Map(), owners = new Map();
  for (const id of [...pages.keys()].sort()) {
    let slug = slugFor(id);
    if (owners.has(slug)) slug = `${slug.slice(0, 65)}-${sha256(id).slice(0, 12)}`;
    if (owners.has(slug)) throw new Error(`Slug collision: ${id}`);
    slugs.set(id, slug); owners.set(slug, id);
  }
  async function archive(file, bytes, name, type) {
    await atomic(`${out}/${file}`, bytes);
    const hash = sha256(bytes);
    const entry = { file, sha256: hash, name, type, size: Buffer.byteLength(bytes), url: fileURL(hash, name) };
    manifest.archives.push(entry); return entry;
  }
  for (const page of pages.values()) await capture('convert', page.id, async () => {
    if (!page.html || page.raw === undefined) throw new Error('Page download incomplete');
    const slug = slugs.get(page.id), context = { id: page.id, source, slugs, media, warnings };
    const result = convert(`<!-- wikipage start -->${page.html}<!-- wikipage stop -->`, context);
    const file = `pages/${slug}.md`;
    await atomic(`${out}/${file}`, result.markdown);
    await atomic(`${out}/html/${slug}.html`, page.html);
    const raw = await archive(`raw/${slug}.txt`, page.raw, `${slug}.dokuwiki.txt`, 'text/plain');
    const revisions = [];
    for (const rev of page.revisions || []) {
      if (!rev.html || rev.raw === undefined) continue;
      const converted = convert(`<!-- wikipage start -->${rev.html}<!-- wikipage stop -->`, context);
      await atomic(`${out}/history/${slug}/${rev.revision}.md`, converted.markdown);
      await atomic(`${out}/history/${slug}/${rev.revision}.txt`, rev.raw);
      revisions.push({ ...rev, raw: undefined, html: undefined, markdown: converted.markdown, source: rev.raw });
    }
    const historyFile = revisions.length ? await archive(`history/${slug}.json`, JSON.stringify({ id: page.id, revisions }, null, 2) + '\n', `${slug}-history.json`, 'application/json') : null;
    manifest.pages.push({ id: page.id, slug, title: result.title, file, sha256: sha256(result.markdown), updated: page.updated, author: page.author, sourceURL: page.sourceURL, raw: raw.url, history: historyFile?.url, revisions: revisions.length });
  });
  manifest.pages.sort((a, b) => a.id.localeCompare(b.id));
  manifest.media = [...media.values()].sort((a, b) => a.id.localeCompare(b.id));
  manifest.pageNamespaces = [...pageNamespaces]; manifest.mediaNamespaces = [...mediaNamespaces];
  manifest.finished = new Date().toISOString();
  // Distinct warnings only; revision conversions can repeat the same source defect.
  manifest.warnings = [...new Map(warnings.map(w => [JSON.stringify(w), w])).values()];
  manifest.counts = { pages: manifest.pages.length, media: manifest.media.filter(m => m.file).length, revisions: manifest.pages.reduce((n, p) => n + p.revisions, 0), errors: errors.length, warnings: manifest.warnings.length };
  await atomic(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify(manifest.counts, null, 2));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, refresh: { type: 'boolean' }, 'no-history': { type: 'boolean' } } });
  download({ ...values, history: !values['no-history'] }).then(m => { if (m.errors.length) process.exitCode = 1; }).catch(e => { console.error(e); process.exitCode = 1; });
}
