import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('../static/machines.js', import.meta.url), 'utf8');
const card = { Name: '<script>Maker</script>', Status: 'Printing', Remaining: '2h 5m', Updated: 'Now', Image: '/machines/images/camera.jpg', Unavailable: false };
const data = (token = 'short-lived-token') => Response.json({ cards: [card], edge: 'https://edge.example', token });
const jpeg = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });

class Node extends EventTarget {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.hidden = false; this.textContent = ''; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  removeAttribute(name) { delete this[name]; }
  querySelectorAll(tag) { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
}

function browser() {
  const nodes = Object.fromEntries(['printers', 'refresh-status', 'access-help'].map(id => [id, new Node('div')]));
  nodes['access-help'].hidden = true;
  const document = Object.assign(new EventTarget(), { hidden: false, getElementById: id => nodes[id], createElement: tag => new Node(tag) });
  const window = new EventTarget(), intervals = [], requests = [], revoked = [], created = [], timeouts = new Map();
  let respond = async url => url === '/machines/data' ? data() : jpeg();
  class BrowserURL extends URL {
    static createObjectURL(blob) { const url = `blob:test-${created.length}`; created.push({ url, blob }); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const context = {
    document, window, URL: BrowserURL, Date, AbortController,
    fetch: async (...args) => { requests.push(args); return respond(...args); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    setTimeout(fn, ms) { const id = {}; timeouts.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  vm.runInNewContext(script, context);
  return { nodes, document, window, intervals, requests, revoked, created, timeouts,
    respond(fn) { respond = fn; }, refresh: () => intervals[0].fn(),
    settle: () => new Promise(resolve => setImmediate(resolve)) };
}

test('loads frames directly from edge with scoped tokens and no cookies; renders untrusted names as text', async () => {
  const b = browser();
  await b.settle();
  assert.equal(b.intervals[0].ms, 5000);
  assert.equal(b.requests.length, 2);
  assert.equal(b.requests[0][0], '/machines/data');
  assert.equal(b.requests[0][1].credentials, 'same-origin');
  const [url, init] = b.requests[1];
  assert.equal(String(url), 'https://edge.example/machines/images/camera.jpg');
  assert.equal(init.headers.Authorization, 'Bearer short-lived-token');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.mode, 'cors');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.equal(b.nodes.printers.querySelectorAll('h2')[0].textContent, card.Name);
  assert.equal(b.nodes.printers.querySelectorAll('script').length, 0);
  const image = b.nodes.printers.querySelectorAll('img')[0];
  assert.equal(image.src, 'blob:test-0');
  assert.equal(image.hidden, true);
  image.dispatchEvent(new Event('load'));
  assert.equal(image.hidden, false);
  image.dispatchEvent(new Event('error'));
  assert.equal(image.hidden, true);
});

test('renews authorization on each refresh and revokes old blob URLs', async () => {
  const b = browser();
  await b.settle();
  b.respond(async url => url === '/machines/data' ? data('renewed-token') : jpeg());
  await b.refresh();
  assert.equal(b.requests[3][1].headers.Authorization, 'Bearer renewed-token');
  assert.deepEqual(b.revoked, ['blob:test-0']);
  assert.equal(b.nodes.printers.querySelectorAll('img')[0].src, 'blob:test-1');
});

for (const source of ['worker', 'edge']) {
  for (const status of [401, 403]) {
    test(`clears images and stops polling after ${source} denies access (${status})`, async () => {
      const b = browser();
      await b.settle();
      b.respond(async url => (url === '/machines/data') === (source === 'worker') ? new Response(null, { status }) : data());
      await b.refresh();
      assert.equal(b.nodes.printers.children.length, 0);
      assert.equal(b.nodes['access-help'].hidden, false);
      assert.match(b.nodes['refresh-status'].textContent, /access ended/);
      assert.ok(b.revoked.includes('blob:test-0'));
      const requests = b.requests.length;
      await b.refresh();
      b.document.dispatchEvent(new Event('visibilitychange'));
      assert.equal(b.requests.length, requests);
    });
  }
}

test('hides stale frames during outages and recovers on the next refresh', async () => {
  const b = browser();
  await b.settle();
  const image = b.nodes.printers.querySelectorAll('img')[0];
  image.dispatchEvent(new Event('load'));
  b.respond(async () => { throw new Error('offline'); });
  await b.refresh();
  assert.equal(image.hidden, true);
  assert.equal(image.src, undefined);
  assert.match(b.nodes['refresh-status'].textContent, /out of date/);
  b.respond(async url => url === '/machines/data' ? data() : new Response(null, { status: 502 }));
  await b.refresh();
  assert.match(b.nodes['refresh-status'].textContent, /Updated/);
  assert.equal(b.nodes.printers.querySelectorAll('img')[0].src, undefined);
  b.respond(async url => url === '/machines/data' ? data() : jpeg());
  await b.refresh();
  assert.match(b.nodes.printers.querySelectorAll('img')[0].src, /^blob:/);
});

test('avoids overlapping refreshes and does not resurrect images after pagehide', async () => {
  const b = browser();
  await b.settle();
  let finish;
  b.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = b.refresh();
  await b.refresh();
  assert.equal(b.requests.length, 3);
  b.window.dispatchEvent(new Event('pagehide'));
  assert.equal(b.requests[2][1].signal.aborted, true);
  finish(data());
  await pending;
  assert.equal(b.requests.length, 3);
  assert.equal(b.nodes.printers.querySelectorAll('img')[0].src, undefined);
  assert.equal(b.timeouts.size, 0);
});

test('cleans up late image responses after access is denied by another camera', async () => {
  const b = browser();
  await b.settle();
  let finish;
  b.respond(async url => {
    if (url === '/machines/data') return Response.json({ cards: [card, { ...card, Image: '/machines/images/other.jpg' }], edge: 'https://edge.example', token: 'token' });
    if (String(url).endsWith('other.jpg')) return new Response(null, { status: 401 });
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = b.refresh();
  await b.settle();
  finish(jpeg());
  await pending;
  assert.equal(b.nodes.printers.children.length, 0);
  assert.equal(b.created.length, 1);
});
