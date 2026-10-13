# TheLab

- **[`site/`](site/)** — Cloudflare Worker, public website, membership administration,
  D1 migrations, and operational scripts.
- **[`edgeproxy/`](edgeproxy/)** — Go service for door-controller synchronization,
  LAN fob enrollment, and printer monitoring. See its [operations guide](edgeproxy/README.md).
- **[`access-controller/`](access-controller/)** — access-controller firmware.

## Site

Run these commands from `site/` (Node 22.12+):

```sh
npm ci
npm run bootstrap -- --local
npm run dev
```

Local bootstrap generates missing authentication/signing keys in `.dev.vars` and
applies D1 migrations. Fill in provider credentials using `.dev.vars.example` as
the reference. Local Wrangler state and secrets live inside `site/`.

### Source layout

- `src/index.js` — HTTP routes, admin pages, waiver/fob onboarding, and Worker
  fetch/scheduled entrypoints.
- `src/membership.js` — Membership and EdgeSync Durable Objects, billing
  coordination, fob claims, and access-list synchronization.
- `src/services.js` — shared HTTP/authentication utilities, provider clients,
  member policy, validation, and queries. Also importable by Node bootstrap tools.
- `static/style.css` and `static/script.js` — shared styles and page-specific
  browser behavior. Images and public HTML live alongside them.
- `static/machines.js` and `static/machines.css` — member-only printer dashboard
  behavior and styles. The Worker serves the page and checks eligibility for
  60-second read-only tokens, renewed around 45 seconds. Visible tabs fetch status
  and camera frames directly from the edge every five seconds. Status and image
  access revocation takes at most 60 seconds; hidden tabs pause refreshes.

Source files use named sections to keep related code together. Dependencies flow
from entrypoints to state coordination to shared services. Numbered D1 migrations
retain their deployed history.

### Swipe history

Door swipes are retained in `member_events` as `FobSwipe` rows. The nullable,
unique `source_event_id` deduplicates edge retries; `details` retains the original
ID, timestamp, controller, fob and decision. Ownership is resolved against fob
assignment intervals at swipe time. Conway imports retain the exported owner
and use `conway:<uid>` source IDs.

Migration `0005_swipe_events.sql` backfills source IDs in place, recovers any
`edge_swipes` rows missing from history, then removes that table and its trigger.
Existing history IDs, timestamps, owners and details are preserved, with no
retention cutoff. Ambiguous duplicate swipe IDs fail the migration for inspection.
Apply this migration with swipe ingestion paused and release the matching Worker
before resuming delivery; the old Worker requires the removed table. Edge delivery
retries remain idempotent across the upgrade.

Run Worker and importer checks from `site/`:

```sh
npm test
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Importer checks require Python linked to SQLite 3.42+. Worker tests include a
populated pre-upgrade D1 database and partial-batch retry coverage.

### Edge synchronization

Membership changes notify EdgeSync immediately. A daily **07:00 UTC (1 AM CST /
2 AM CDT)** schedule forces a complete goal snapshot and cleans expired fob
claims. Scheduled and [operator full syncs](edgeproxy/README.md#operator-full-sync)
share durable forced work, retained until delivery succeeds and retried by alarm
after 60 seconds. Ordinary notifications cannot downgrade a pending forced sync.
Completion logs `edge.full.completed` without a date; repeated requests safely
send another snapshot. Legacy pending objects recover automatically, and successful
reconciliation removes obsolete nightly-date state.

### Membership synchronization

Stripe webhooks resolve the customer to a membership and await its durable
pending-sync marker **and alarm** before returning 204. Unmapped customers are
ignored. Checkout, payment confirmation, Discord identity refresh, and admin
identity edits schedule the same work. Identity edits persist recovery before
external writes and before D1 commit: after an interrupted edit, reconciliation
uses the identity actually saved in D1. Operators can reapply a rejected edit.

The existing Membership Durable Object serializes notifications, edits, and alarm
execution, including across network awaits. A storage transaction commits each
pending generation with its wakeup. Duplicate notifications coalesce; a notification
waiting behind an in-flight sync creates a later generation after completion, so
an old response cannot acknowledge new work. A watchdog is persisted before
provider calls, and completion clears pending state and alarm atomically.
Reconciliation fetches current Stripe billing/subscriptions and repeats idempotent
Discord role PUT/DELETE operations even when billing state was already saved.

Failures retain their error reference, provider status, attempt count and next
attempt in the DO without a retention deadline. Retries use exponential backoff
(30 seconds up to 12 hours) and honor longer provider Retry-After values. After
12 failed/interrupted attempts, work pauses for review; notifications and repair
do not reset failures or bypass backoff. **Admin → Synchronization** lists durable
state; webhooks for paused memberships return retryable 503 instead of acknowledging
work without an armed alarm. The admin page lists
members in pages of 25. Each member page also shows state and a **Retry membership
sync** POST action. Retry resets the attempt budget but respects Retry-After.
All operator actions use the existing admin session, Origin and CSRF validation.

The nightly job also schedules at most 100 memberships with Stripe or Discord
identities, least-recently visited first (minimum 24 hours between visits).
`sync_repair_at` is only a D1 sweep cursor; pending/error state remains in the DO.
This rotating repair catches missed billing notifications, including never-synced
rows, without letting failing members starve others. Large rosters take multiple
nights; the admin **Schedule next 100 stale memberships** action advances the same
sweep immediately. Repair preserves paused work, which needs explicit per-member
retry. No queue, DLQ, operator API secret, or additional service is required.

### Deployment

Set the **Cloudflare Workers Builds root directory to `site`** if deployment is
connected to this repository. Install and deploy commands are `npm ci` and
`npm run deploy`, run from that directory. For an existing configured Worker:

```sh
npm run deploy
```

Authenticate Wrangler (`npx wrangler login`) or set `CLOUDFLARE_API_TOKEN`, and
select the account with `CLOUDFLARE_ACCOUNT_ID`. `npm run deploy` runs
`wrangler d1 migrations apply DB --remote` through its `predeploy` hook before
`wrangler deploy`; a migration failure stops deployment. The configured production
D1 ID is `3e4bca68-f6db-4ef5-8e92-c80a38f02aa1`: keep it for existing deployments.
Review migration compatibility before deploying, especially the swipe-ingestion
pause described above. Migrations are not rolled back if the subsequent deploy
fails; fix the deployment and retry before resuming ingestion.
For an offline bundle check, use `npx wrangler deploy --dry-run` directly:
`npm run deploy -- --dry-run` would still run the remote migration hook.

Ordinary deployments retain remote secrets and never upload locally generated keys.
Wrangler validates the seven names in `secrets.required`; missing secrets block
deployment. For an existing Worker, inspect **names only** with
`npx wrangler secret list --format json`, then use `npx wrangler secret put NAME`
for each missing name (the interactive value prompt is hidden). Do not put a name
that already exists unless intentionally rotating it: `secret put`, `secret bulk`,
and `deploy --secrets-file` overwrite supplied names. Never upload `.dev.vars` or
an old bootstrap file to an existing Worker. Required declarations check presence,
not credential validity; supply real nonempty provider credentials. Secret
validation happens during deploy, after the predeploy migrations.
The old `bootstrap -- --remote` mode has been replaced by this workflow.

#### First deployment to a new account/Worker

Use a separate checkout/configuration for a new deployment:

1. Set the new Worker name, account and site/provider variables in
   `wrangler.jsonc`. Replace the production D1 entry's name and ID with the new
   database details in the next step; retain binding `DB` and `migrations_dir`.
2. Create the database explicitly with the supported command (substitute a unique
   name):

   ```sh
   npx wrangler d1 create NEW_DATABASE_NAME --no-update-config
   ```

   Copy the returned `database_id` and name into the `DB` entry. If the database
   already exists, copy its ID from the dashboard instead of creating another.
   D1 automatic provisioning is supported, but happens during deploy, too late
   for our predeploy migration hook. Explicit creation lets migrations finish
   before any HTTP or scheduled handlers can run.
3. Prepare independent production keys locally:

   ```sh
   npm run bootstrap -- --secrets
   ```

   This creates ignored, mode-0600 `.env.bootstrap.json` containing a random
   `AUTH_SECRET` and an Ed25519 PKCS#8 base64 `EDGE_JWT_PRIVATE_KEY`. Reruns preserve
   existing keys and provider entries; nothing is uploaded or printed. Using a
   secure editor, add `TURNSTILE_SECRET_KEY`, `DISCORD_CLIENT_SECRET`,
   `DISCORD_BOT_TOKEN`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` as nonempty
   JSON strings. Keep these production keys separate from `.dev.vars`.
4. After confirming this is a **new Worker**, deploy with all seven secrets:

   ```sh
   npm run deploy -- --secrets-file .env.bootstrap.json
   ```

   npm applies remote D1 migrations first and forwards `--secrets-file` only to
   deploy. A fresh Worker cannot pass required-secret validation without this
   file. If deployment fails, retain the file for recovery; check the Worker in
   the dashboard before retrying, and use the same keys. Once deployed, store the
   keys in your secret manager, remove the bootstrap file, and use ordinary
   `npm run deploy` for subsequent releases.

The lockfile pins Wrangler **4.131.1**. Durable Object bindings retain their existing
migration history and need no separate provisioning script.
Finish provider callback/webhook configuration and attach the intended custom
domain in Cloudflare before directing users to the new deployment.

#### Queue-to-alarm cutover (existing deployment)

For this low-load rollout, messages remaining in the old queues need not be
preserved. Migration `0006_membership_sync.sql` is additive and compatible with
the previous Worker.

1. Run `npm run deploy` from `site/` to apply migrations and deploy the Worker
   with its queue binding/consumer removed.
2. Verify a mapped Stripe webhook schedules durable work and its alarm completes
   Stripe/Discord reconciliation. In **Admin → Synchronization**, check status
   and retry any failures, then run **Full edge sync**. This authenticated action
   replaces `resync-edge.sh`.
3. Confirm the old consumer is detached and no old producers remain, then delete
   `thelab-membership` and `thelab-membership-failed` through Cloudflare management
   tooling. Remaining messages may be discarded.

This queue cutover needs no separate maintenance window. The distinct
`0005_swipe_events.sql` ingestion pause described above and the edge-first
deployment requirements in the [edge operations guide](edgeproxy/README.md)
still apply when those upgrades are included. These are rollout instructions;
repository checks and dry-run bundling make no live cloud changes.


## Edge proxy

From `edgeproxy/` (Go 1.25+, Node 22.12+, Python 3.12+ for packaging):

```sh
go test ./...
node --test app_test.mjs
python3 -m unittest build_test.py
go build .
```

- `main.go` — startup/listeners, authentication, SQLite state, controller APIs,
  swipe delivery, and LAN kiosk handlers/assets.
- `printers.go` — printer connections/images, local configuration, and status API.
- `app.js` — LAN kiosk browser behavior.
- `main_test.go`, `printers_test.go`, `app_test.mjs` — server and browser tests.

Build the RouterOS linux/arm64 image with `python3 build.py`. Runtime packages
are pinned in `build-packages.json`; the archive is written to `dist/`.
