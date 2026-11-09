import { Lexer, type MarkedToken, type Token } from 'marked';
import { h, type Child } from './html.ts';

function safeHref(value: string): string | null {
	const href = value.trim();
	// Support web/email links and explicit relative paths. Never allow scripts,
	// data URLs, control characters, or browser-specific backslash normalization.
	if (!/^(https?:\/\/|mailto:|[/.#])/i.test(href) || /[\u0000-\u001f\u007f\\]/.test(href)) return null;
	try {
		const url = new URL(href, 'https://markdown.invalid');
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
	} catch { return null; }
}

function nodes(tokens: readonly Token[]): Child {
	return tokens.map((value): Child => {
		// This standalone lexer has no extensions, so it emits only built-in tokens.
		const token = value as MarkedToken;
		switch (token.type) {
			case 'space': case 'def': return null;
			case 'heading': return h(`h${Math.min(6, token.depth + 1)}`, null, nodes(token.tokens));
			case 'paragraph': return h('p', null, nodes(token.tokens));
			case 'strong': case 'em': case 'del': return h(token.type, null, nodes(token.tokens));
			case 'blockquote': return h('blockquote', null, nodes(token.tokens));
			case 'list': return h(token.ordered ? 'ol' : 'ul', token.ordered ? { start: token.start } : null,
				...token.items.map(item => h('li', null, nodes(item.tokens))));
			case 'list_item': return h('li', null, nodes(token.tokens));
			case 'code': return h('pre', null, h('code', null, token.text));
			case 'codespan': return h('code', null, token.text);
			case 'br': case 'hr': return h(token.type, null);
			case 'link': {
				const href = safeHref(token.href), label = nodes(token.tokens);
				return href ? h('a', { href, title: token.title }, label) : label;
			}
			case 'image': return token.text; // No remote images or tracking requests.
			case 'html': return token.block ? h('p', null, token.text) : token.text;
			case 'escape': return token.text;
			case 'text': return token.tokens ? nodes(token.tokens)
				: token.text.split('\n').map((line, i) => [i ? h('br', null) : null, line]);
			default: return token.raw;
		}
	});
}

// Build normal JSX nodes instead of trusting generated HTML. The shared renderer
// escapes every text node and attribute, including literal HTML in Markdown.
export function markdown(source: string): Child {
	return nodes(Lexer.lex(source, { gfm: false }));
}
