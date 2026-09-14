# conwayedge

A standalone Go HTTP service for LAN access controllers and Bambu printer status/cameras. The cloud computes authorized fob IDs and pushes versioned diffs or complete snapshots. Edge persists access permissions, printer configuration, and swipes in SQLite; it does no cloud polling or membership business logic.

## Run

Requires Go 1.25+ and `ffmpeg` on PATH for cameras. SQLite uses the pure-Go `modernc.org/sqlite` driver; no C compiler or system SQLite library is needed.

```sh
go build .
./conwayedge -lan 192.168.1.10:8080 -tunnel 127.0.0.1:8081 -data ./data
```

Defaults: `-lan :80`, `-tunnel :8080`, `-data /data`. Run one instance per data directory on a local filesystem. For an unprivileged local process, use the explicit non-privileged ports and writable directory in the example above. New directories use mode 0700 and the database uses 0600. Protect existing directories equivalently: the database contains printer access codes.

Point controllers at the LAN listener. Its configuration page at `/` is unauthenticated and trusts the LAN; saves require the page's CSRF token. Point cloudflared **only** at the tunnel listener. Bind it to loopback for a local cloudflared process, or use a trusted-subnet address for a separate cloudflared host and restrict that port to the cloudflared host through the network firewall. Machine APIs validate Worker-signed bearer JWTs using periodically refreshed public JWKS keys. Machines status and camera routes are public with no-index directives.

## Build for MikroTik ARM64

From the repository root:

```sh
python3 edgeproxy/build.py
```

Build-script checks: `python3 -m unittest discover -s edgeproxy -p build_test.py`.

Output: **`edgeproxy/dist/conwayedge-linux-arm64.tar.gz`**, with a companion `.sha256` file. This is a RouterOS-importable container image archive (manifest, configuration, filesystem layer), generated directly without Docker, Podman, a Linux VM, or target emulation. Cross-builds run on macOS or Linux using installed **Python 3.12+, Go 1.25+, and curl**. The script selects a compatible Go on PATH or in Go's existing toolchain cache; `--go /path/to/go` overrides selection. Go toolchain auto-downloads are disabled; Go module downloads follow `go.sum`.

The build downloads **precompiled Alpine 3.23 ARM64 packages** for FFmpeg, its transitive runtime dependencies (including OpenSSL and the musl dynamic loader), BusyBox, and CA certificates. Only edgeproxy is cross-compiled, using `CGO_ENABLED=0`; SQLite and dashboard assets are compiled into it. Packages are unpacked directly with Python; no package install scripts or target binaries run on the build host. The complete runtime supports FFmpeg's RTSPS-to-MJPEG camera pipeline and outbound HTTPS for Worker JWKS discovery. The build checks ARM64 ELF architecture and resolves the executable/shared-library dependencies inside the image.

Every package URL, version, and SHA-256 is pinned in `edgeproxy/build-packages.json`, also included in the image at `/usr/share/conwayedge/build-packages.json`. Downloads are cached under `edgeproxy/.build-cache/` and verified on every build. Options: `--cache /path/to/cache`, `--output /path/to/image.tar.gz`. Normal builds use the lockfile without fetching repository indexes. To update dependencies, run `python3 edgeproxy/build.py --update-lock`, review the lockfile changes, then rebuild. This explicit maintenance command resolves dependencies from the Alpine branch's main/community indexes over HTTPS and pins the downloaded package bytes. Alpine mirrors may retire older package revisions; retain the download cache for rebuilding those revisions, or refresh the lockfile.

### RouterOS deployment

Use an ARM64 router with RouterOS v7, its matching `container` package installed, and container device mode enabled. Upload the tarball to `disk1/`. The example uses an existing routed, secure subnet: container `192.168.50.2`, gateway `192.168.50.1`, bridge `secure-bridge`, and a separate cloudflared host `192.168.50.3`. Substitute your actual network and disk names.

```routeros
/interface/veth/add name=veth-edge address=192.168.50.2/24 gateway=192.168.50.1
/interface/bridge/port/add bridge=secure-bridge interface=veth-edge
/container/mounts/add list=edge-data src=disk1/edge-data dst=/data
/container/envs/add list=edge-env key=CONWAYEDGE_WORKER_ISSUER value="https://thelab.ms"
/container/envs/add list=edge-env key=CONWAYEDGE_PUBLIC_URL value="https://edge.example.com"
/container/add file=disk1/conwayedge-linux-arm64.tar.gz name=edgeproxy interface=veth-edge root-dir=disk1/edge-root mountlists=edge-data envlist=edge-env dns=192.168.50.1 logging=yes start-on-boot=yes
/container/print
```

Wait for extraction to finish (`status=stopped`), then `/container/start edgeproxy`. The image runs directly as UID/GID **0:0** (root) so it can bind privileged ports such as TCP 80 on RouterOS. Its image arguments are `-lan :8080 -tunnel :8081 -data /data`; set RouterOS `cmd` to override those arguments, for example `cmd="-lan :80 -tunnel :8081 -data /data"` for LAN HTTP on port 80. `/data` is mode 0700 and owned by root in the image. Let RouterOS populate a new mount from the image; a pre-existing data directory must also be writable by the container's root user. Keep the data mount separate from `root-dir` so replacing the container preserves SQLite. A BusyBox `/bin/sh` is included for `/container/shell edgeproxy`; use `/bin/busybox <command>` for its utilities. Runtime updates are deployed by rebuilding/reimporting the image.

Allow controllers/admin clients to reach TCP 8080, and **only cloudflared** to reach TCP 8081. Apply that policy on the actual packet path: routed traffic uses RouterOS IP firewall forwarding rules; hosts on the same bridge require bridge filtering or equivalent subnet isolation. Cloudflared routes the edge hostname to `http://192.168.50.2:8081` with a catch-all `http_status:404`. Configure Worker JWT authentication below. Controller signing seeds, when used, are runtime-mounted files referenced by `CONWAYEDGE_SIGNING_SEED`.

The container needs DNS and outbound HTTPS to the Worker's JWKS endpoint and routes to printer TCP ports 8883 and 322. Cloudflared is deployed separately and keeps its tunnel credentials there.

After importing, check `/log/print` for both listeners, open `http://192.168.50.2:8080/`, configure a printer, and use admin **Full resync** to verify the cloud API. Restart the container to verify configuration/goal persistence. Open the public machines dashboard and verify fresh camera snapshots; this exercises the target FFmpeg RTSPS pipeline on the router. Host-side build checks inspect Linux binaries without executing them, so this on-router smoke test is still required.

### Switching from file-backed edge

This is a fresh-start storage and cloud-API change. Drain any pending swipes you need from the old service, stop it, and start this version with a **new data directory**. Reconfigure printers and push the current goal. `goal.json`, `printers.json`, `swipe-spool.json`, and `swipes.jsonl` are not imported or used. Worker callers must adopt the API below.

Controller firmware keeps its existing protocol and optional signing identity. Before the first goal is received, controller requests return 503 so controllers retain their own cache.

## API

| Listener | Endpoint | Contract |
| --- | --- | --- |
| Tunnel | `PUT /api/goal` | `{"version":123,"fobs":[7,42]}`; 204 after persistence, 409 for older/conflicting versions. |
| Tunnel | `GET /api/goal` | Current `{"version":123,"fobs":[7,42]}`; 503 before initialization. |
| Tunnel | `PATCH /api/goal` | `{"base_version":123,"version":124,"add":[8],"remove":[7]}`; atomic version-checked diff. |
| Tunnel | `GET /api/swipes` | JSON array of all events retained from the last seven days; does not consume them. No pagination parameters. |
| Tunnel | `GET /machines` | Public machines dashboard; status and images refresh every five seconds. |
| Tunnel | `GET /machines/content` | Public HTML printer cards used by the dashboard refresh. |
| Tunnel | `GET /machines/images/{serial}.jpg` | Public current JPEG; 404 unknown printer, 502 camera unavailable. |
| LAN | `POST /api/fobs` | Controller swipe array in; authorized ID array or 304 out. |
| LAN | `GET /`, `POST /` | Printer configuration form. |

Cloud responses have `Cache-Control: no-store`. JSON mutations have a 16 KiB body limit and reject unknown fields and trailing values. Validation errors return 400. Storage failures return 500; no goal returns 503. Retry failed requests. The old `POST /api/goal`, `/api/goal/versioned`, `/api/swipes/ack`, `/api/printers`, `/api/printers/{serial}/snapshot.jpg`, and `/machines/stream/{serial}` APIs are removed.

### Access goal

```sh
curl --fail-with-body -H "Authorization: Bearer $EDGE_JWT" \
  -X PUT https://edge.example.com/api/goal \
  -H 'Content-Type: application/json' \
  --data '{"version":123,"fobs":[7,42]}'
```

Send at most 512 nonzero unsigned 32-bit IDs. IDs are sorted and deduplicated. An empty array explicitly revokes all remote access; missing/null arrays are rejected. Versions are integers from 0 through 9007199254740991 (JavaScript's largest safe integer).

`EDGE_JWT` above is a fresh Worker-signed token with the claims documented below;
normal delivery is handled by the Worker's edge-sync coordinator.

- A higher version replaces the complete goal.
- An equal version with the same canonical set is an idempotent 204.
- An older version, or an equal version with different contents, returns 409, including after restart.

The cloud must allocate versions durably and monotonically in snapshot order. Read the current authorized set immediately before pushing and serialize reconciliation so a stale snapshot cannot receive a newer version. There is no freshness expiry: cloud outages retain the last goal indefinitely.

Diffs require `base_version` to match the stored goal and `version` to be a larger
safe integer. `add` and `remove` are required arrays of at most 512 nonzero uint32
IDs each; overlap is rejected. Arrays are canonicalized. The resulting set must
fit the 512-ID capacity. A repeated identical diff at the resulting version returns
204, including after restart; older, conflicting, or wrong-base diffs return 409.
Read the goal and reconcile again on a conflict. A diff before initialization
returns 503; bootstrap with PUT. PUT remains the nightly/manual full-resync API.

### Swipe delivery and history

Example `GET /api/swipes` response:

```json
[
  {
    "id": "edge-assigned-random-id",
    "time": "2026-09-13T12:00:00Z",
    "controller": "192.168.1.20",
    "fob": 7,
    "allowed": true
  }
]
```

Events are ordered by insertion, have stable random IDs across restarts, and use the peer IP rather than forwarding headers. Empty results are `[]`. Each fetch returns the complete retained history. The Worker polls and deduplicates by ID, writing to its database in bounded batches. Repeated fetches are harmless; there is no acknowledgment request or delivery state.

Each accepted controller batch is inserted in one SQLite transaction before returning 200 or 304. There is one local event store. Firmware retries can produce new IDs for the same physical swipe because the controller request has no event identifier.

All events remain in SQLite for **seven days from ingestion**, regardless of whether the Worker has fetched them. Delivery is best-effort: events missed before expiry are lost. Cleanup runs at startup, on successful nonempty controller batches, and on swipe fetches. On an idle service, expired history remains until the next cleanup but is never included in the next fetch.

Retention is time-based with no event-count cap. SQLite reuses deleted row space; the database file need not shrink after cleanup. Existing acknowledgment-based SQLite stores are upgraded in place: unexpired events keep their IDs and become available through the same history endpoint, while expired events are pruned.

To inspect local history with the optional SQLite CLI:

```sh
sqlite3 -readonly data/edge.db \
  "SELECT id, datetime(time / 1000000000, 'unixepoch'), controller, fob, allowed FROM swipes ORDER BY sequence DESC LIMIT 100;"
```

### Controller compatibility and signing

Controllers POST `[{"fob":123,"allowed":true}]` or `[]` (16 KiB, at most 512 swipes). Responses are sorted JSON arrays with a trailing newline, explicit `Content-Length` (no chunked encoding), and the existing unquoted SHA-256 ETag (hash of each decimal ID followed by a comma). An exact `If-None-Match` returns 304 **after committing swipes**. Local controller credentials remain independent of the cloud list. Database errors return an error so controllers retain their cache and retry.

Set `CONWAYEDGE_SIGNING_SEED=/secure/path/fob-signing.ed25519` to retain existing controller key pins. This is the legacy engine's **exactly 32 raw binary bytes**, not PEM, hex, base64, a 64-byte private key, or a newline-terminated file. Protect it with mode 0600. A configured missing, unreadable, or wrong-sized file prevents startup; edge never generates or replaces a key. The key is loaded once at startup.

`X-Fob-Signature` is padded standard base64 of the Ed25519 signature over the exact response body, including its newline. There is no timestamp, nonce, envelope, prehash, or signature on 304/error responses. With the variable unset, responses are unsigned; controllers with pinned keys require their physical-confirmation procedure to clear pins. Edge does not manage controller keys.

## Storage

`data/edge.db` is authoritative. One database connection serializes transactions, using WAL mode, `synchronous=FULL`, and a five-second busy timeout. The goal version and contents update together in one conditional SQL statement. Swipe batches are atomic. Printer configuration is stored as one JSON snapshot, committed before applying connection changes.

There is no in-memory goal/queue mirror, atomic-file replacement code, or separate recovery state. SQLite handles transaction rollback and crash recovery. Startup validates persisted goal and printer configuration and rejects unreadable/corrupt databases, including noncanonical goal JSON. Goals written through the API are always canonical; controller polls serve those stored bytes directly. Stop edge before copying its data directory for backup, or use SQLite's online backup facility. Do not copy only the database file while it is running: committed data may be in `edge.db-wal`.

## Worker JWT authentication

The Worker signs a fresh 60-second Ed25519 JWT for each machine API request and
sends `Authorization: Bearer <JWT>` through the existing HTTPS Tunnel. Edgeproxy
verifies the signature locally against the Worker's public JWKS. No Cloudflare
Access application, service token, or mTLS certificate is required.

### Setup

1. Generate a dedicated private key on a trusted machine, outside the repository:

   ```sh
   umask 077
   openssl genpkey -algorithm ED25519 -out edge-private.pem
   openssl pkey -in edge-private.pem -outform DER | openssl base64 -A
   ```

   Store the printed base64 PKCS#8 value as the Worker's `EDGE_JWT_PRIVATE_KEY`
   secret (`npx wrangler secret put EDGE_JWT_PRIVATE_KEY` from the repository root).
   Keep the private key out of the edge host and repository. The Worker derives its
   public JWK and RFC 7638 SHA-256 `kid` from this key automatically.
2. Set Worker `EDGE_URL` to the HTTPS edge origin, without a trailing slash.
   Deploy the Worker and confirm `https://thelab.ms/.well-known/edge-jwks.json`
   returns `{"keys":[...]}` with only public fields (`kty`, `crv`, `x`, `kid`,
   `alg`, `use`). The route is public and has a 60-second cache lifetime.
3. Configure edgeproxy and restart:

   ```sh
   export CONWAYEDGE_WORKER_ISSUER=https://thelab.ms
   export CONWAYEDGE_PUBLIC_URL=https://edge.example.com
   ```

   These must exactly match Worker `SITE_URL` and `EDGE_URL`. Set both or neither;
   partial/invalid configuration prevents startup. With neither set, machine APIs
   reject every request with 401 while the public dashboard remains available.
4. Route the edge hostname through cloudflared to the tunnel listener, with a
   catch-all `http_status:404`; forward `Authorization` without rewriting it.
   Remove old Access application/service-token requirements, cloudflared Access
   validation, and mTLS WAF requirements for this hostname when deploying the JWT
   verifier. Do not expose the LAN listener through the tunnel. Old
   `CONWAYEDGE_ACCESS_*` and `CONWAYEDGE_MEMBER_*` settings are no longer used.
5. Select admin **Full resync** to verify goal delivery and swipe reads. An anonymous
   `GET /api/swipes` must return 401; `GET /machines` must return 200.

### Verification and refresh

JWT headers require `alg: "EdDSA"`, `typ: "JWT"`, and a known `kid`. Claims require
the configured `iss` and `aud`, `sub: "edge-sync"`, `scope: "edge:api"`, integer
`iat`/`exp`, and a lifetime of at most 60 seconds. Future issuance/not-before and
expired tokens are rejected. Keep both hosts' clocks synchronized. These are bearer
tokens and can be replayed until expiry; do not log Authorization headers.

Edge fetches **only** `<CONWAYEDGE_WORKER_ISSUER>/.well-known/edge-jwks.json` over
verified HTTPS, without following redirects. Token-supplied key URLs are rejected.
A background loop fetches at startup and every five minutes, even with no API
traffic. Unknown key IDs or expired caches can trigger an additional fetch at most
once per minute. Requests fail closed until keys are available. Successful fetches
replace the key set; removed keys stop working, including before JWT expiry.

Fetch failures retain the last successful keys for at most one hour from that
fetch, without extending their lifetime. After that, authentication fails until
JWKS retrieval succeeds. Keys are cached in memory, so a restart during a JWKS
outage cannot authenticate API calls. Requests and refreshes share a lock; JWKS
HTTP requests have a five-second timeout and a 64 KiB response limit.

### Key rotation

`EDGE_JWT_PUBLIC_KEYS` is an optional JSON array of additional public Ed25519 JWKs,
stored as a Worker variable (default `"[]"`). Up to seven additional keys may be
published alongside the current signing key. Only `kty`, `crv`, and `x` are needed;
the Worker derives each `kid` and publishes public fields only.

1. Generate the next key as above. Export its public JWK with Node:

   ```sh
   node --input-type=module -e 'import {readFileSync} from "node:fs"; import {createPublicKey} from "node:crypto"; console.log(JSON.stringify(createPublicKey(readFileSync("edge-private.pem")).export({format:"jwk"})))'
   ```

2. Add the new public JWK to `EDGE_JWT_PUBLIC_KEYS` and deploy. Save the old public
   JWK from the JWKS response for the overlap period. Allow at least six minutes
   for HTTP caching plus periodic refresh, and confirm edge can fetch the new set.
3. Replace `EDGE_JWT_PRIVATE_KEY` with the new private key. Keep the old public JWK
   in `EDGE_JWT_PUBLIC_KEYS` during the switch; publish both public keys throughout.
4. After the old signing deployment has stopped and its last token's 60-second
   lifetime has passed, remove the old public JWK and deploy. Edge drops it on its
   next successful refresh. For urgent revocation, refresh/restart edge after the
   updated JWKS is visible; during an outage the one-hour cache bound still applies.

## Machines dashboard

The public Machines page displays configured 3D printers, including status and
camera snapshots. Set Worker `PRINTER_EDGE_URL` to the HTTPS edge origin so the
main site's `/machines` route redirects directly to `https://<edge-host>/machines`.
No Discord login, membership check, JWT cookie, or session renewal is needed.
The former `/machines/login`, `/machines/callback`, and `/machines/session` routes
are removed. Remove the obsolete Worker `PRINTER_JWT_PRIVATE_KEY` secret.

All `/machines` and `/machines/*` responses carry
`X-Robots-Tag: noindex, nofollow, noarchive`; dashboard HTML has matching robots
metadata. Crawlers must be allowed to fetch the page to see these directives;
they are indexing instructions, not access restrictions. The LAN listener does
not expose the dashboard. Keep Cloudflare caching disabled for machines responses.

### Printer configuration and display

Open `http://<LAN-address>:8080/`. Add each printer's name, literal IP address, access code, and unique serial number, then select **Save changes**. Add and Remove edit only the draft until saved. Validation errors preserve entered values. Remove every entry and save to clear the configuration. The form works without JavaScript and supports up to 32 printers. Access codes are masked inputs but present in the page. Changed/removed printers have their MQTT connections and cameras stopped; unchanged printers stay connected.

Enable Bambu LAN access. MQTT uses TLS on port 8883 with `bblp` and the access code; certificate verification is disabled for Bambu's self-signed certificates, so the printer network must be trusted. Status is requested every five seconds and partial reports are merged. The dashboard displays friendly status labels, remaining minutes/hours, last-report time, and a still image. Reports over 15 seconds old or connection errors show status unavailable and suppress the old time estimate. Before the first report it shows a waiting state. Empty printer configurations and unavailable cameras have explicit messages. Names are HTML-escaped; LAN addresses and access codes are never rendered in the member page.

Cameras use the RTSPS endpoint on port 322, `/streaming/live/1`. Models with a different camera protocol are unsupported. Each printer starts a local FFmpeg loop, producing one MJPEG frame every five seconds to match the dashboard refresh cadence and retaining only the latest complete JPEG in memory, even with no viewers. Failed or stalled processes retry after five seconds; 20 seconds without a complete frame terminates a stalled camera. Frames are capped at 8 MiB and discarded when the process stops.

Snapshot requests return one JPEG with `Content-Length` and `Cache-Control: no-store`. The dashboard fetches refreshed HTML cards and reloads still images every five seconds without reloading the whole page. Before the first frame, during reconnects, or when the latest frame is at least 20 seconds old, image requests immediately return 502. Image writes have five-second deadlines. Failed refreshes show a connection warning and hide old images while retrying. Credentials are hidden from HTTP errors/logs but present in FFmpeg process arguments. No printer-control endpoints are included.

## Verify

```sh
go test -race ./...
go vet ./...
go build .
node --test dashboard_test.mjs
```

Tests cover version ordering/restarts, atomic batch rollback, storage errors, concurrent ingestion/fetches, complete history reads, seven-day expiry, SQLite store upgrades, printer configuration reloads, listener/auth isolation, exact controller signing, and simulated camera processes. No FFmpeg, printers, Cloudflare, or root Conway module is required. This nested module is tested separately from Conway's root Go module.
