import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('../../static/machines.js', import.meta.url), 'utf8');
const card = { Name: '<script>Maker</script>', Status: 'Printing', Remaining: '2h 5m', Updated: 'Now', Image: '/machines/images/camera.jpg', Unavailable: false };
const jpeg = () => new Response(new Uint8Array([255, 216, 255, 217]), { headers: { 'Content-Type': 'image/jpeg' } });
const settle = () => new Promise(resolve => setImmediate(resolve));

// The subset of the DOM that the dashboard script uses.
class FakeNode extends EventTarget {
  readonly tag: string;
  children: FakeNode[] = [];
  hidden = false;
  textContent = '';
  className = '';
  alt = '';
  src: string | undefined;
  constructor(tag: string) { super(); this.tag = tag; }
  append(...nodes: FakeNode[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeNode[]) { this.children = nodes; }
  removeAttribute(name: 'src') { this[name] = undefined; }
  querySelectorAll(tag: string): FakeNode[] { return this.children.flatMap(node => [...(node.tag === tag ? [node] : []), ...node.querySelectorAll(tag)]); }
}

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;
type Request = Parameters<Fetch>;
interface Timer { fn: () => void; due: number; ms?: number }

function browser({ hidden = false } = {}) {
  const nodes = { 'printers': new FakeNode('div'), 'refresh-status': new FakeNode('div'), 'access-help': new FakeNode('div') };
  nodes['access-help'].hidden = true;
  const document = Object.assign(new EventTarget(), { hidden, getElementById: (id: keyof typeof nodes) => nodes[id], createElement: (tag: string) => new FakeNode(tag) });
  const window = new EventTarget(), intervals = new Map<object, Timer>(), timeouts = new Map<object, Timer>();
  const requests: Request[] = [], revoked: string[] = [], created: { url: string; blob: Blob }[] = [];
  let now = 1800000000000;
  const data = () => {
    const claims = { iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60, aud: 'https://edge.example', scope: 'printers:read' };
    return Response.json({ edge: claims.aud, token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature` });
  };
  const normal: Fetch = async url => url === '/machines/data' ? data() : String(url).endsWith('/api/printers') ? Response.json([card]) : jpeg();
  let respond = normal;
  class BrowserURL extends URL {
    static override createObjectURL(blob: Blob) { const url = `blob:test-${created.length}`; created.push({ url, blob }); return url; }
    static override revokeObjectURL(url: string) { revoked.push(url); }
  }
  class Clock extends Date { static override now() { return now; } }
  const context = {
    document, window, URL: BrowserURL, Date: Clock, AbortController, atob,
    fetch: async (...args: Request) => { requests.push(args); return respond(...args); },
    setInterval(fn: () => void, ms: number) { const id = {}; intervals.set(id, { fn, ms, due: now + ms }); return id; },
    clearInterval(id: object) { intervals.delete(id); },
    setTimeout(fn: () => void, ms: number) { const id = {}; timeouts.set(id, { fn, due: now + ms }); return id; },
    clearTimeout(id: object) { timeouts.delete(id); },
  };
  vm.runInNewContext(script, context);
  return { nodes, document, window, intervals, requests, revoked, created, timeouts, normal, data,
    respond(fn: Fetch) { respond = fn; }, refresh: (): Promise<void> => vm.runInNewContext('refresh()', context),
    visibility(hidden: boolean) { document.hidden = hidden; document.dispatchEvent(new Event('visibilitychange')); },
    jump(ms: number) { now += ms; },
    async advance(ms: number) {
      const target = now + ms;
      while (true) {
        const timers = [...timeouts].map(([id, timer]) => ({ id, timer, map: timeouts }))
          .concat([...intervals].map(([id, timer]) => ({ id, timer, map: intervals })));
        const next = timers.sort((a, b) => a.timer.due - b.timer.due)[0];
        if (!next || next.timer.due > target) break;
        now = next.timer.due;
        if (next.map === timeouts) timeouts.delete(next.id);
        else next.timer.due += next.timer.ms!;
        next.timer.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
type Browser = ReturnType<typeof browser>;

const tokenRequests = (b: Browser) => b.requests.filter(([url]) => url === '/machines/data');
const statusRequests = (b: Browser) => b.requests.filter(([url]) => String(url).endsWith('/api/printers'));
const authorization = ([, init]: Request) => new Headers(init?.headers).get('Authorization');
const image = (b: Browser) => b.nodes.printers.querySelectorAll('img')[0]!;
const source = (url: string | URL) => url === '/machines/data' ? 'worker' : String(url).endsWith('/api/printers') ? 'status' : 'image';

test('fetches status and images directly with in-memory bearer tokens; renders names as text', async () => {
  const b = browser();
  await settle();
  assert.equal([...b.intervals.values()][0]!.ms, 5000);
  assert.equal(b.requests.length, 3);
  assert.equal(b.requests[0]![0], '/machines/data');
  assert.equal(b.requests[0]![1]?.credentials, 'same-origin');
  for (const request of b.requests.slice(1)) {
    const [url, init] = request;
    assert.ok(url instanceof URL);
    assert.equal(url.origin, 'https://edge.example');
    assert.equal(url.search, '');
    assert.match(authorization(request) ?? '', /^Bearer header\./);
    // Node's RequestInit type omits the browser-only cache option.
    const { credentials, mode, redirect, cache } = init as RequestInit & { cache?: string };
    assert.deepEqual({ credentials, mode, redirect, cache }, { credentials: 'omit', mode: 'cors', redirect: 'error', cache: 'no-store' });
  }
  assert.equal(String(b.requests[1]![0]), 'https://edge.example/api/printers');
  assert.equal(String(b.requests[2]![0]), 'https://edge.example/machines/images/camera.jpg');
  assert.equal(b.nodes.printers.querySelectorAll('h2')[0]!.textContent, card.Name);
  assert.equal(b.nodes.printers.querySelectorAll('script').length, 0);
  const img = image(b);
  assert.equal(img.src, 'blob:test-0');
  assert.equal(img.hidden, true);
  img.dispatchEvent(new Event('load'));
  assert.equal(img.hidden, false);
  img.dispatchEvent(new Event('error'));
  assert.equal(img.hidden, true);
  assert.equal(img.src, undefined);
});

test('refreshes edge data every 5 seconds but renews credentials at 45 seconds', async () => {
  const b = browser();
  await settle();
  await b.advance(40000);
  assert.equal(tokenRequests(b).length, 1);
  assert.equal(statusRequests(b).length, 9);
  await b.advance(5000);
  assert.equal(tokenRequests(b).length, 2);
  assert.equal(statusRequests(b).length, 10);
  assert.notEqual(authorization(statusRequests(b)[0]!), authorization(statusRequests(b)[9]!));
  assert.equal(b.revoked.length, 9);
  await b.advance(45000);
  assert.equal(tokenRequests(b).length, 3);
  assert.equal(statusRequests(b).length, 19);
});

for (const denied of ['worker', 'status', 'image']) {
  for (const status of [401, 403]) {
    test(`clears content and stops polling after ${denied} denies access (${status})`, async () => {
      const b = browser();
      await settle();
      if (denied === 'worker') b.jump(45000);
      b.respond(async url => source(url) === denied ? new Response(null, { status }) : b.normal(url));
      await b.refresh();
      assert.equal(b.nodes.printers.children.length, 0);
      assert.equal(b.nodes['access-help'].hidden, false);
      assert.match(b.nodes['refresh-status'].textContent, /access ended/);
      assert.ok(b.revoked.includes('blob:test-0'));
      const requests = b.requests.length;
      await b.refresh();
      b.visibility(true);
      b.visibility(false);
      b.window.dispatchEvent(new Event('pageshow'));
      await b.advance(120000);
      assert.equal(b.requests.length, requests);
    });
  }
}

test('hides stale content during outages and recovers on the next refresh', async () => {
  const b = browser();
  await settle();
  const img = image(b);
  img.dispatchEvent(new Event('load'));
  b.respond(async () => { throw new Error('offline'); });
  await b.refresh();
  assert.equal(img.hidden, true);
  assert.equal(img.src, undefined);
  assert.equal(b.nodes.printers.children.length, 0);
  assert.match(b.nodes['refresh-status'].textContent, /status unavailable/);
  b.respond(async url => String(url).endsWith('.jpg') ? new Response(null, { status: 502 }) : b.normal(url));
  await b.refresh();
  assert.equal(b.nodes['refresh-status'].textContent, '');
  assert.equal(image(b).src, undefined);
  b.respond(b.normal);
  await b.refresh();
  assert.match(image(b).src ?? '', /^blob:/);
});

test('starts hidden without polling; pauses all timers and resumes with valid credentials', async () => {
  const b = browser({ hidden: true });
  await b.advance(120000);
  assert.equal(b.requests.length, 0);
  b.visibility(false);
  await settle();
  assert.equal(b.requests.length, 3);
  b.visibility(true);
  assert.equal(b.nodes.printers.children.length, 0);
  assert.equal(b.intervals.size, 0);
  assert.equal(b.timeouts.size, 0);
  await b.advance(10000);
  b.visibility(false);
  await settle();
  assert.equal(b.requests.length, 5);
  assert.equal(tokenRequests(b).length, 1);
  assert.equal(b.intervals.size, 1);
});

test('renews before edge fetches when resuming near or after expiry', async () => {
  for (const delay of [45000, 120000]) {
    const b = browser();
    await settle();
    b.visibility(true);
    await b.advance(delay);
    b.visibility(false);
    await settle();
    assert.equal(b.requests[3]![0], '/machines/data');
    assert.equal(tokenRequests(b).length, 2);
    assert.equal(statusRequests(b).length, 2);
  }
});

for (const late of ['worker', 'status', 'image']) {
  test(`ignores late ${late} responses after hiding, even after a new refresh begins`, async () => {
    const b = browser();
    await settle();
    if (late === 'worker') b.jump(45000);
    const finish = Promise.withResolvers<Response>();
    b.respond(async url => source(url) === late ? finish.promise : b.normal(url));
    const pending = b.refresh();
    await settle();
    const request = b.requests.at(-1)!;
    await b.refresh(); // No overlap within a generation.
    assert.equal(b.requests.at(-1), request);
    b.visibility(true);
    assert.equal(request[1]?.signal?.aborted, true);
    b.respond(b.normal);
    b.visibility(false);
    await settle();
    const created = b.created.length, requests = b.requests.length;
    finish.resolve(late === 'worker' ? b.data() : late === 'status' ? Response.json([card]) : jpeg());
    await pending;
    assert.equal(b.created.length, created);
    assert.equal(b.requests.length, requests);
    assert.equal(b.nodes['refresh-status'].textContent, '');
    await b.advance(5000);
    assert.equal(b.requests.length, requests + 2);
  });
}

test('pagehide clears credentials and timers; pageshow restarts after back-forward restoration', async () => {
  const b = browser();
  await settle();
  b.window.dispatchEvent(new Event('pagehide'));
  assert.equal(b.nodes.printers.children.length, 0);
  assert.equal(b.intervals.size, 0);
  assert.equal(b.timeouts.size, 0);
  await b.advance(120000);
  assert.equal(b.requests.length, 3);
  b.window.dispatchEvent(new Event('pageshow'));
  await settle();
  assert.equal(b.requests[3]![0], '/machines/data');
  assert.equal(b.created.length, 2);
});

test('expiry cancels a delayed renewal and cannot be undone by its late response', async () => {
  const b = browser();
  await settle();
  await b.advance(40000);
  const finish = Promise.withResolvers<Response>();
  b.respond(() => finish.promise);
  await b.advance(5000);
  const old = b.requests.at(-1)!;
  const expiredData = b.data();
  await b.advance(15000);
  assert.equal(old[1]?.signal?.aborted, true);
  assert.equal(b.nodes.printers.children.length, 0);
  // The expiry timer starts a new access check even if the aborted fetch hangs.
  assert.equal(tokenRequests(b).length, 3);
  finish.resolve(expiredData);
  await settle();
  assert.equal(b.created.length, 9);
});

test('failed renewals hide content, stop using old tokens, and recover after expiry', async () => {
  const b = browser();
  await settle();
  await b.advance(40000);
  b.respond(async url => url === '/machines/data' ? new Response(null, { status: 503 }) : b.normal(url));
  await b.advance(25000);
  assert.equal(statusRequests(b).length, 9);
  assert.equal(b.nodes.printers.children.length, 0);
  assert.equal(b.nodes['access-help'].hidden, true);
  b.respond(b.normal);
  await b.advance(5000);
  assert.equal(statusRequests(b).length, 10);
  assert.equal(b.nodes.printers.querySelectorAll('img').length, 1);
});

test('late image responses after token expiry never create or reveal a blob', async () => {
  const b = browser();
  await settle();
  const finish = Promise.withResolvers<Response>();
  b.respond(async url => String(url).endsWith('.jpg') ? finish.promise : b.normal(url));
  const pending = b.refresh();
  await settle();
  const img = image(b);
  b.jump(60000); // A frozen page may resume before its timers run.
  finish.resolve(jpeg());
  await pending;
  img.dispatchEvent(new Event('load'));
  assert.equal(img.hidden, true);
  assert.equal(b.created.length, 1);
});

test('cleans up late image responses after another camera denies access', async () => {
  const b = browser();
  await settle();
  const finish = Promise.withResolvers<Response>();
  b.respond(async url => {
    if (String(url).endsWith('/api/printers')) return Response.json([card, { ...card, Image: '/machines/images/other.jpg' }]);
    if (String(url).endsWith('other.jpg')) return new Response(null, { status: 401 });
    return finish.promise;
  });
  const pending = b.refresh();
  await settle();
  finish.resolve(jpeg());
  await pending;
  assert.equal(b.nodes.printers.children.length, 0);
  assert.equal(b.created.length, 1);
});

test('validates status JSON and image paths before rendering or requesting images', async () => {
  const invalid = [{}, null, [null], [{ ...card, Unavailable: 'false' }], [{ ...card, Status: 1 }],
    Array(33).fill(card), [card, card], ...['https://evil.example/frame.jpg', '//evil.example/frame.jpg',
      '/api/goal', '/machines/images/camera.jpg?token=secret', '/machines/images/a\\b.jpg',
      '/machines/images/a.jpg#fragment'].map(Image => [{ ...card, Image }])];
  for (const cards of invalid) {
    const b = browser();
    await settle();
    b.respond(async () => Response.json(cards));
    await b.refresh();
    assert.equal(b.requests.length, 4);
    assert.equal(b.nodes.printers.children.length, 0);
    assert.match(b.nodes['refresh-status'].textContent, /status unavailable/);
  }
});

test('rejects invalid or already-expired token responses without contacting edge', async () => {
  for (const value of [{ edge: 'http://edge.example', token: 'bad' }, { edge: 'https://user:pass@edge.example', token: 'bad' },
    { edge: 'https://edge.example', token: 'bad' }]) {
    const b = browser({ hidden: true });
    b.respond(async () => Response.json(value));
    b.visibility(false);
    await settle();
    assert.equal(b.requests.length, 1);
  }
  const b = browser({ hidden: true });
  const expired = b.data();
  b.jump(60000);
  b.respond(async () => expired);
  b.visibility(false);
  await settle();
  assert.equal(b.requests.length, 1);
});
