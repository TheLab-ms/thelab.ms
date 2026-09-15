import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedBytes, boundedText, provider } from '../src/services.js';
import { edgeRequest } from '../src/membership.js';

// RFC 8032 test seed in PKCS#8; public test material, never a deployment key.
const edgeEnv = { ...env, EDGE_URL: 'https://edge.example',
  EDGE_JWT_PRIVATE_KEY: 'MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g' };

// Leave the stream open after its chunks, so an overflow must actively cancel it.
function streamed(chunks) {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    cancel,
  });
  return { response: new Response(body), body, cancel };
}

afterEach(() => vi.restoreAllMocks());

describe('Bounded streaming bodies', () => {
  it.each([null, '1'])('cancels streamed overflow with Content-Length %s and releases the reader', async length => {
    const { response, body, cancel } = streamed([new Uint8Array(8), new Uint8Array(1)]);
    if (length !== null) response.headers.set('Content-Length', length);
    await expect(boundedBytes(response, 8)).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('accepts exactly the byte limit and decodes characters split between chunks', async () => {
    const bytes = new TextEncoder().encode('a€');
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    } });
    expect(await boundedText(new Response(body), 4)).toBe('a€');
    expect(body.locked).toBe(false);
  });

  it('rejects invalid UTF-8 and releases the reader after stream failure', async () => {
    await expect(boundedText(new Response(new Uint8Array([0xff])))).rejects.toThrow();
    const error = new Error('Stream disconnected');
    const body = new ReadableStream({ pull(controller) { controller.error(error); } });
    await expect(boundedBytes(new Response(body))).rejects.toBe(error);
    expect(body.locked).toBe(false);
  });

  it('rejects oversized provider bodies without exposing response fragments', async () => {
    const { response, body, cancel } = streamed([
      new TextEncoder().encode('private-provider-body'), new Uint8Array(2 * 1024 * 1024),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider('https://api.stripe.com/v1/customers', {}, 'Stripe', env)).rejects.toMatchObject({ status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ failure: 'invalid_response' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-provider-body');
  });

  it('cancels edge responses exceeding 16 KiB and clears the request timer', async () => {
    const { response, body, cancel } = streamed([new Uint8Array(16384), new Uint8Array(1)]);
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(edgeRequest(edgeEnv, '/api/goal')).rejects.toMatchObject({ status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(clear).toHaveBeenCalled();
  });
});

describe('Request deadlines', () => {
  // Listen to the real signal: removing the production timeout leaves these
  // requests stalled and fails the test, rather than receiving an injected error.
  function stall() {
    let signal;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    return { fetch, signal: () => signal };
  }

  it('aborts stalled provider fetches at the 15-second deadline', async () => {
    const stalled = stall(), started = Date.now();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(provider('https://discord.com/api/v10/users/@me', {}, 'Discord', env)).rejects.toMatchObject({ status: 502 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(14000);
    expect(stalled.signal().aborted).toBe(true);
    expect(stalled.signal().reason.name).toBe('TimeoutError');
    expect(stalled.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ failure: 'transport', error: { cause: { name: 'TimeoutError' } } });
  }, 25000);

  it('aborts stalled edge fetches at the 20-second deadline and clears the timer', async () => {
    const stalled = stall(), started = Date.now();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await expect(edgeRequest(edgeEnv, '/api/goal')).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(19000);
    expect(stalled.signal().aborted).toBe(true);
    expect(stalled.fetch).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalled();
  }, 30000);
});
