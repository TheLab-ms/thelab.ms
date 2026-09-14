import MarkdownIt from 'markdown-it';
import { escapeHTML, HttpError } from './http.js';

export const MAX_MARKDOWN = 128 * 1024;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IMAGE_PATH = /^\/wiki\/images\/([a-f0-9]{64})$/;
export const FILE_PATH = /^\/wiki\/files\/([a-f0-9]{64})\/([a-zA-Z0-9._-]{1,120})$/;

export function validSlug(slug) {
  return typeof slug === 'string' && slug.length <= 80 && SLUG.test(slug)
    && !['new', 'images', 'files', 'preview', 'import'].includes(slug);
}

export function imageID(value, site) {
  try {
    const url = new URL(value, `${site}/wiki/`);
    return url.origin === site ? decodeURIComponent(url.pathname).match(IMAGE_PATH)?.[1] : undefined;
  } catch { return undefined; }
}

// Both preview and publication use this renderer. HTML is text, never markup;
// markdown-it's URL validation rejects javascript:, data:, and other unsafe links.
export function renderMarkdown(markdown, site) {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const images = new Set();
  const files = new Set();
  function importedFile(value) {
    try {
      const url = new URL(value, `${site}/wiki/`), match = decodeURIComponent(url.pathname).match(FILE_PATH);
      if (url.origin === site && match) { files.add(match[1]); return url.pathname; }
    } catch { /* Invalid URL. */ }
  }
  // Explicit IDs retain incoming DokuWiki section links without allowing HTML.
  md.core.ruler.push('heading_ids', state => {
    for (let i = 0; i < state.tokens.length; i++) {
      if (state.tokens[i].type !== 'heading_open') continue;
      const inline = state.tokens[i + 1], last = inline.children?.at(-1);
      const match = last?.type === 'text' && last.content.match(/\s+\{#([a-zA-Z0-9_:-]+)\}$/);
      if (match) {
        state.tokens[i].attrSet('id', match[1]);
        last.content = last.content.slice(0, -match[0].length);
      }
    }
  });
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index], id = imageID(token.attrGet('src'), site);
    const file = importedFile(token.attrGet('src'));
    if (!id && !file) return escapeHTML(token.content || 'Unsupported image');
    if (id) images.add(id);
    token.attrSet('src', file || `/wiki/images/${id}`);
    token.attrSet('loading', 'lazy');
    return image(tokens, index, options, env, renderer);
  };
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index], id = imageID(token.attrGet('href'), site);
    const file = importedFile(token.attrGet('href'));
    if (file) token.attrSet('href', file);
    if (id) {
      images.add(id);
      token.attrSet('href', `/wiki/images/${id}`);
    }
    token.attrSet('rel', 'nofollow noopener');
    return renderer.renderToken(tokens, index, options);
  };
  const html = md.render(markdown);
  return { html, images: [...images], files: [...files] };
}

export function validatePage(input) {
  if (!validSlug(input.slug)) throw new HttpError(400, 'Use a page address of up to 80 lowercase letters, numbers, and single hyphens.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 120) throw new HttpError(400, 'Enter a title of up to 120 characters.');
  if (typeof input.markdown !== 'string' || new TextEncoder().encode(input.markdown).length > MAX_MARKDOWN) throw new HttpError(413, 'Markdown must be 128 KiB or smaller.');
  if (typeof input.revision !== 'string' || (input.revision !== '' && !/^[a-f0-9]{64}$/.test(input.revision))) throw new HttpError(400, 'Invalid page revision.');
}

export function imageType(bytes) {
  const starts = values => values.every((value, index) => bytes[index] === value);
  const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (!bytes.length || bytes.length > MAX_IMAGE) throw new HttpError(413, 'Images must be between 1 byte and 5 MiB.');
  if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && text(12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 12 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) return 'image/gif';
  if (bytes.length >= 20 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(text(12, 16))) return 'image/webp';
  throw new HttpError(415, 'Upload a JPEG, PNG, WebP, or GIF image.');
}
