import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { edgeJWKS, edgeToken } from '../src/edge-auth.js';
import { EdgeSync } from '../src/edge-sync.js';
import { testEdgePrivateKey } from './edge-auth-helpers.js';

const config = { ...env, EDGE_URL: 'https://edge.example', EDGE_JWT_PRIVATE_KEY: testEdgePrivateKey };
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const parse = value => JSON.parse(new TextDecoder().decode(decode(value)));
afterEach(() => vi.restoreAllMocks());

it('matches the Go verifier interoperability fixture', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
  expect(await edgeToken(config)).toBe('eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtQcktfcW14VldhWVZBOXd3QkY2SXVvM3ZWeno3VHhIQ1R3WEJ5Z3JTNGsifQ.eyJpc3MiOiJodHRwczovL3RoZWxhYi5leGFtcGxlIiwiYXVkIjoiaHR0cHM6Ly9lZGdlLmV4YW1wbGUiLCJzdWIiOiJlZGdlLXN5bmMiLCJzY29wZSI6ImVkZ2U6YXBpIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDAwNjB9.c9kUt-WlqySz-RDa62Q4wgwoV9a0XMGole4SYlWp1xJEKBhSKTsERxcoIUMih0TiU2Wa1UodgU7AM8qfz5zjAw');
});

it('publishes only public JWKS fields and signs matching short-lived API tokens', async () => {
  const response = await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`), config);
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  const { keys } = await response.json();
  expect(keys).toHaveLength(1);
  expect(Object.keys(keys[0]).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x']);
  expect(keys[0]).toMatchObject({ alg: 'EdDSA', kty: 'OKP', crv: 'Ed25519', use: 'sig', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' });
  const [header, payload, signature] = (await edgeToken(config)).split('.');
  expect(parse(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: keys[0].kid });
  const claims = parse(payload);
  expect(claims).toEqual({ iss: env.SITE_URL, aud: config.EDGE_URL, sub: 'edge-sync', scope: 'edge:api', iat: expect.any(Number), exp: expect.any(Number) });
  expect(claims.exp - claims.iat).toBe(60);
  const key = await crypto.subtle.importKey('jwk', keys[0], 'Ed25519', false, ['verify']);
  expect(await crypto.subtle.verify('Ed25519', key, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
  expect((await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`, { method: 'POST' }), config)).status).toBe(405);
});

it('supports overlapping rotation keys with stable thumbprints and strips private fields', async () => {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const nextSecret = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
  const before = await (await edgeJWKS(null, config)).json();
  const staged = await (await edgeJWKS(null, { ...config, EDGE_JWT_PUBLIC_KEYS: JSON.stringify([jwk, jwk]) })).json();
  expect(staged.keys).toHaveLength(2);
  expect(staged.keys.some(k => 'd' in k)).toBe(false);
  const rotated = { ...config, EDGE_JWT_PRIVATE_KEY: nextSecret, EDGE_JWT_PUBLIC_KEYS: JSON.stringify(before.keys) };
  const after = await (await edgeJWKS(null, rotated)).json();
  expect(after.keys.map(k => k.kid).sort()).toEqual(staged.keys.map(k => k.kid).sort());
  expect(parse((await edgeToken(rotated)).split('.')[0]).kid).toBe(staged.keys[1].kid);
});

it('fails closed on missing/invalid signing keys and malformed extra keys', async () => {
  for (const secret of ['', 'invalid']) {
    await expect(edgeToken({ ...config, EDGE_JWT_PRIVATE_KEY: secret })).rejects.toThrow('signing key');
    expect((await worker.fetch(new Request(`${env.SITE_URL}/.well-known/edge-jwks.json`), { ...config, EDGE_JWT_PRIVATE_KEY: secret })).status).toBe(503);
  }
  for (const keys of ['null', '{}', '[{"kty":"RSA"}]']) {
    await expect(edgeJWKS(null, { ...config, EDGE_JWT_PUBLIC_KEYS: keys })).rejects.toThrow('public keys');
  }
});

it('sends signed bearer tokens without Access credentials and does not follow redirects', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { Location: 'https://other.example' } }));
  const response = await EdgeSync.prototype.request.call({ env: config }, '/api/swipes');
  expect(response.status).toBe(302);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://edge.example/api/swipes');
  expect(init.redirect).toBe('manual');
  expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'Content-Type']);
  expect(parse(init.headers.Authorization.slice(7).split('.')[1]).scope).toBe('edge:api');
  await expect(EdgeSync.prototype.request.call({ env: { ...config, EDGE_URL: 'http://edge.example' } }, '/api/swipes')).rejects.toThrow('configuration');
});
