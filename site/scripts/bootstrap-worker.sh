#!/usr/bin/env bash
# Local setup and first-deploy key preparation. See ../../README.md.
set -euo pipefail
umask 077

usage() {
  printf '%s\n' \
    'Usage: scripts/bootstrap-worker.sh --local | --secrets' \
    '' \
    '  --local    Generate missing .dev.vars keys and apply local D1 migrations.' \
    '  --secrets  Generate missing keys in .env.bootstrap.json for a NEW Worker.' \
    '' \
    'Deploy an existing Worker with npm run deploy (remote migrations run first).' \
    'For a new Worker, follow the provisioning and secrets steps in the README.'
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --local|--secrets) mode=$1 ;;
  *) usage >&2; exit 1 ;;
esac
[[ $# -eq 1 ]] || { usage >&2; exit 1; }

root=$(node -e 'console.log(require("node:path").resolve(process.argv[1], "../.."))' "${BASH_SOURCE[0]}")
[[ -f "$root/node_modules/wrangler/bin/wrangler.js" ]] || {
  printf '%s\n' 'Install dependencies with npm ci first.' >&2
  exit 1
}

# Only Node built-ins: never source credentials or import Wrangler internals.
node --input-type=module - "$root" "$mode" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { randomBytes, generateKeyPairSync, createPrivateKey } from 'node:crypto';

const [root, mode] = process.argv.slice(2);
const local = mode === '--local';
const file = path.join(root, local ? '.dev.vars' : '.env.bootstrap.json');
let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') :
  local ? fs.readFileSync(path.join(root, '.dev.vars.example'), 'utf8') : '{}';
let values;
try { values = local ? parseEnv(text) : JSON.parse(text); }
catch { throw new Error('Invalid secrets file syntax.'); }
if (!values || typeof values !== 'object' || Array.isArray(values)) {
  throw new Error('Expected a JSON object of secrets.');
}
for (const name of ['AUTH_SECRET', 'EDGE_JWT_PRIVATE_KEY']) {
  const missing = values[name] === undefined || values[name] === '';
  if (missing) values[name] = name === 'AUTH_SECRET' ? randomBytes(32).toString('base64') :
    generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  // Do not include invalid credential values in error messages.
  let valid = typeof values[name] === 'string';
  if (name === 'AUTH_SECRET') valid &&= Buffer.byteLength(values[name]) >= 32;
  else {
    try {
      valid &&= createPrivateKey({
        key: Buffer.from(values[name], 'base64'), format: 'der', type: 'pkcs8',
      }).asymmetricKeyType === 'ed25519';
    } catch { valid = false; }
  }
  if (!valid) throw new Error(`Invalid ${name}; expected ${name === 'AUTH_SECRET' ?
    'at least 32 bytes' : 'Ed25519 PKCS#8 base64'}.`);
  if (local && missing) {
    text = text.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm'), '');
    text += `\n${name}=${values[name]}\n`;
  }
}
fs.writeFileSync(file, local ? text : JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(file, 0o600);
NODE

if [[ "$mode" == --local ]]; then
  export NO_COLOR=1 WRANGLER_SEND_METRICS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
  node "$root/node_modules/wrangler/bin/wrangler.js" d1 migrations apply DB --local \
    --cwd "$root" --config "$root/wrangler.jsonc" </dev/null
  printf '%s\n' 'Local bootstrap complete. Fill provider credentials in .dev.vars, then run npm run dev.'
else
  printf '%s\n' 'Keys saved in .env.bootstrap.json. Add provider secrets and follow the README before first deploy.'
fi
