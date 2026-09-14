#!/usr/bin/env bash
# Bootstrap the default Worker in wrangler.jsonc. See bootstrap-worker.md.
set -euo pipefail
umask 077

usage() {
  printf '%s\n' \
    'Usage: scripts/bootstrap-worker.sh --local | --remote' \
    '' \
    '  --local   Generate missing .dev.vars keys and apply local D1 migrations.' \
    '  --remote  Create/reuse Cloudflare resources, migrate D1, and deploy with secrets.' \
    '' \
    'Remote mode requires Wrangler login or CLOUDFLARE_API_TOKEN, and an account' \
    'selected via CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc. See scripts/bootstrap-worker.md.'
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --local|--remote) mode=$1 ;;
  *) usage >&2; exit 1 ;;
esac
[[ $# -eq 1 ]] || { usage >&2; exit 1; }

# Resolve paths without depending on the caller's working directory.
root=$(node -e 'console.log(require("node:path").resolve(process.argv[1], "../.."))' "${BASH_SOURCE[0]}")
config="$root/wrangler.jsonc"
[[ -f "$root/node_modules/wrangler/bin/wrangler.js" ]] || {
  printf '%s\n' 'Install dependencies with npm ci first.' >&2
  exit 1
}
export NO_COLOR=1 WRANGLER_SEND_METRICS=false
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

wrangler() {
  node "$root/node_modules/wrangler/bin/wrangler.js" "$@" --cwd "$root" --config "$config"
}

# Use Wrangler's JSONC parser/editor and Node's crypto/dotenv support rather
# than sourcing credential files or requiring jq, Python, or a specific OpenSSL.
helper() {
  node --input-type=module - "$root" "$@" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { randomBytes, generateKeyPairSync, createPrivateKey } from 'node:crypto';

const [root, action, ...args] = process.argv.slice(2);
const configPath = path.join(root, 'wrangler.jsonc');
const { experimental_readRawConfig: readConfig, experimental_patchConfig: patchConfig } =
  await import(pathToFileURL(path.join(root, 'node_modules/wrangler/wrangler-dist/cli.js')));
const { rawConfig: config } = readConfig({ config: configPath });
const db = config.d1_databases.find(db => db.binding === 'DB');
const generated = ['AUTH_SECRET', 'EDGE_JWT_PRIVATE_KEY'];
const providers = ['TURNSTILE_SECRET_KEY', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const saveJSON = (file, value) => {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};
function fillKeys(values, existing = new Set()) {
  for (const name of generated) {
    if (existing.has(name)) continue;
    if (!values[name]) values[name] = name === 'AUTH_SECRET' ? randomBytes(32).toString('base64') :
      generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
    if (name === 'AUTH_SECRET' && Buffer.byteLength(values[name]) < 32) {
      throw new Error('AUTH_SECRET must contain at least 32 bytes.');
    }
    if (name === 'EDGE_JWT_PRIVATE_KEY' && createPrivateKey({
      key: Buffer.from(values[name], 'base64'), format: 'der', type: 'pkcs8',
    }).asymmetricKeyType !== 'ed25519') throw new Error('EDGE_JWT_PRIVATE_KEY must be Ed25519 PKCS#8 base64.');
  }
}

switch (action) {
  case 'account':
    console.log(process.env.CLOUDFLARE_ACCOUNT_ID || config.account_id || '');
    break;
  case 'resources': {
    const bucket = config.r2_buckets.find(bucket => bucket.binding === 'WIKI_BUCKET');
    const queues = [...new Set([
      ...config.queues.consumers.map(queue => queue.dead_letter_queue).filter(Boolean),
      ...config.queues.producers.map(queue => queue.queue),
      ...config.queues.consumers.map(queue => queue.queue),
    ])];
    const values = [config.name, db.database_name, bucket.bucket_name, ...queues];
    if (values.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value))) {
      throw new Error('Expected named Worker, DB, WIKI_BUCKET, and queues in wrangler.jsonc.');
    }
    console.log(values.join('\n'));
    break;
  }
  case 'database': {
    const databases = readJSON(args[0]);
    const match = db.database_id ? databases.find(item => item.uuid === db.database_id) :
      databases.find(item => item.name === db.database_name);
    if (db.database_id && !match) throw new Error('Configured D1 database ID was not found in this account.');
    if (match) {
      if (!db.database_id) patchConfig(configPath, {
        d1_databases: config.d1_databases.map(item => item === db ? { ...item, database_id: match.uuid } : item),
      }, false);
      console.log(match.uuid);
    }
    break;
  }
  case 'bucket-exists': {
    // Wrangler's bucket list is labelled text (it has no JSON option).
    const names = [...fs.readFileSync(args[0], 'utf8').matchAll(/^name:\s*(\S+)\s*$/gm)].map(match => match[1]);
    process.exitCode = names.includes(args[1]) ? 0 : 1;
    break;
  }
  case 'local-secrets': {
    const file = path.join(root, '.dev.vars');
    let text = fs.readFileSync(fs.existsSync(file) ? file : path.join(root, '.dev.vars.example'), 'utf8');
    const values = parseEnv(text);
    const previous = { ...values };
    fillKeys(values);
    for (const name of generated) {
      if (previous[name]) continue;
      // Remove blank assignments before appending generated values.
      text = text.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=.*$`, 'gm'), '');
      text += `\n${name}=${values[name]}\n`;
    }
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    break;
  }
  case 'remote-secrets': {
    const file = path.join(root, '.env.bootstrap.json');
    const values = fs.existsSync(file) ? readJSON(file) : {};
    const existing = new Set(readJSON(args[0]).map(secret => secret.name));
    for (const name of [...generated, ...providers]) {
      if (!existing.has(name) && !values[name] && process.env[name]) values[name] = process.env[name];
    }
    fillKeys(values, existing);
    const pending = {};
    for (const name of [...generated, ...providers]) {
      if (values[name] && typeof values[name] !== 'string') throw new Error(`${name} must be a string.`);
      if (!existing.has(name) && values[name]) pending[name] = values[name];
    }
    saveJSON(file, values);
    saveJSON(args[1], pending);
    for (const name of providers) {
      if (!existing.has(name) && !pending[name]) console.error(`Still needed: ${name}`);
    }
    break;
  }
  default: throw new Error(`Unknown helper action: ${action}`);
}
NODE
}

resources=$(helper resources)
names=()
while IFS= read -r name; do names+=("$name"); done <<< "$resources"
worker=${names[0]}
database=${names[1]}
bucket=${names[2]}

if [[ "$mode" == --local ]]; then
  helper local-secrets
  wrangler d1 migrations apply "$database" --local </dev/null
  printf '%s\n' 'Local bootstrap complete. Fill provider credentials in .dev.vars, then run npm run dev.'
  exit 0
fi

account=$(helper account)
# Some account-level Wrangler commands do not load account_id from the config.
if [[ -n "$account" ]]; then export CLOUDFLARE_ACCOUNT_ID="$account"; fi
scratch=$(mktemp -d "${TMPDIR:-/tmp}/worker-bootstrap.XXXXXX")
trap 'rm -rf "$scratch"' EXIT

wrangler d1 list --json > "$scratch/databases.json"
database_id=$(helper database "$scratch/databases.json")
if [[ -z "$database_id" ]]; then
  wrangler d1 create "$database" --no-update-config </dev/null
  wrangler d1 list --json > "$scratch/databases.json"
  database_id=$(helper database "$scratch/databases.json")
  [[ -n "$database_id" ]] || { printf '%s\n' 'Created database was not found.' >&2; exit 1; }
fi

wrangler r2 bucket list > "$scratch/buckets.txt"
if ! helper bucket-exists "$scratch/buckets.txt" "$bucket"; then
  wrangler r2 bucket create "$bucket" --no-update-config </dev/null
fi

for queue in "${names[@]:3}"; do
  if output=$(wrangler queues info "$queue" 2>&1); then
    printf 'Using existing queue: %s\n' "$queue"
  elif [[ "$output" == *"Queue \"$queue\" does not exist."* ]]; then
    wrangler queues create "$queue" </dev/null
  else
    printf '%s\n' "$output" >&2
    exit 1
  fi
done

if ! wrangler secret list --format json > "$scratch/secrets.json" 2> "$scratch/secrets-error.txt"; then
  error=$(< "$scratch/secrets-error.txt")
  if [[ "$error" == *"Worker \"$worker\" not found."* ]]; then
    printf '[]\n' > "$scratch/secrets.json"
  else
    printf '%s\n' "$error" >&2
    exit 1
  fi
fi
helper remote-secrets "$scratch/secrets.json" "$scratch/pending-secrets.json"
wrangler d1 migrations apply "$database" --remote </dev/null
# A single deployment installs secrets along with code, DO migrations, queue
# consumers, static assets, and the cron trigger. Existing secrets are retained.
wrangler deploy --secrets-file "$scratch/pending-secrets.json" </dev/null
printf '%s\n' 'Remote bootstrap complete. See scripts/bootstrap-worker.md for provider and domain setup.'
