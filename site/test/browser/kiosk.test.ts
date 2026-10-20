import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test, describe, beforeEach, afterEach, type Mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('../../static/kiosk/app.js', import.meta.url), 'utf8');

// The subset of an element that the kiosk script uses.
class FakeElement extends EventTarget {
  dataset: Record<string, string> = {};
  textContent = '';
  hidden = false;
  src: string | undefined;
  role: string | undefined;
  setAttribute(name: 'role' | 'src', value: string) { this[name] = value; }
  removeAttribute(name: 'role' | 'src') { this[name] = undefined; }
}

const ids = ['kiosk', 'status', 'claim', 'qr', 'close'] as const;
const claimResponse = (expires = Date.now() / 1000 + 300) => Response.json({ token: 'claim-token', qr: 'data:image/svg+xml;base64,qr', expires });

describe('LAN kiosk browser behavior', () => {
  let document: EventTarget, window: EventTarget, nodes: Record<typeof ids[number], FakeElement>;
  let fetch: Mock<(input: string, init: RequestInit) => Promise<Response>>, timers: TestContext['mock']['timers'];

  beforeEach(t => {
    timers = (t as TestContext).mock.timers;
    timers.enable({ apis: ['Date', 'setTimeout'], now: 1800000000000 });
    nodes = Object.fromEntries(ids.map(id => [id, Object.assign(new FakeElement(), { hidden: id === 'claim' })])) as typeof nodes;
    document = Object.assign(new EventTarget(), { getElementById: (id: typeof ids[number]) => nodes[id] });
    window = new EventTarget();
    fetch = (t as TestContext).mock.fn(async (_input: string, _init: RequestInit) => claimResponse());
    vm.runInNewContext(script, { document, window, fetch, Date, setTimeout, clearTimeout, AbortController });
  });

  afterEach(() => { window.dispatchEvent(new Event('pagehide')); timers.reset(); });

  async function advance(ms: number) {
    timers.tick(ms);
    // Let fetch/body/submit promises settle; setImmediate is not mocked.
    await new Promise(resolve => setImmediate(resolve));
  }

  function key(key: string, options: { ctrlKey?: boolean } = {}) {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...options });
    document.dispatchEvent(event);
    return event;
  }
  const scan = (value: string) => { for (const digit of value) key(digit); };
  const sent = (call: number) => JSON.parse(String(fetch.mock.calls[call]!.arguments[1].body));

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
    assert.deepEqual(sent(0), { fob_id: 123 });
    assert.equal(nodes.claim.hidden, false);
  });

  test('closes the QR code with the close button or Escape', async () => {
    scan('123');
    await advance(300);
    nodes.close.dispatchEvent(new Event('click'));
    assert.equal(nodes.claim.hidden, true);
    assert.equal(nodes.qr.src, undefined);
    assert.equal(nodes.status.textContent, 'Tap your fob');
    scan('456');
    await advance(300);
    assert.equal(nodes.claim.hidden, false);
    key('Escape');
    assert.equal(nodes.claim.hidden, true);
    await advance(300000);
    assert.equal(nodes.status.textContent, 'Tap your fob');
  });

  test('continues capturing while a code is displayed without polling', async () => {
    scan('123');
    await advance(300);
    scan('456');
    await advance(300);
    assert.deepEqual(sent(1), { fob_id: 456 });
    await advance(299000);
    assert.equal(fetch.mock.callCount(), 2);
    assert.equal(nodes.claim.hidden, false);
    assert.equal(nodes.qr.src, 'data:image/svg+xml;base64,qr');
    window.dispatchEvent(new Event('pagehide'));
    assert.equal(nodes.claim.hidden, true);
    assert.equal(nodes.qr.src, undefined);
  });

  test('ignores a stale response when a new scan starts', async () => {
    const stale = Promise.withResolvers<Response>();
    fetch.mock.mockImplementationOnce(() => stale.promise);
    scan('123');
    await advance(300);
    const signal = fetch.mock.calls[0]!.arguments[1].signal!;
    scan('456');
    assert.equal(signal.aborted, true);
    stale.resolve(Response.json({ token: 'stale', qr: 'stale-qr', expires: Date.now() / 1000 + 300 }));
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
    assert.deepEqual(sent(0), { fob_id: 456 });
  });

  test('expires displayed codes and recovers from network errors with a plain-language message', async () => {
    fetch.mock.mockImplementationOnce(async () => { throw new TypeError('Internal network detail'); });
    scan('123');
    await advance(300);
    assert.equal(nodes.status.textContent, 'Unavailable. Scan again.');
    fetch.mock.mockImplementationOnce(async () => claimResponse(Date.now() / 1000 + 1));
    scan('456');
    await advance(300);
    await advance(1000);
    assert.equal(nodes.claim.hidden, true);
    assert.match(nodes.status.textContent, /Code expired/);
  });
});
