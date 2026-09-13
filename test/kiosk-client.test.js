import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let document, window, nodes, fetch;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  nodes = Object.fromEntries(['kiosk', 'standby', 'status', 'claim', 'qr', 'expiry', 'done'].map(id => [id,
    Object.assign(new EventTarget(), { dataset: {}, hidden: id === 'claim', textContent: '',
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; } })]));
  document = Object.assign(new EventTarget(), { getElementById: id => nodes[id] });
  window = new EventTarget();
  fetch = vi.fn(async () => Response.json({ token: 'claim-token', qr: 'data:image/svg+xml;base64,qr', expires: Date.now() / 1000 + 300 }));
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('fetch', fetch);
  await import('../static/kiosk.js');
});
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); });

function key(key, options = {}) {
  const event = Object.assign(new Event('keydown', { cancelable: true }), { key, ...options });
  document.dispatchEvent(event);
  return event;
}
const scan = value => { for (const digit of value) key(digit); };

it('submits only after 300 ms of silence, including Enter/Tab suffixes', async () => {
  scan('00012');
  await vi.advanceTimersByTimeAsync(299);
  expect(fetch).not.toHaveBeenCalled();
  key('3');
  await vi.advanceTimersByTimeAsync(299);
  expect(key('Enter').defaultPrevented).toBe(true);
  expect(key('Tab').defaultPrevented).toBe(true);
  await vi.advanceTimersByTimeAsync(299);
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ fob_id: 123 });
  expect(nodes.claim.hidden).toBe(false);
  expect(nodes.standby.hidden).toBe(true);
});

it('continues capturing after using the reset control and resets on completion', async () => {
  scan('123');
  await vi.advanceTimersByTimeAsync(300);
  nodes.done.dispatchEvent(new Event('click'));
  scan('456');
  await vi.advanceTimersByTimeAsync(300);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ fob_id: 456 });
  fetch.mockResolvedValueOnce(Response.json({ claimed: true }));
  await vi.advanceTimersByTimeAsync(1500);
  expect(nodes.claim.hidden).toBe(true);
  expect(nodes.status.textContent).toContain('Fob linked');
  expect(nodes.qr.src).toBeUndefined();
});

it('ignores a stale response when a new scan starts', async () => {
  let resolve;
  fetch.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  scan('123');
  await vi.advanceTimersByTimeAsync(300);
  const signal = fetch.mock.calls[0][1].signal;
  scan('456');
  expect(signal.aborted).toBe(true);
  resolve(Response.json({ token: 'stale', qr: 'stale-qr', expires: Date.now() / 1000 + 300 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(nodes.claim.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(nodes.qr.src).not.toBe('stale-qr');
  expect(nodes.claim.hidden).toBe(false);
});

it.each(['0', '4294967296', '12a3', '0'.repeat(21) + '123'])('rejects invalid scans without issuing a claim: %s', async value => {
  scan(value);
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).not.toHaveBeenCalled();
  expect(nodes.status.textContent).toBe('Fob not recognized. Scan again.');
  scan('123');
  await vi.advanceTimersByTimeAsync(300);
  expect(nodes.claim.hidden).toBe(false);
});

it('clears interrupted scans and ignores keyboard shortcuts', async () => {
  key('r', { ctrlKey: true });
  scan('12');
  window.dispatchEvent(new Event('blur'));
  await vi.advanceTimersByTimeAsync(300);
  expect(fetch).not.toHaveBeenCalled();
  scan('456');
  await vi.advanceTimersByTimeAsync(300);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ fob_id: 456 });
});

it('expires displayed codes and recovers from network errors with a plain-language message', async () => {
  fetch.mockRejectedValueOnce(new TypeError('Internal network detail'));
  scan('123');
  await vi.advanceTimersByTimeAsync(300);
  expect(nodes.status.textContent).toBe('Fob enrollment is temporarily unavailable. Please scan again.');
  fetch.mockResolvedValueOnce(Response.json({ token: 'short', qr: 'qr', expires: Date.now() / 1000 + 1 }));
  scan('456');
  await vi.advanceTimersByTimeAsync(1300);
  expect(nodes.claim.hidden).toBe(true);
  expect(nodes.status.textContent).toContain('Code expired');
});
