# TheLab

## `site/`

Cloudflare Worker: public site, membership, billing, and D1 database.

- Dev: `npm ci`, `cp .dev.vars.example .dev.vars` and fill it in (`AUTH_SECRET`: `openssl rand -base64 32`; `EDGE_JWT_PRIVATE_KEY`: `openssl genpkey -algorithm ed25519 -outform DER | base64`), then `npm run db:local && npm run dev`
- Test: `npm ci && npm run typecheck && npm test && npm run test:browser`
- Deploy: `npm run deploy` (type-checks and applies D1 migrations; needs secrets from `wrangler.jsonc`)
- Types: TypeScript, checked by `npm run typecheck`. After changing `wrangler.jsonc` bindings or upgrading Wrangler, run `npm run types` and commit `worker-configuration.d.ts`. Browser scripts in `static/` stay plain JavaScript checked through JSDoc. Keep `src/lib.ts` row types in step with migrations; `test/schema.test.ts` compares them.
- HTML: server-only JSX via `site/src/html.ts`; use HTML attribute names (`class`, `for`). Values are escaped automatically, and unknown tags or attributes fail the type check.

## `edgeproxy/`

Go service on the LAN router: syncs fobs to door controllers, uploads swipes, serves the kiosk, and monitors printers.

- Test: `go vet ./... && go test -race ./...`
- Deploy: pushing to `main` publishes `ghcr.io/thelab-ms/conwayedge`; run it with `/data` mounted and `CONWAYEDGE_WORKER_ISSUER`/`CONWAYEDGE_PUBLIC_URL` set.

## `access-controller/`

ESP32 door controller firmware.

- Test: `source network.env && cargo build --release` (see `network.env.example`)
- Deploy: `cargo run --release` over USB, or `./build-ota.sh` and `curl --data-binary @firmware.bin http://<device-ip>/ota`
