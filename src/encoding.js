const encoder = new TextEncoder();

export const encodeBase64URL = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export const decodeBase64URL = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const encodeJSON = value => encodeBase64URL(encoder.encode(JSON.stringify(value)));
