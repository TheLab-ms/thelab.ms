import { escapeHTML as e } from './http.js';

export function wikiPage(title, content, { editor = false, status = 200 } = {}) {
	return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} | TheLab wiki</title>${editor ? '<meta name="robots" content="noindex">' : ''}<link rel="icon" href="/assets/favicon.svg"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&amp;family=Source+Code+Pro:wght@400;500;600;700&amp;display=swap" rel="stylesheet"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/membership.css"><link rel="stylesheet" href="/wiki.css">${editor ? '<script src="/wiki-editor.js" defer></script>' : ''}</head><body class="membership-page"><main class="container membership-main wiki-main"><header class="wiki-header"><a class="membership-brand" href="/"><img src="/assets/favicon.svg" alt="" width="40" height="40">TheLab</a><nav aria-label="Wiki navigation"><a href="/wiki">Index</a><a href="/wiki/new">New page</a><a href="/">Home</a></nav></header>${content}<footer class="wiki-footer">TheLab community wiki</footer></main></body></html>`, {
		status,
		headers: {
			'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		},
	});
}

export function wikiIndex(pages) {
	return wikiPage('Community wiki', `<div class="wiki-heading"><div><p class="wiki-eyebrow">Made by members</p><h1 class="section-title">Community wiki</h1><div class="section-line"></div><p>Guides, projects, and shared knowledge from around the space.</p></div><a class="btn btn-primary" href="/wiki/new">Create a page</a></div><section class="wiki-page-list" aria-label="Wiki pages">${pages.length ? pages.map(page => `<a class="wiki-page-card" href="/wiki/${e(page.slug)}"><h2>${e(page.title)}</h2><p>Updated <time datetime="${e(page.updated)}">${e(page.updated.slice(0, 10))}</time></p><span aria-hidden="true">Read page →</span></a>`).join('') : '<div class="wiki-panel"><h2>A little knowledge goes a long way.</h2><p>No pages yet. Members can create the first guide.</p></div>'}</section>`);
}

export function wikiArticle(page, html) {
	return wikiPage(page.title, `<div class="wiki-heading"><div><p class="wiki-eyebrow"><a href="/wiki">Community wiki</a></p><h1 class="section-title">${e(page.title)}</h1><p class="wiki-help">Updated <time datetime="${e(page.updated)}">${e(page.updated.replace('T', ' ').slice(0, 16))} UTC</time></p></div><a class="btn btn-outline" href="/wiki/${e(page.slug)}/edit">Edit page</a></div><article class="wiki-panel wiki-content">${html || '<p>This page is empty.</p>'}</article>`);
}

export function wikiEditor(page, markdown, csrf, slug = '') {
	const exists = Boolean(page);
	return wikiPage(exists ? `Edit ${page.title}` : 'Create a page', `<h1 class="section-title">${exists ? 'Edit page' : 'Create a page'}</h1><p class="wiki-help">Share what you know. Markdown supports headings, lists, links, tables, and code blocks.</p>
    <form id="wiki-editor" class="wiki-panel wiki-editor" data-csrf="${e(csrf)}" data-revision="${e(page?.revision || '')}">
      <label for="wiki-title">Page title</label><input id="wiki-title" name="title" value="${e(page?.title || '')}" maxlength="120" required>
      <label for="wiki-slug">Page address</label><div class="wiki-address"><span>/wiki/</span><input id="wiki-slug" name="slug" value="${e(page?.slug || slug)}" maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" required${exists || slug ? ' readonly' : ''}></div><p class="wiki-help">Lowercase letters, numbers, and hyphens. The address stays the same after publication.</p>
      <div class="wiki-toolbar" role="group" aria-label="Markdown formatting"><button type="button" data-format="heading">Heading</button><button type="button" data-format="bold">Bold</button><button type="button" data-format="italic">Italic</button><button type="button" data-format="link">Link</button><button type="button" data-format="list">List</button><button type="button" data-format="code">Code</button><button type="button" id="wiki-upload-button">Upload image</button><input type="file" id="wiki-image" accept="image/jpeg,image/png,image/webp,image/gif" hidden></div>
      <p class="wiki-help">Images: JPEG, PNG, WebP, or GIF, up to 5 MiB. Uploads unused for 24 hours are deleted automatically.</p>
      <label for="wiki-markdown">Markdown</label><textarea id="wiki-markdown" name="markdown" rows="22" spellcheck="true" aria-describedby="wiki-markdown-help">${e(markdown)}</textarea><p class="wiki-help" id="wiki-markdown-help">Link to other pages with <code>[Page name](/wiki/page-address)</code>. HTML is displayed as text. Only uploaded wiki images are displayed.</p>
      <div class="wiki-actions"><button type="submit" class="btn btn-primary" id="wiki-save">Save page</button><button type="button" class="btn btn-outline" id="wiki-preview-button" aria-expanded="false" aria-controls="wiki-preview">Preview</button><a class="btn btn-outline" href="${exists ? `/wiki/${e(page.slug)}` : '/wiki'}">Cancel</a>${exists ? '<button type="button" class="wiki-delete" id="wiki-delete">Delete page</button>' : ''}</div>
      <p id="wiki-status" role="status" aria-live="polite"></p><p id="wiki-login-help" hidden>Your editor text is preserved. <a href="${exists ? `/wiki/${e(page.slug)}/edit` : '/wiki/new'}" target="_blank" rel="noopener">Sign in in another tab</a>, then reload this editor after copying your draft.</p>${exists ? `<p class="wiki-help"><a href="/wiki/${e(page.slug)}" target="_blank" rel="noopener">Open the current published page in another tab</a></p>` : ''}
    </form><section id="wiki-preview" class="wiki-panel" hidden><h2>Preview</h2><div id="wiki-preview-content" class="wiki-content"></div></section>`, { editor: true });
}
