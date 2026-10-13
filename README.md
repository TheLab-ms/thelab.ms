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
  fetch/queue/scheduled entrypoints.
- `src/membership.js` — Membership and EdgeSync Durable Objects, billing
  coordination, fob claims, and access-list synchronization.
- `src/services.js` — shared HTTP/authentication utilities, provider clients,
  member policy, validation, and queries. Also importable by Node bootstrap tools.
- `static/style.css` and `static/script.js` — shared styles and page-specific
  browser behavior. Images and public HTML live alongside them.
- `static/machines.js` and `static/machines.css` — member-only printer dashboard
  behavior and styles. The Worker serves the page and status; browsers fetch
  authenticated camera frames directly from the edge proxy.

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

### Deployment

Set the **Cloudflare Workers Builds root directory to `site`** if deployment is
connected to this repository. Install and deploy commands are `npm ci` and
`npm run deploy`, run from that directory. For an existing configured Worker:

```sh
npm run deploy
```

For initial provisioning, authenticate Wrangler or set `CLOUDFLARE_API_TOKEN`,
select the account with `CLOUDFLARE_ACCOUNT_ID`, then run:

```sh
npm run bootstrap -- --remote
```


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
