// Tiny server-only JSX renderer. Use HTML attribute names (class, for, etc.).
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

export const Fragment = ({ children }) => children;

export function h(tag, props, ...children) {
  return typeof tag === 'function' ? tag({ ...props, children }) : { tag, props, children };
}

export function render(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node !== 'object') return escapeHTML(node);

  const { tag, props, children } = node;
  const attributes = Object.entries(props ?? {}).map(([name, value]) => {
    if (value == null) return '';
    if (name.startsWith('aria-') || name.startsWith('data-')) return ` ${name}="${escapeHTML(value)}"`;
    if (value === false) return '';
    return value === true ? ` ${name}` : ` ${name}="${escapeHTML(value)}"`;
  }).join('');
  return `<${tag}${attributes}>${voidTags.has(tag) ? '' : `${render(children)}</${tag}>`}`;
}
