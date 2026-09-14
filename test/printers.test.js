import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import worker from '../src/index.js';

it('redirects anonymous visitors directly to the public machines page', async () => {
  for (const suffix of ['', '?state=obsolete&return_to=https://evil.example']) {
    const response = await worker.fetch(new Request(`${env.SITE_URL}/machines${suffix}`), { ...env, PRINTER_EDGE_URL: 'https://edge.example' });
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe('https://edge.example/machines');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow, noarchive');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
});

it('rejects unsafe or incomplete dashboard configuration', async () => {
  for (const origin of ['', 'http://edge.example', 'https://edge.example/path', 'https://user:password@edge.example']) {
    expect((await worker.fetch(new Request(`${env.SITE_URL}/machines`), { ...env, PRINTER_EDGE_URL: origin })).status).toBe(503);
  }
});
