# conwayedge

A standalone Go HTTP service for LAN access controllers and Bambu printer status/cameras. The cloud computes authorized fob IDs and pushes a complete versioned snapshot. Edge persists access permissions, printer configuration, and swipes in SQLite; it does no cloud polling or membership business logic.

## Run

Requires Go 1.25+ and `ffmpeg` on PATH for cameras. SQLite uses the pure-Go `modernc.org/sqlite` driver; no C compiler or system SQLite library is needed.

```sh
go build .
./conwayedge -lan 192.168.1.10:8080 -tunnel 127.0.0.1:8081 -data ./data
```

Defaults: `-lan :8080`, `-tunnel 127.0.0.1:8081`, `-data data`. Run one instance per data directory on a local filesystem, as an unprivileged user. New directories use mode 0700 and the database uses 0600. Protect existing directories equivalently: the database contains printer access codes.

Point controllers at the LAN listener. Its configuration page at `/` is unauthenticated and trusts the LAN; saves require the page's CSRF token. Point cloudflared **only** at the tunnel listener, which must bind loopback because it trusts certificate-status headers from local cloudflared. Machine APIs require mTLS; member printer routes validate Worker-issued JWTs using a public key.

### Switching from file-backed edge

This is a fresh-start storage and cloud-API change. Drain any pending swipes you need from the old service, stop it, and start this version with a **new data directory**. Reconfigure printers and push the current goal. `goal.json`, `printers.json`, `swipe-spool.json`, and `swipes.jsonl` are not imported or used. Worker callers must adopt the API below.

Controller firmware keeps its existing protocol and optional signing identity. Before the first goal is received, controller requests return 503 so controllers retain their own cache.

## API

| Listener | Endpoint | Contract |
| --- | --- | --- |
| Tunnel | `PUT /api/goal` | `{"version":123,"fobs":[7,42]}`; 204 after persistence, 409 for older/conflicting versions. |
| Tunnel | `GET /api/swipes` | JSON array of all events retained from the last seven days; does not consume them. No pagination parameters. |
| Tunnel | `GET /machines` | Active-member machines dashboard; status and images refresh every five seconds. |
| Tunnel | `GET /machines/content` | Protected HTML printer cards used by the dashboard refresh. |
| Tunnel | `GET /machines/images/{serial}.jpg` | Protected current JPEG; 404 unknown printer, 502 camera unavailable. |
| LAN | `POST /api/fobs` | Controller swipe array in; authorized ID array or 304 out. |
| LAN | `GET /`, `POST /` | Printer configuration form. |

Cloud responses have `Cache-Control: no-store`. JSON mutations have a 16 KiB body limit and reject unknown fields and trailing values. Validation errors return 400. Storage failures return 500; no goal returns 503. Retry failed requests. The old `POST /api/goal`, `/api/goal/versioned`, `/api/swipes/ack`, `/api/printers`, `/api/printers/{serial}/snapshot.jpg`, and `/machines/stream/{serial}` APIs are removed.

### Access goal

```sh
curl --fail-with-body --cert client.pem --key client.key \
  -X PUT https://edge.example.com/api/goal \
  -H 'Content-Type: application/json' \
  --data '{"version":123,"fobs":[7,42]}'
```

Send at most 512 nonzero unsigned 32-bit IDs. IDs are sorted and deduplicated. An empty array explicitly revokes all remote access; missing/null arrays are rejected. Versions are integers from 0 through 9007199254740991 (JavaScript's largest safe integer).

- A higher version replaces the complete goal.
- An equal version with the same canonical set is an idempotent 204.
- An older version, or an equal version with different contents, returns 409, including after restart.

The cloud must allocate versions durably and monotonically in snapshot order. Read the current authorized set immediately before pushing and serialize reconciliation so a stale snapshot cannot receive a newer version. There is no freshness expiry: cloud outages retain the last goal indefinitely.

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

There is no in-memory goal/queue mirror, atomic-file replacement code, or separate recovery state. SQLite handles transaction rollback and crash recovery. Startup validates persisted goal and printer configuration and rejects unreadable/corrupt databases. Stop edge before copying its data directory for backup, or use SQLite's online backup facility. Do not copy only the database file while it is running: committed data may be in `edge.db-wal`.

## Cloudflare API Shield mTLS setup

1. Create a client certificate under **SSL/TLS → Client Certificates**, retain its private key for the calling client, and enable mTLS for the tunnel's public hostname (for example, `edge.example.com`).
2. Deploy an API Shield/WAF custom rule with action **Block** for the hostname **except `/machines` and `/machines/*`**, which use member JWTs. Restrict controller API access to the intended client certificate(s), for example:

   ```txt
    (http.host eq "edge.example.com" and
      not (http.request.uri.path eq "/machines" or starts_with(http.request.uri.path, "/machines/")) and
     (not cf.tls_client_auth.cert_verified or
      cf.tls_client_auth.cert_revoked or
      not (cf.tls_client_auth.cert_fingerprint_sha256 in {"<CLIENT_CERT_SHA256>"})))
   ```

   Replace the placeholder with the certificate's fingerprint in Cloudflare's field format. During rotation, allow both fingerprints, migrate callers, then remove/revoke the old certificate. This rule provides client authorization; edge accepts any verified, non-revoked certificate forwarded by Cloudflare.
3. Enable the **Add TLS client auth headers** managed transform under **Rules → Settings → Managed Transforms**. Cloudflare must overwrite client-supplied values on every request. Machine APIs require exactly `Cf-Cert-Presented: true`, `Cf-Cert-Verified: true`, and `Cf-Cert-Revoked: false`. Missing, malformed, duplicate, unverified, or revoked status is rejected with 401. Member JWTs do not grant machine API access, and mTLS does not grant printer access.
4. Route only the protected hostname to `http://127.0.0.1:8081`, followed by a catch-all `http_status:404` ingress rule. The flow is **client certificate → Cloudflare API Shield → tunnel → local HTTP origin**. Edge trusts the local host/cloudflared; these headers are trusted-proxy assertions.

**Worker transport limitation for machine APIs:** Cloudflare documents that [Worker mTLS certificate bindings cannot call Cloudflare-proxied services](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) (they return 520). A tunnel hostname is Cloudflare-proxied. A Worker coordinator therefore needs a transport capable of presenting the certificate to API Shield, such as a separately hosted mTLS-capable relay. That transport is outside this module. The machines dashboard uses direct browser requests with JWT cookies and does not need this relay.

References: [API Shield mTLS configuration](https://developers.cloudflare.com/api-shield/security/mtls/configure/), [TLS client auth managed headers](https://developers.cloudflare.com/rules/transform/managed-transforms/reference/#add-tls-client-auth-headers).

## Machines dashboard

The member-facing Machines page currently displays configured 3D printers.

### Member access setup

Generate a dedicated Ed25519 key pair on a trusted machine:

```sh
openssl genpkey -algorithm ED25519 -out printer-private.pem
openssl pkey -in printer-private.pem -outform DER | openssl base64 -A
openssl pkey -in printer-private.pem -pubout -outform DER | openssl base64 -A
```

The first base64 value is the PKCS#8 private key: store it as the Worker's `PRINTER_JWT_PRIVATE_KEY` secret (`npx wrangler secret put PRINTER_JWT_PRIVATE_KEY` from the repository root). The second is the SPKI public key, for edgeproxy. Keep the private key in secure storage and out of the edge host/repository.

Set the Worker's `PRINTER_EDGE_URL` to the HTTPS edge origin (for example `https://edge.example.com`) in `wrangler.jsonc`. Set these edge environment variables and restart:

```sh
export CONWAYEDGE_MEMBER_ISSUER=https://thelab.ms
export CONWAYEDGE_PUBLIC_URL=https://edge.example.com
export CONWAYEDGE_MEMBER_PUBLIC_KEY='<base64 SPKI public key>'
```

Origins must match the Worker `SITE_URL` and `PRINTER_EDGE_URL` exactly, with no trailing slash. Use HTTPS; the browser session requires Secure cookies. Leaving all three edge settings unset disables member routes with 503; partial/invalid settings prevent startup. Updating the public key invalidates previously issued printer sessions.

Members can open `https://edge.example.com/machines` directly or follow `/machines` on the main site. Edge creates a ten-minute random HttpOnly nonce cookie and redirects to the Worker's `/machines?state=…`. The Worker uses existing Discord sign-in and reads the authenticated member's current D1 record. Only `active` or `trialing` subscription states grant access. It signs a five-minute EdDSA JWT with `active_member: true`, `scope: "printers:read"`, Discord subject, issuer, edge-origin audience, timestamps, and nonce.

The Worker redirects to the fixed `/machines/callback` with the JWT in a URL fragment. The callback clears the fragment immediately and POSTs it to `/machines/session`; edge validates the signature, claims, same-origin request, and browser nonce before setting a Secure, HttpOnly, SameSite=Lax, host-only `__Host-thelab_printers` cookie and clearing the nonce. Tokens are never put in query strings. The callback, login, session, and JavaScript routes are public handoff resources; dashboard HTML, refresh content, and images require a valid member JWT on every request. The LAN listener does not expose these routes.

Thirty seconds before expiry, the dashboard makes a top-level round-trip through the Worker to recheck membership and renew the session. This works with third-party cookies blocked. An expired main-site session requires Discord sign-in again. Revocation takes effect within five minutes **after D1 reflects the change**; the existing Stripe webhook/queue sync supplies that status. The edge does not query Stripe or D1. A copied JWT remains valid until expiry.

Apply the WAF path exception described above before opening the dashboard. Do not configure Cloudflare to cache member responses or require browser client certificates on printer routes.

### Printer configuration and display

Open `http://<LAN-address>:8080/`. Add each printer's name, literal IP address, access code, and unique serial number, then select **Save changes**. Add and Remove edit only the draft until saved. Validation errors preserve entered values. Remove every entry and save to clear the configuration. The form works without JavaScript and supports up to 32 printers. Access codes are masked inputs but present in the page. Changed/removed printers have their MQTT connections and cameras stopped; unchanged printers stay connected.

Enable Bambu LAN access. MQTT uses TLS on port 8883 with `bblp` and the access code; certificate verification is disabled for Bambu's self-signed certificates, so the printer network must be trusted. Status is requested every five seconds and partial reports are merged. The dashboard displays friendly status labels, remaining minutes/hours, last-report time, and a still image. Reports over 15 seconds old or connection errors show status unavailable and suppress the old time estimate. Before the first report it shows a waiting state. Empty printer configurations and unavailable cameras have explicit messages. Names are HTML-escaped; LAN addresses and access codes are never rendered in the member page.

Cameras use the RTSPS endpoint on port 322, `/streaming/live/1`. Models with a different camera protocol are unsupported. Each printer starts a local FFmpeg loop, transcoding to 15 fps MJPEG and retaining only the latest complete JPEG in memory, even with no viewers. Failed or stalled processes retry after five seconds; 20 seconds without a complete frame terminates a stalled camera. Frames are capped at 8 MiB and discarded when the process stops.

Snapshot requests return one JPEG with `Content-Length` and `Cache-Control: no-store`. The dashboard fetches refreshed HTML cards and reloads still images every five seconds without reloading the whole page. Before the first frame, during reconnects, or when the latest frame is at least 20 seconds old, image requests immediately return 502. Image writes have five-second deadlines. Failed refreshes show a connection warning and hide old images while retrying. Credentials are hidden from HTTP errors/logs but present in FFmpeg process arguments. No printer-control endpoints are included.

## Verify

```sh
go test -race ./...
go vet ./...
go build .
node --test dashboard_test.mjs
```

Tests cover version ordering/restarts, atomic batch rollback, storage errors, concurrent ingestion/fetches, complete history reads, seven-day expiry, SQLite store upgrades, printer configuration reloads, listener/auth isolation, exact controller signing, and simulated camera processes. No FFmpeg, printers, Cloudflare, or root Conway module is required. This nested module is tested separately from Conway's root Go module.
