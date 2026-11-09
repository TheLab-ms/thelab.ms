import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('../../static/calendar.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
class FakeNode extends EventTarget {
  readonly tag: string;
  children: FakeNode[] = [];
  textContent = '';
  className = '';
  href = '';
  disabled = false;
  attributes: Record<string, string> = {};
  constructor(tag: string) { super(); this.tag = tag; }
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  all(tag: string): FakeNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.all(tag)]); }
}
interface CalendarEvent { url: string; title: string; start: string; end: string; date: string; summary: string; cancelled: boolean }
const event: CalendarEvent = { url: '/events/abc/0', title: '<img src=x onerror=alert(1)>', start: '2027-03-15T00:00:00Z', end: '2027-03-15T02:00:00Z', date: '2027-03-14', summary: '3 of 5 spots left · Active members only', cancelled: false };
function browser() {
  const nodes = Object.fromEntries(['event-calendar', 'calendar-month', 'calendar-status', 'calendar-grid', 'calendar-agenda', 'calendar-prev', 'calendar-next'].map(id => [id, new FakeNode('div')])) as Record<string, FakeNode>;
  const document = { getElementById: (id: string) => nodes[id], createElement: (tag: string) => new FakeNode(tag) };
  const requests: { url: string; init: RequestInit; resolve: (response: Response) => void; reject: (error: Error) => void }[] = [];
  class Clock extends Date {
    constructor(...args: [] | [string | number]) { super(args.length ? args[0] : '2027-03-01T01:00:00Z'); }
  }
  vm.runInNewContext(script, { document, Date: Clock, Intl, fetch: (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => requests.push({ url, init, resolve, reject })) });
  const get = (id: string) => nodes[`calendar-${id}`]!;
  return { nodes, requests, get, click(id: string) { get(id).dispatchEvent(new Event('click')); },
    async reply(events: CalendarEvent[] = [event], index = requests.length - 1) { requests[index]!.resolve(Response.json({ events })); await settle(); } };
}

test('uses the Chicago month at midnight boundaries and renders text safely', async () => {
  const b = browser();
  // March 1 UTC is still February 28 at TheLab.
  assert.equal(b.requests[0]!.url, '/events/data?month=2027-02');
  assert.equal(b.requests[0]!.init.credentials, 'omit');
  await b.reply([]);
  b.click('next');
  await b.reply();
  assert.equal(b.get('month').textContent, 'March 2027');
  assert.equal(b.get('agenda').all('strong')[0]!.textContent, event.title);
  assert.equal(b.get('agenda').all('img').length, 0);
  assert.match(b.get('agenda').all('span')[0]!.textContent, /Mar 14.*7:00 PM.*9:00 PM/);
  assert.equal(b.get('agenda').all('a')[0]!.href, event.url);
  const cell = b.get('grid').children.find(node => node.className.includes('calendar-day') && node.children[0]?.textContent === '14')!;
  assert.equal(cell.all('a')[0]!.href, event.url);
});

test('ignores stale responses when navigating quickly', async () => {
  const b = browser();
  b.click('next');
  await b.reply();
  await b.reply([], 0);
  assert.equal(b.get('month').textContent, 'March 2027');
  assert.equal(b.get('agenda').all('a').length, 1);
  assert.equal(b.nodes['event-calendar']!.attributes['aria-busy'], 'false');
});

test('shows empty and failed states and can recover', async () => {
  const b = browser();
  b.requests[0]!.resolve(new Response('Unavailable', { status: 503 }));
  await settle();
  assert.match(b.get('status').textContent, /couldn’t be loaded/);
  b.click('next');
  await b.reply([]);
  assert.match(b.get('status').textContent, /No events scheduled/);
  b.click('next');
  await b.reply();
  assert.equal(b.get('status').textContent, '');
});

test('renders a multi-day event on each occupied day, excluding its midnight end', async () => {
  const b = browser();
  await b.reply([]);
  b.click('next');
  await b.reply([{ ...event, start: '2027-03-14T04:00:00Z', date: '2027-03-13', end: '2027-03-15T05:00:00Z', cancelled: true }]);
  const occupied = b.get('grid').children.filter(node => node.all('a').length).map(node => node.children[0]!.textContent);
  assert.deepEqual(occupied, ['13', '14']);
  assert.equal(b.get('agenda').all('a').length, 1);
  assert.match(b.get('agenda').all('a')[0]!.className, /cancelled/);
});
