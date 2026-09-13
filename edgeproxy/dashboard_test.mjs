import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');

function browser({ callback = false, expires = Date.now() + 300000 } = {}) {
  const intervals = [], timeouts = [], redirects = [], requests = [], history = [];
  const status = { textContent: '' }, cards = { innerHTML: '' }, events = {};
  const image = { hidden: false, complete: true, naturalWidth: 0, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  const location = { pathname: callback ? '/printers/callback' : '/printers', hash: '#token=signed-token', replace(path) { redirects.push(path); } };
  let respond = async () => ({ ok: true, status: 200, text: async () => '<article>Fresh cards</article>' });
  const context = {
    location, history: { replaceState(...args) { history.push(args); location.hash = ''; } },
    document: {
      hidden: false,
      querySelector(selector) { return selector === '#dashboard' ? { dataset: { expires: String(expires / 1000) } } : selector === '#printers' ? cards : status; },
      querySelectorAll() { return [image]; },
      addEventListener(name, fn) { events[name] = fn; },
    },
    fetch: async (...args) => { requests.push(args); return respond(...args); },
    setInterval(fn, ms) { intervals.push({ fn, ms }); }, setTimeout(fn, ms) { timeouts.push({ fn, ms }); },
    Date, URLSearchParams, AbortSignal,
  };
  vm.runInNewContext(script, context);
  return { intervals, timeouts, redirects, requests, history, status, cards, image, events, respond(fn) { respond = fn; } };
}

test('refreshes cards and still images every five seconds and schedules membership renewal', async () => {
  const b = browser();
  assert.equal(b.intervals[0].ms, 5000);
  assert.ok(b.timeouts[0].ms > 269000 && b.timeouts[0].ms <= 270000);
  assert.equal(b.image.hidden, true);
  await b.intervals[0].fn();
  assert.equal(b.requests[0][0], '/printers/content');
  assert.equal(b.requests[0][1].cache, 'no-store');
  assert.equal(b.cards.innerHTML, '<article>Fresh cards</article>');
  assert.match(b.status.textContent, /Updated/);
  b.image.naturalWidth = 640;
  b.image.listeners.load();
  assert.equal(b.image.hidden, false);
  b.image.listeners.error();
  assert.equal(b.image.hidden, true);
  b.timeouts[0].fn();
  assert.deepEqual(b.redirects, ['/printers/login']);
});

test('handles outage, retries, and expired sessions without retaining a current-looking image', async () => {
  const b = browser();
  b.image.hidden = false;
  b.respond(async () => { throw new Error('network down'); });
  await b.intervals[0].fn();
  assert.match(b.status.textContent, /out of date/);
  assert.equal(b.image.hidden, true);
  b.respond(async () => ({ ok: true, status: 200, text: async () => 'Recovered' }));
  await b.intervals[0].fn();
  assert.equal(b.cards.innerHTML, 'Recovered');
  b.respond(async () => ({ ok: false, status: 401 }));
  await b.intervals[0].fn();
  assert.deepEqual(b.redirects, ['/printers/login']);
});

test('does not overlap refresh requests and checks expiration when a tab wakes', async () => {
  const b = browser();
  let finish;
  b.respond(() => new Promise(resolve => { finish = resolve; }));
  const first = b.intervals[0].fn();
  await b.intervals[0].fn();
  assert.equal(b.requests.length, 1);
  finish({ ok: true, status: 200, text: async () => 'Updated' });
  await first;
  const expired = browser({ expires: Date.now() - 1000 });
  expired.events.visibilitychange();
  assert.deepEqual(expired.redirects, ['/printers/login']);
  assert.equal(expired.requests.length, 0);
});

test('removes the fragment before exchanging the JWT for a cookie and opening the page', async () => {
  const b = browser({ callback: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.history[0][2], '/printers/callback');
  assert.equal(b.requests[0][0], '/printers/session');
  assert.equal(b.requests[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(b.requests[0][1].body), { token: 'signed-token' });
  assert.deepEqual(b.redirects, ['/printers']);
});
