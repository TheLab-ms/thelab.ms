import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

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
