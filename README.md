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
- `src/calendar.js` — public Google Calendar feed parsing, recurrence expansion,
  and Cloudflare caching for `/calendar/data?month=YYYY-MM`.
- `static/calendar.js` and `static/calendar.css` — homepage month/list calendar
  and accessible event details.
- `static/style.css` and `static/script.js` — shared styles and page-specific
  browser behavior. Images and public HTML live alongside them.
- `static/machines.js` and `static/machines.css` — member-only printer dashboard
  behavior and styles. The Worker serves the page and status; browsers fetch
  authenticated camera frames directly from the edge proxy.

Source files use named sections to keep related code together. Dependencies flow
from entrypoints to state coordination to shared services. Numbered D1 migrations
retain their deployed history.

### Homepage calendar

The calendar after Our Facilities reads TheLab's public Google iCal feed; no
Google API key is required. Source data and monthly results are reused for ten
minutes using the Cloudflare Cache API. A separate last-successful feed is retained
for up to 24 hours for temporary upstream failures (subject to cache eviction).
Dates use America/Chicago; browsing allows the previous month through the next
twelve months. Calendar data loads when the section approaches the viewport.

To preview locally with the correct Worker origin, run from `site/`:

```sh
npm run dev -- --port 8787 --var SITE_URL:http://localhost:8787
```

Open `http://localhost:8787` and scroll to Events. Inspect the JSON directly at
`http://localhost:8787/calendar/data`; an optional `month=YYYY-MM` selects a month
within the available range. Local Wrangler caching is useful for development;
production cache entries are specific to each Cloudflare data center.

Run calendar tests with `npm test -- test/calendar.test.js`.

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
