import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, download, mediaID, pageID, slugFor } from './download-wiki.js';
import { renderMarkdown } from '../src/wiki-markdown.js';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { prepareImport } from './import-wiki.js';

test('converts DokuWiki links, anchors, nested lists, tables, code and original attachments', () => {
  const hash = 'a'.repeat(64), url = `/wiki/files/${hash}/manual.pdf`, warnings = [];
  const html = `<!-- wikipage start --><div id="dw__toc">REMOVE</div>
    <h1 id="the_guide">The guide</h1><p><a data-wiki-id="tools:laser" href="/tools:laser#setup">Laser</a>
    <a href="/_detail/tools:manual.pdf?media=tools:manual.pdf">Manual details</a>
    <a href="/lib/exe/fetch.php?media=tools%3Amanual.pdf">Manual</a></p>
    <ul><li>First<ul><li>Nested</li></ul></li></ul>
    <table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>
    <pre><code>&lt;script&gt;literal&lt;/script&gt;</code></pre>
    <iframe src="https://video.example/watch"></iframe><!-- wikipage stop -->`;
  const result = convert(html, { id: 'guide', source: 'https://wiki.example', slugs: new Map([['tools:laser', 'tools-laser']]), media: new Map([['tools:manual.pdf', { url }]]), warnings });
  assert.match(result.markdown, /\/wiki\/tools-laser#setup/);
  assert.match(result.markdown, /\{#the_guide\}/);
  assert.match(result.markdown, /Nested/);
  assert.match(result.markdown, /https:\/\/video.example\/watch/);
  assert.doesNotMatch(result.markdown, /REMOVE/);
  const rendered = renderMarkdown(result.markdown, 'https://thelab.example');
  assert.match(rendered.html, /<h1 id="the_guide">The guide<\/h1>/);
  assert.match(rendered.html, /<table>/);
  for (const text of ['A', 'B', 'C', 'D']) assert.match(rendered.html, new RegExp(`<td>${text}</td>`));
  assert.deepEqual(rendered.files, [hash]);
  assert.doesNotMatch(rendered.html, /<script>/);
});

test('recognizes original media and namespace IDs without following actions or external sites', () => {
  const source = 'https://wiki.thelab.ms';
  assert.equal(mediaID('/_media/laser%3Amanual.pdf?w=100', source), 'laser:manual.pdf');
  assert.equal(mediaID('https://other.example/_media/a.png', source), null);
  assert.equal(pageID('/doku.php?id=woodshop%3Asafety', source), 'woodshop:safety');
  assert.equal(pageID('/start?do=login', source), null);
  assert.equal(slugFor('woodshop:safety_check'), 'woodshop-safety-check');
  assert.notEqual(slugFor('import'), 'import');
  assert.equal(mediaID('/lib/exe/fetch.php?media=https%3A%2F%2Fexample.com%2Fimage.png', source), null);
});

test('retains merged table meaning and restores Cloudflare-obfuscated addresses', () => {
  const email = 'maker@thelab.ms', key = 42;
  const encoded = Buffer.from([key, ...Buffer.from(email).map(b => b ^ key)]).toString('hex');
  const html = `<!-- wikipage start --><h1>Guide</h1><p><a href="/cdn-cgi/l/email-protection"><span data-cfemail="${encoded}">[email protected]</span></a></p>
    <table><tr><th>Tool</th><th>Setting</th></tr><tr><td rowspan="2">Laser</td><td>Low</td></tr><tr><td>High</td></tr><tr><td colspan="2">Never unattended</td></tr></table><!-- wikipage stop -->`;
  const result = convert(html, { id: 'guide', source: 'https://wiki.example', slugs: new Map(), media: new Map(), warnings: [] });
  const rendered = renderMarkdown(result.markdown, 'https://thelab.example').html;
  assert.match(rendered, /href="mailto:maker@thelab.ms"/);
  assert.equal((rendered.match(/<td>Laser<\/td>/g) || []).length, 2);
  assert.equal((rendered.match(/<td>Never unattended<\/td>/g) || []).length, 2);
  assert.doesNotMatch(rendered, /email-protection/);
});

test('recursively downloads unlinked namespaces/media, paginated history and resumes from cache', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    const url = new URL(req.url, 'http://localhost');
    let body = ''; for await (const chunk of req) body += chunk;
    const fields = new URLSearchParams(body);
    res.setHeader('Content-Type', 'text/html');
    if (url.pathname === '/lib/exe/ajax.php') {
      const call = fields.get('call'), ns = fields.get('idx') || fields.get('ns');
      if (call === 'index') return res.end(ns ? '<a class="wikilink1" data-wiki-id="hidden:orphan" href="/hidden:orphan">Orphan</a>' : '<a class="idx_dir" href="/?idx=hidden">hidden</a>');
      if (call === 'medians') return res.end(ns ? '' : '<a class="idx_dir" href="/?ns=media-only">media-only</a>');
      return res.end('<h1 id="media__ns">media</h1>' + (ns ? '<a href="/_media/media-only:orphan.pdf">Original</a>' : ''));
    }
    if (url.pathname.startsWith('/_media/')) { res.setHeader('Content-Type', 'application/pdf'); return res.end('%PDF-1.4\noriginal'); }
    const id = url.searchParams.get('id'), action = url.searchParams.get('do');
    if (action === 'revisions') {
      const first = url.searchParams.get('first');
      return res.end(`<form id="page__revisions"><li><input name="rev2[]" value="${first === '1' ? '100' : '200'}"><span class="user">Maker</span></li></form>${first === '1' ? '' : '<div class="pagenav"><form><input name="first" value="1"></form></div>'}`);
    }
    if (action === 'export_raw') { res.setHeader('Content-Type', 'text/plain'); return res.end(`====== ${id} ======\nOriginal ${url.searchParams.get('rev') || 'current'}`); }
    res.end(`<!-- wikipage start --><h1 id="title">${id}</h1><p>Content</p><!-- wikipage stop --><div class="docInfo"><time datetime="2025-01-01T00:00:00Z"></time><bdi>Maker</bdi></div>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const out = await mkdtemp(`${tmpdir()}/wiki-migration-`);
  try {
    const source = `http://127.0.0.1:${server.address().port}`;
    const result = await download({ source, out });
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.counts, { pages: 3, media: 1, revisions: 6, errors: 0, warnings: 0 });
    assert.match(await readFile(`${out}/pages/hidden-orphan.md`, 'utf8'), /hidden:orphan/);
    const count = requests;
    await download({ source, out });
    assert.equal(requests, count);
    const plan = await prepareImport(out);
    assert.equal(plan.pages.length, 4);
    assert.ok(plan.pages.find(p => p.slug === 'migration-archive').markdown.includes('orphan.pdf'));
  } finally { server.close(); await rm(out, { recursive: true, force: true }); }
});
