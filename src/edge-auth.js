import { HttpError, now, origin } from './http.js';
import { encodeBase64URL as encode, encodeJSON as json } from './encoding.js';

const encoder = new TextEncoder();
const signingKeys = new WeakMap();

async function publicJWK(key) {
  if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || !/^[A-Za-z0-9_-]{43}$/.test(key.x || '')) throw new Error('Invalid public key');
  const publicKey = { crv: 'Ed25519', kty: 'OKP', x: key.x };
  // RFC 7638 thumbprint: stable across deployments and independent of key labels.
  const kid = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(publicKey)))));
  await crypto.subtle.importKey('jwk', publicKey, 'Ed25519', false, ['verify']);
  return { ...publicKey, kid, alg: 'EdDSA', use: 'sig' };
}

async function signingKey(env) {
  const cached = signingKeys.get(env);
  if (cached?.secret === env.EDGE_JWT_PRIVATE_KEY) return cached.value;
  try {
    const bytes = Uint8Array.from(atob(env.EDGE_JWT_PRIVATE_KEY), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', bytes, 'Ed25519', true, ['sign']);
    const publicKey = await publicJWK(await crypto.subtle.exportKey('jwk', key));
    const value = { key, publicKey };
    signingKeys.set(env, { secret: env.EDGE_JWT_PRIVATE_KEY, value });
    return value;
  } catch {
    throw new HttpError(503, 'Edge signing key is not configured.');
  }
}

export async function edgeToken(env) {
  const { key, publicKey } = await signingKey(env);
  const issued = now();
  const data = `${json({ alg: 'EdDSA', typ: 'JWT', kid: publicKey.kid })}.${json({
    iss: origin(env), aud: env.EDGE_URL, sub: 'edge-sync', scope: 'edge:api', iat: issued, exp: issued + 60,
  })}`;
  return `${data}.${encode(new Uint8Array(await crypto.subtle.sign('Ed25519', key, encoder.encode(data))))}`;
}

export async function edgeJWKS(_request, env) {
  const { publicKey } = await signingKey(env);
  let additional;
  try {
    additional = JSON.parse(env.EDGE_JWT_PUBLIC_KEYS || '[]');
    if (!Array.isArray(additional) || additional.length > 7) throw new Error('Invalid key set');
    additional = await Promise.all(additional.map(publicJWK));
  } catch {
    throw new HttpError(503, 'Edge public keys are not configured correctly.');
  }
  const keys = [...new Map([publicKey, ...additional].map(key => [key.kid, key])).values()];
  return Response.json({ keys }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
