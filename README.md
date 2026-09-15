# TheLab

Three independently built projects live here:

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

Source files use named sections to keep related code together. Dependencies flow
from entrypoints to state coordination to shared services. Numbered D1 migrations
retain their deployed history.

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

Remote bootstrap creates/reuses D1 and queues, applies migrations, and deploys
with missing secrets. Generated secrets are retained in `.env.bootstrap.json`.
Supply Discord, Stripe, and Turnstile credentials via the environment or that
file; public IDs and origins are configured in `wrangler.jsonc`. Configure the
Discord OAuth callback at `${SITE_URL}/login/discord/callback`, Stripe webhook at
`${SITE_URL}/webhooks/stripe`, Turnstile hostname, and the Worker's custom domain
to match the deployed site.

### Checks

From `site/`:

```sh
npm test
node --test scripts/bootstrap-worker.test.js
python3 -m unittest discover -s scripts -p 'test_*.py'
npx wrangler deploy --dry-run
```

Membership/onboarding tests live in `test/membership.test.js`; edge integration
tests live in `test/edge.test.js`.

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
- `printers.go` — printer connections/images, local configuration, and dashboard
  handlers/templates.
- `app.js` — independent dashboard and kiosk browser initializers.
- `main_test.go`, `printers_test.go`, `app_test.mjs` — server and browser tests.

Build the RouterOS linux/arm64 image with `python3 build.py`. Runtime packages
are pinned in `build-packages.json`; the archive is written to `dist/`.
