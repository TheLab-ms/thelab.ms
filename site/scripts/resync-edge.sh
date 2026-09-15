#!/usr/bin/env bash
# Schedule the operator full sync described in ../../edgeproxy/README.md.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Usage: bash site/scripts/resync-edge.sh' \
    '' \
    'Queue a full edge proxy goal sync using the current Wrangler login or' \
    'CLOUDFLARE_API_TOKEN (requires Account > Queues > Edit).' \
    'Optionally set ACCOUNT_ID (or CLOUDFLARE_ACCOUNT_ID) and QUEUE_ID.' \
    'Success means queued; confirm edge.full.completed with wrangler tail.'
}

case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  '') ;;
  *) usage >&2; exit 1 ;;
esac
[[ $# -eq 0 ]] || { usage >&2; exit 1; }

root=$(node -e 'console.log(require("node:path").resolve(process.argv[1], "../.."))' "${BASH_SOURCE[0]}")
[[ -f "$root/node_modules/wrangler/bin/wrangler.js" ]] || {
  printf '%s\n' 'Install site dependencies with npm ci first.' >&2
  exit 1
}
export NO_COLOR=1 WRANGLER_SEND_METRICS=false
export CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false

wrangler() {
  node "$root/node_modules/wrangler/bin/wrangler.js" "$@" --cwd "$root" --config "$root/wrangler.jsonc"
}

account=${ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID:-}}
if [[ -z "$account" ]]; then
  account=$(wrangler whoami --json | node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const { loggedIn, accounts } = JSON.parse(input);
    if (!loggedIn) throw new Error("Run npx wrangler login or set CLOUDFLARE_API_TOKEN first.");
    if (accounts?.length !== 1) throw new Error("Set ACCOUNT_ID to select a Cloudflare account.");
    console.log(accounts[0].id);
  ')
fi
[[ "$account" =~ ^[a-fA-F0-9]{32}$ ]] || { printf '%s\n' 'Invalid ACCOUNT_ID.' >&2; exit 1; }
export CLOUDFLARE_ACCOUNT_ID="$account"

queue=${QUEUE_ID:-}
if [[ -z "$queue" ]]; then
  queue=$(wrangler queues info thelab-membership | node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const match = input.match(/^Queue ID:\s*([a-fA-F0-9]{32})\s*$/m);
    if (!match) throw new Error("Could not identify thelab-membership queue ID from Wrangler output.");
    console.log(match[1]);
  ')
fi
[[ "$queue" =~ ^[a-fA-F0-9]{32}$ ]] || { printf '%s\n' 'Invalid QUEUE_ID.' >&2; exit 1; }

printf 'Scheduling full edge proxy sync (account %s, queue %s)...\n' "$account" "$queue"
# Keep the credential in a pipe, out of command arguments, files, and output.
# Node is already required by Wrangler; fetch avoids an additional curl/jq dependency.
wrangler auth token --json | node --input-type=module -e '
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const auth = JSON.parse(input);
  if (!["oauth", "api_token"].includes(auth.type) || !auth.token) {
    throw new Error("Use wrangler login or CLOUDFLARE_API_TOKEN for Bearer authentication.");
  }
  const [account, queue] = process.argv.slice(1);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues/${queue}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content_type: "json", body: { type: "edge.sync", mode: "full" } }),
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok || result.success !== true) {
    console.error(`Queue publication failed (HTTP ${response.status}):`, JSON.stringify(result.errors || result));
    process.exit(1);
  }
  console.log("Full edge proxy resync queued (Cloudflare success: true).");
' "$account" "$queue"

printf '%s\n' \
  'Confirm delivery by looking for edge.full.completed in Worker logs.' \
  "From site/: npx wrangler tail thelab-ms --format pretty" \
  'Start the tail before scheduling to capture fast completions.'
