import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function browser() {
  const intervals = [], requests = [];
  const status = { textContent: '' }, cards = { innerHTML: '' }, events = {};
  const image = { hidden: false, complete: true, naturalWidth: 0, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  let respond = async () => ({ ok: true, status: 200, text: async () => '<article>Fresh cards</article>' });
  const context = {
    document: {
      getElementById(id) { return id === 'dashboard' ? {} : null; },
      hidden: false,
      querySelector(selector) { return selector === '#dashboard' ? {} : selector === '#printers' ? cards : status; },
      querySelectorAll() { return [image]; },
      addEventListener(name, fn) { events[name] = fn; },
    },
    fetch: async (...args) => { requests.push(args); return respond(...args); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
    Date, URLSearchParams, AbortSignal,
  };
  vm.runInNewContext(script, context);
  return { intervals, requests, status, cards, image, events, respond(fn) { respond = fn; } };
}

test('refreshes public cards and still images every five seconds', async () => {
  const b = browser();
  assert.equal(b.intervals[0].ms, 5000);
  assert.equal(b.image.hidden, true);
  await b.intervals[0].fn();
  assert.equal(b.requests[0][0], '/machines/content');
  assert.equal(b.requests[0][1].cache, 'no-store');
  assert.equal(b.requests[0][1].credentials, 'omit');
  assert.equal(b.cards.innerHTML, '<article>Fresh cards</article>');
  assert.match(b.status.textContent, /Updated/);
  b.image.naturalWidth = 640;
  b.image.listeners.load();
  assert.equal(b.image.hidden, false);
  b.image.listeners.error();
  assert.equal(b.image.hidden, true);
});

test('handles outage and retries without retaining a current-looking image', async () => {
  const b = browser();
  b.image.hidden = false;
  b.respond(async () => { throw new Error('network down'); });
  await b.intervals[0].fn();
  assert.match(b.status.textContent, /out of date/);
  assert.equal(b.image.hidden, true);
  b.respond(async () => ({ ok: true, status: 200, text: async () => 'Recovered' }));
  await b.intervals[0].fn();
  assert.equal(b.cards.innerHTML, 'Recovered');
  b.respond(async () => ({ ok: false, status: 503 }));
  await b.intervals[0].fn();
  assert.match(b.status.textContent, /out of date/);
});

test('does not overlap refresh requests and refreshes when a tab wakes', async () => {
  const b = browser();
  let finish;
  b.respond(() => new Promise(resolve => { finish = resolve; }));
  const first = b.intervals[0].fn();
  await b.intervals[0].fn();
  assert.equal(b.requests.length, 1);
  finish({ ok: true, status: 200, text: async () => 'Updated' });
  await first;
  const resumed = browser();
  resumed.events.visibilitychange();
  assert.equal(resumed.requests.length, 1);
});

describe('LAN kiosk browser behavior', () => {
  let document, window, nodes, fetch, timers;

  beforeEach(t => {
    timers = t.mock.timers;
    timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
    nodes = Object.fromEntries(['kiosk', 'standby', 'status', 'claim', 'qr', 'expiry', 'done'].map(id => [id,
      Object.assign(new EventTarget(), { dataset: {}, hidden: id === 'claim', textContent: '',
        setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } })]));
    document = Object.assign(new EventTarget(), { getElementById: id => nodes[id] });
    window = new EventTarget();
    fetch = t.mock.fn(async () => Response.json({ token: 'claim-token', qr: 'data:image/svg+xml;base64,qr', expires: Date.now() / 1000 + 300 }));
    vm.runInNewContext(script, { document, window, fetch, Date, setTimeout, clearTimeout, AbortController });
  });

  afterEach(() => { window.dispatchEvent(new Event('pagehide')); timers.reset(); });

  async function advance(ms) {
    timers.tick(ms);
    // Let fetch/body/submit promises settle; setImmediate is not mocked.
    await new Promise(resolve => setImmediate(resolve));
  }

  function key(key, options = {}) {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...options });
    document.dispatchEvent(event);
    return event;
  }
  const scan = value => { for (const digit of value) key(digit); };

  test('submits only after 300 ms of silence, including Enter/Tab suffixes', async () => {
    scan('00012');
    await advance(299);
    assert.equal(fetch.mock.callCount(), 0);
    key('3');
    await advance(299);
    assert.equal(key('Enter').defaultPrevented, true);
    assert.equal(key('Tab').defaultPrevented, true);
    await advance(299);
    assert.equal(fetch.mock.callCount(), 0);
    await advance(1);
    assert.equal(fetch.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body), { fob_id: 123 });
    assert.equal(nodes.claim.hidden, false);
    assert.equal(nodes.standby.hidden, true);
  });

  test('continues capturing after reset and keeps the code displayed without polling', async () => {
    scan('123');
    await advance(300);
    nodes.done.dispatchEvent(new Event('click'));
    scan('456');
    await advance(300);
    assert.deepEqual(JSON.parse(fetch.mock.calls[1].arguments[1].body), { fob_id: 456 });
    await advance(299000);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(nodes.claim.hidden, false);
    nodes.done.dispatchEvent(new Event('click'));
    assert.equal(nodes.claim.hidden, true);
    assert.equal(nodes.qr.src, undefined);
  });

  test('ignores a stale response when a new scan starts', async () => {
    let resolve;
    fetch.mock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    scan('123');
    await advance(300);
    const signal = fetch.mock.calls[0].arguments[1].signal;
    scan('456');
    assert.equal(signal.aborted, true);
    resolve(Response.json({ token: 'stale', qr: 'stale-qr', expires: Date.now() / 1000 + 300 }));
    await advance(0);
    assert.equal(nodes.claim.hidden, true);
    await advance(300);
    assert.notEqual(nodes.qr.src, 'stale-qr');
    assert.equal(nodes.claim.hidden, false);
  });

  for (const value of ['0', '4294967296', '12a3', '0'.repeat(21) + '123']) {
    test(`rejects invalid scans without issuing a claim: ${value}`, async () => {
      scan(value);
      await advance(300);
      assert.equal(fetch.mock.callCount(), 0);
      assert.equal(nodes.status.textContent, 'Fob not recognized. Scan again.');
      scan('123');
      await advance(300);
      assert.equal(nodes.claim.hidden, false);
    });
  }

  test('clears interrupted scans and ignores keyboard shortcuts', async () => {
    key('r', { ctrlKey: true });
    scan('12');
    window.dispatchEvent(new Event('blur'));
    await advance(300);
    assert.equal(fetch.mock.callCount(), 0);
    scan('456');
    await advance(300);
    assert.deepEqual(JSON.parse(fetch.mock.calls[0].arguments[1].body), { fob_id: 456 });
  });

  test('expires displayed codes and recovers from network errors with a plain-language message', async () => {
    fetch.mock.mockImplementationOnce(async () => { throw new TypeError('Internal network detail'); });
    scan('123');
    await advance(300);
    assert.equal(nodes.status.textContent, 'Fob enrollment is temporarily unavailable. Please scan again.');
    fetch.mock.mockImplementationOnce(async () => Response.json({ token: 'short', qr: 'qr', expires: Date.now() / 1000 + 1 }));
    scan('456');
    await advance(300);
    await advance(1000);
    assert.equal(nodes.claim.hidden, true);
    assert.match(nodes.status.textContent, /Code expired/);
  });
});
