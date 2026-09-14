import MarkdownIt from 'markdown-it';
import { escapeHTML, HttpError } from './http.js';

export const MAX_MARKDOWN = 128 * 1024;
export const MAX_IMAGE = 5 * 1024 * 1024;
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const IMAGE_PATH = /^\/wiki\/images\/([a-f0-9]{64})$/;

export function validSlug(slug) {
  return typeof slug === 'string' && slug.length <= 80 && SLUG.test(slug)
    && !['new', 'images', 'preview'].includes(slug);
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
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index], id = imageID(token.attrGet('src'), site);
    if (!id) return escapeHTML(token.content || 'Unsupported image');
    images.add(id);
    token.attrSet('src', `/wiki/images/${id}`);
    token.attrSet('loading', 'lazy');
    return image(tokens, index, options, env, renderer);
  };
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index], id = imageID(token.attrGet('href'), site);
    if (id) {
      images.add(id);
      token.attrSet('href', `/wiki/images/${id}`);
    }
    token.attrSet('rel', 'nofollow noopener');
    return renderer.renderToken(tokens, index, options);
  };
  const html = md.render(markdown);
  return { html, images: [...images] };
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
