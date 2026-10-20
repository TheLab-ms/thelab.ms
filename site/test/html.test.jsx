import { describe, expect, it } from 'vitest';
import { h, Fragment, render } from '../src/html.js';
import { page } from '../src/page.jsx';

describe('HTML rendering', () => {
  it('escapes text and attribute values without escaping nested markup', () => {
    const value = `"><script>alert('x')</script>&`;
    const escaped = '&quot;&gt;&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;&amp;';
    expect(render(<div title={value}>{value}<span>{value}</span></div>))
      .toBe(`<div title="${escaped}">${escaped}<span>${escaped}</span></div>`);
    expect(render(<p>Fish &amp; Chips</p>)).toBe('<p>Fish &amp; Chips</p>');
  });

  it('renders fragments, nested arrays, and zero while omitting empty and boolean children', () => {
    expect(render(<>{null}{undefined}{false}{true}{0}{['a', [<span>b</span>, false]]}</>))
      .toBe('0a<span>b</span>');
  });

  it('composes function components with props and children', () => {
    const Label = ({ prefix, children }) => <label class="label">{prefix}{children}</label>;
    expect(render(<Label prefix="<name>"><strong>{'A&B'}</strong></Label>))
      .toBe('<label class="label">&lt;name&gt;<strong>A&amp;B</strong></label>');
  });

  it('uses HTML attribute names and handles boolean and optional form attributes', () => {
    expect(render(<label class="field" for="name"><input id="name" checked disabled={false} readonly value="" maxlength={0} title={null} aria-describedby={undefined} /></label>))
      .toBe('<label class="field" for="name"><input id="name" checked readonly value="" maxlength="0"></label>');
    expect(render(<select><option value="a" selected>A</option><option value="b" selected={false}>B</option></select>))
      .toBe('<select><option value="a" selected>A</option><option value="b">B</option></select>');
  });

  it('keeps boolean ARIA and data values as strings', () => {
    expect(render(<details open={false} aria-expanded={false} data-enabled={true} data-hidden={false} />))
      .toBe('<details aria-expanded="false" data-enabled="true" data-hidden="false"></details>');
  });

  it('omits closing tags only for void elements', () => {
    expect(render(<><meta charset="utf-8" /><img src="/icon.svg" alt="" /><br /><form /><script src="/admin.js" defer /></>))
      .toBe('<meta charset="utf-8"><img src="/icon.svg" alt=""><br><form></form><script src="/admin.js" defer></script>');
  });
});

describe('Page layout', () => {
  it('preserves response status and security headers, and escapes titles and plain string bodies', async () => {
    const response = page('<Maker & Co>', '<p>Not markup</p>', { status: 409 });
    expect(response.status).toBe(409);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html><html lang="en">/);
    expect(html).toContain('<title>&lt;Maker &amp; Co&gt; | TheLab</title>');
    expect(html).toContain('<section class="card membership-message"><h1>&lt;Maker &amp; Co&gt;</h1>&lt;p&gt;Not markup&lt;/p&gt;</section>');
    expect(html).not.toContain('/admin.js');
    expect(html).not.toContain('admin-header');
  });

  it('renders the admin layout and nested JSX body', async () => {
    const html = await page('Members', <p>{'<Maker>'}</p>, { admin: true }).text();
    expect(html).toContain('<script src="/admin.js" defer></script>');
    expect(html).toContain('<body class="membership-page admin-page"><main class="container membership-main admin-main">');
    expect(html).toContain('<nav aria-label="Admin navigation"><a href="/admin">Members</a><a href="/admin/events">Events</a></nav>');
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain('<h1>Members</h1><p>&lt;Maker&gt;</p>');
  });
});
