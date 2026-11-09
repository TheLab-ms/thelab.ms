import { describe, expect, it } from 'vitest';
import { render } from '../src/html.ts';
import { markdown } from '../src/markdown.ts';

const html = (source: string) => render(markdown(source));

describe('Event description Markdown', () => {
	it('supports headings, emphasis, paragraphs, and existing plain-text line breaks', () => {
		expect(html('# Bring a project\n\n**Bold** and *italic*\nNext line\n\nAnother paragraph.')).toBe(
			'<h2>Bring a project</h2><p><strong>Bold</strong> and <em>italic</em><br>Next line</p><p>Another paragraph.</p>',
		);
		expect(html('')).toBe('');
		expect(html('A & B')).toBe('<p>A &amp; B</p>');
		expect(html('\\*not italic\\*')).toBe('<p>*not italic*</p>');
	});

	it('supports ordered and nested unordered lists, quotes, and separators', () => {
		expect(html('- Tools\n  - Drill\n- Materials')).toBe(
			'<ul><li>Tools<ul><li>Drill</li></ul></li><li>Materials</li></ul>',
		);
		expect(html('3. First\n4. Second')).toBe('<ol start="3"><li>First</li><li>Second</li></ol>');
		expect(html('> Bring **tools**\n\n---')).toBe(
			'<blockquote><p>Bring <strong>tools</strong></p></blockquote><hr>',
		);
	});

	it('renders inline and fenced code as escaped text without Markdown formatting', () => {
		expect(html('Use `<script>`')).toBe('<p>Use <code>&lt;script&gt;</code></p>');
		expect(html('```html\n<script>alert(1)</script>\n**literal**\n```')).toBe(
			'<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n**literal**</code></pre>',
		);
	});

	it('supports safe links, references, and escaped link titles', () => {
		expect(html('[TheLab](https://thelab.ms "Our makerspace")')).toBe(
			'<p><a href="https://thelab.ms" title="Our makerspace">TheLab</a></p>',
		);
		for (const href of [
			'http://example.com',
			'mailto:leadership@thelab.ms',
			'/events',
			'./next',
			'../events',
			'#details',
		]) {
			expect(html(`[link](${href})`)).toContain(`href="${href}"`);
		}
		expect(html('[TheLab][lab]\n\n[lab]: https://thelab.ms')).toBe('<p><a href="https://thelab.ms">TheLab</a></p>');
		expect(html('[link](https://example.com "&quot; onclick=&quot;alert(1)")')).not.toContain(' onclick="');
	});

	it('does not render unsafe links, raw HTML, or remote images', () => {
		for (const href of [
			'javascript:alert(1)',
			'JAVASCRIPT:alert(1)',
			'data:text/html,evil',
			'vbscript:evil',
			'javascript&#58;alert(1)',
			'java&#x73;cript:alert(1)',
		]) {
			expect(html(`[**link**](${href})`)).toBe('<p><strong>link</strong></p>');
		}
		expect(html('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
		const output = html('<img src=x onerror=alert(1)>\n\n![photo](https://tracker.example/pixel)');
		expect(output).not.toContain('<img');
		expect(output).not.toContain('href=');
		expect(output).toContain('&lt;img src=x onerror=alert(1)&gt;');
		expect(output).toContain('<p>photo</p>');
	});
});
