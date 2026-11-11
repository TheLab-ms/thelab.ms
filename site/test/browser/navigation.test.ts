import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../../static/script.js', import.meta.url), 'utf8');

function browser() {
	let focused: object | null = null;
	function element() {
		const classes = new Set<string>();
		const attributes = new Map<string, string>();
		return Object.assign(new EventTarget(), {
			box: { bottom: 72 },
			getBoundingClientRect() {
				return this.box;
			},
			classList: {
				add: (name: string) => classes.add(name),
				contains: (name: string) => classes.has(name),
				toggle(name: string, enabled: boolean) {
					if (enabled) classes.add(name);
					else classes.delete(name);
				},
			},
			setAttribute: (name: string, value: string) => attributes.set(name, value),
			getAttribute: (name: string) => attributes.get(name),
			focus() {
				focused = this;
			},
			contains(target: object) {
				return target === this;
			},
		});
	}
	const toggle = element();
	const links = [element(), element()];
	const menu = Object.assign(element(), { querySelectorAll: () => links });
	const navbar = element();
	const cta = element();
	cta.box.bottom = 400;
	const media = Object.assign(new EventTarget(), { matches: true });
	const document = Object.assign(new EventTarget(), {
		body: { style: { overflow: '' } },
		activeElement: focused,
		getElementById: (id: string) => ({ navbar, 'nav-toggle': toggle, 'nav-menu': menu })[id],
		querySelector: () => cta,
		querySelectorAll: (selector: string) => (selector === '.nav-link' ? links : []),
	});
	Object.defineProperty(document, 'activeElement', { get: () => focused });
	const window = Object.assign(new EventTarget(), { scrollY: 0, matchMedia: () => media });
	vm.runInNewContext(script, { document, window });
	return {
		document,
		toggle,
		links,
		menu,
		media,
		window,
		navbar,
		cta,
		key(key: string, shiftKey = false) {
			const event = Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
			document.dispatchEvent(event);
			return event;
		},
	};
}

test('mobile menu opens, closes on Escape, and returns focus to its toggle', () => {
	const b = browser();
	b.toggle.dispatchEvent(new Event('click'));
	assert.equal(b.toggle.getAttribute('aria-expanded'), 'true');
	assert.equal(b.document.body.style.overflow, 'hidden');
	b.key('Escape');
	assert.equal(b.toggle.getAttribute('aria-expanded'), 'false');
	assert.equal(b.document.body.style.overflow, '');
	assert.equal(b.document.activeElement, b.toggle);
});

test('open mobile menu cycles keyboard focus and closes after choosing a destination', () => {
	const b = browser();
	b.toggle.dispatchEvent(new Event('click'));
	b.toggle.focus();
	assert.equal(b.key('Tab', true).defaultPrevented, true);
	assert.equal(b.document.activeElement, b.links.at(-1));
	assert.equal(b.key('Tab').defaultPrevented, true);
	assert.equal(b.document.activeElement, b.toggle);
	b.links[0]?.dispatchEvent(new Event('click'));
	assert.equal(b.menu.classList.contains('active'), false);
	assert.equal(b.document.body.style.overflow, '');
});

test('switching to desktop releases the open menu scroll lock', () => {
	const b = browser();
	b.toggle.dispatchEvent(new Event('click'));
	b.media.matches = false;
	b.media.dispatchEvent(new Event('change'));
	assert.equal(b.toggle.getAttribute('aria-expanded'), 'false');
	assert.equal(b.document.body.style.overflow, '');
});

test('navbar wordmark appears only after the hero content passes the navbar', () => {
	const b = browser();
	assert.equal(b.navbar.classList.contains('scrolled'), false);
	b.window.scrollY = 100;
	b.window.dispatchEvent(new Event('scroll'));
	assert.equal(b.navbar.classList.contains('scrolled'), false);
	b.cta.box.bottom = 72;
	b.window.dispatchEvent(new Event('scroll'));
	assert.equal(b.navbar.classList.contains('scrolled'), true);
	b.cta.box.bottom = 300;
	b.window.dispatchEvent(new Event('resize'));
	assert.equal(b.navbar.classList.contains('scrolled'), false);
});
