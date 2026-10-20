// Tiny server-only JSX renderer. Use HTML attribute names (class, for, etc.).
// The JSX namespace below limits markup to known tags and attributes.
export type Child = VNode | string | number | boolean | null | undefined | readonly Child[];
type Value = string | number | boolean | null | undefined;
type Attributes = Readonly<Record<string, Value>>;

export interface VNode {
  readonly tag: string;
  readonly props: Attributes | null;
  readonly children: readonly Child[];
}

const escapeHTML = (value: string | number | true): string =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const isList = (node: Child): node is readonly Child[] => Array.isArray(node);

export const Fragment = ({ children }: { children?: Child }): Child => children;

export function h(tag: string | ((props: { children: readonly Child[] }) => Child), props: Attributes | null, ...children: Child[]): Child {
  return typeof tag === 'function' ? tag({ ...props, children }) : { tag, props, children };
}

export function render(node: Child): string {
  if (node == null || typeof node === 'boolean') return '';
  if (isList(node)) return node.map(render).join('');
  if (typeof node !== 'object') return escapeHTML(node);

  const { tag, props, children } = node;
  const attributes = Object.entries(props ?? {}).map(([name, value]) => {
    if (value == null) return '';
    if (name.startsWith('aria-') || name.startsWith('data-')) return ` ${name}="${escapeHTML(String(value))}"`;
    if (value === false) return '';
    return value === true ? ` ${name}` : ` ${name}="${escapeHTML(value)}"`;
  }).join('');
  return `<${tag}${attributes}>${voidTags.has(tag) ? '' : `${render(children)}</${tag}>`}`;
}

type Optional<T> = T | null | undefined;
type Numeric = number | `${number}`;

interface GlobalAttributes {
  children?: Child;
  class?: Optional<string>;
  id?: Optional<string>;
  title?: Optional<string>;
  role?: Optional<'alert' | 'region' | 'search' | 'status'>;
  tabindex?: Optional<Numeric>;
  hidden?: Optional<boolean>;
  [aria: `aria-${string}`]: Value;
  [data: `data-${string}`]: Value;
}

interface Elements {
  a: { href?: Optional<string>; target?: Optional<'_blank'>; rel?: Optional<string> };
  button: { type: 'submit' | 'button'; form?: Optional<string>; formaction?: Optional<string>; disabled?: Optional<boolean> };
  details: { open?: Optional<boolean> };
  form: { method: 'get' | 'post'; action: string };
  html: { lang: string };
  img: { src: string; alt: string; width?: Numeric; height?: Numeric };
  input: {
    type?: 'checkbox' | 'email' | 'hidden' | 'search' | 'text' | 'url'; name?: string; value?: Optional<string | number>;
    maxlength?: Optional<Numeric>; placeholder?: string; checked?: boolean; readonly?: boolean; disabled?: boolean;
  };
  label: { for: string };
  link: { rel: 'icon' | 'stylesheet'; href: string };
  meta: { charset: 'utf-8' } | { name: string; content: string };
  option: { value: string; selected?: boolean };
  script: { src: string; defer?: boolean };
  select: { name: string; disabled?: boolean };
  td: { colspan?: Numeric };
  textarea: { name: string; maxlength?: Numeric; rows?: Numeric };
  th: { scope?: 'col' | 'row' };
}

type PlainTag = 'aside' | 'body' | 'dd' | 'div' | 'dl' | 'dt' | 'h1' | 'h2' | 'head' | 'header' | 'main' | 'nav' | 'noscript'
  | 'p' | 'section' | 'small' | 'span' | 'strong' | 'summary' | 'table' | 'tbody' | 'thead' | 'title' | 'tr';

export declare namespace h.JSX {
  type Element = Child;
  interface ElementChildrenAttribute { children: unknown }
  type IntrinsicElements = { [Tag in keyof Elements]: GlobalAttributes & Elements[Tag] } & { [Tag in PlainTag]: GlobalAttributes };
}
