import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./dashboard.js', import.meta.url), 'utf8');

function browser() {
  const intervals = [], requests = [];
  const status = { textContent: '' }, cards = { innerHTML: '' }, events = {};
  const image = { hidden: false, complete: true, naturalWidth: 0, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  let respond = async () => ({ ok: true, status: 200, text: async () => '<article>Fresh cards</article>' });
  const context = {
    document: {
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
