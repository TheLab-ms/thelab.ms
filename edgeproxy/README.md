# Printer monitoring

The printer dashboard lives at **`https://thelab.ms/machines`** on the Worker.
Discord sign-in is required. The page and every `/machines/data` token request check
the current D1 access policy: non-billable members, or legacy-billing / active /
trialing members with a signed waiver. Session identity and eligibility are read
in one D1 query. An assigned key fob is not required. `/machines/data` returns
only the edge origin and a scoped token, without contacting the edge.

The tunnel listener exposes printer data, not dashboard HTML:

- `GET /api/printers`: names, status, remaining time, report time, and image paths;
  accepts a `printers:read` JWT (and the Worker's privileged `edge:api` JWT for
  rollout compatibility). Credentials, internal errors, and LAN addresses are
  never included. Browsers fetch and validate this JSON directly from the edge.
- `GET /machines/images/{serial}.jpg`: latest JPEG frame; requires a
  `printers:read` JWT in the Authorization header. Browsers fetch these directly
  from the edge and display blob URLs. The Worker never fetches image bytes.
- Status and image CORS preflights allow `GET` and `Authorization` only from
  `CONWAYEDGE_WORKER_ISSUER`. Requests still require a valid token; requests with
  another Origin are rejected. No cross-origin cookies are used.

The Worker issues a new read-only status/image token after each successful
eligibility check. Visible tabs renew around **45 seconds**, while status and
images refresh every **5 seconds**. Hidden tabs cancel in-flight requests and
pause timers; on return they refresh immediately, renewing first when due or
expired. Page lifecycle transitions clear images and prevent late responses
from restoring stale content. Tokens use the existing Ed25519 signing key and JWKS,
are audience-bound to the edge origin, and expire after **60 seconds**. Existing
tokens can remain usable for **at most 60 seconds** after membership or session
access is revoked, for both status and images;
further renewals are denied. Printer tokens cannot access goal or kiosk APIs.
Tokens stay in browser memory and Authorization headers, never query strings or
browser storage. Protected responses use `Cache-Control: no-store`.

## Configuration and rollout

- Worker `EDGE_URL` and edge `CONWAYEDGE_PUBLIC_URL` must be the same HTTPS origin
  (normally `https://edgeproxy.thelab.ms`). `PRINTER_EDGE_URL` is removed.
- Edge `CONWAYEDGE_WORKER_ISSUER` must match Worker `SITE_URL` exactly
  (normally `https://thelab.ms`), including for CORS.
- Reuse `EDGE_JWT_PRIVATE_KEY` and the Worker's `/.well-known/edge-jwks.json`.
  No new secrets or database migrations are required.
- Deploy the rebuilt edge proxy first so `/api/printers` accepts scoped browser
  tokens and CORS, then deploy the Worker and its matching static assets. The
  edge retains privileged status reads for the previous Worker during rollout.
  Already-open dashboards using the previous script need a page reload when
  `/machines/data` switches to the token-only response.

Verify that an eligible member can open `/machines`, that browser network tools
show status JSON and JPEG requests going directly to the edge with Bearer
authorization, with `/machines/data` called around every 45 seconds. Anonymous
status/image requests return `401`; ineligible members receive `403` from the
Worker. Verify hidden tabs stop requests and resume after token expiry. Access
denial clears the dashboard; connection failures and expiry hide stale content.

Run the browser tests from `site/` with `npm run test:browser`, the Worker tests
with `npm test`, and edge tests from `edgeproxy/` with `go test -race ./...` and
`node --test app_test.mjs`.

# Edge proxy kiosk

The key-fob kiosk is served at `http://edge.thelab.ms/kiosk` on the **LAN
listener** (`-lan`, default `:80`). Local DNS should point that hostname to the
edge proxy's LAN address.
`https://thelab.ms/kiosk` redirects to this LAN-only URL.

The public Cloudflare tunnel at `https://edgeproxy.thelab.ms` continues to use
the **secured listener** (`-tunnel`, default `:8080`). It exposes the
Worker-authenticated `GET /api/kiosk/claim?token=…` lookup; kiosk assets and
scan issuance are available only on the LAN listener.

## Enrollment

1. The HID reader submits a fob to the LAN kiosk. The proxy stores a random,
   five-minute enrollment token in SQLite and generates a QR code locally.
2. The phone opens the QR's `/keyfob/bind` link on the membership Worker. The
   Worker retrieves the fob through the authenticated tunnel and records the
   verified claim in D1.
3. The member signs in through Discord and confirms linking. D1 atomically
   consumes the claim and assigns the fob, preserving ownership checks and
   replay protection.
4. Completion is shown on the phone. The kiosk keeps the QR code displayed
   until reset, the next fob scan, or the code's five-minute expiry.

The existing `CONWAYEDGE_WORKER_ISSUER` supplies the membership site's HTTPS
origin for QR links. `CONWAYEDGE_PUBLIC_URL` remains
the public tunnel origin used as the Worker JWT audience. No new secret or
kiosk IP-check configuration is needed.

## Rollout

Deploy the rebuilt edge proxy first, then deploy the Worker. The edge SQLite
table is created automatically at startup; the Worker uses the existing D1
`fob_claims` table. Previously displayed kiosk QR codes should be replaced by
a fresh scan after the rollout.

On the local network, open `https://thelab.ms/kiosk`, scan a fob, then use a
phone to sign in and link it. Confirm that the kiosk returns to its ready
screen with “Fob linked.”

# Fob event delivery

Controllers post swipe events to the LAN `POST /api/fobs` endpoint. Edgeproxy
commits the entire batch to SQLite before replying, then asynchronously pushes
events to `${CONWAYEDGE_WORKER_ISSUER}/webhooks/edge/swipes`.
Controller requests accept up to 512 swipes within a 32 KiB JSON body.

- The first batch after idle is sent immediately. During activity, accumulated
  events flush every 30 seconds; arrivals do not reset the deadline.
- A flush snapshots the pending backlog and sends sequential requests of at most
  512 events (256 KiB request limit). New arrivals wait for the next flush.
- Only a Worker `204` marks a batch delivered. Failures retry after 30 seconds;
  startup immediately checks for pending events. Stable event IDs make retries
  safe even if the Worker committed a request whose response was lost.
- Undelivered events do not expire. Delivered local history is retained for seven
  days and cleaned up during writes, startup, and flushes.

## Goal state and authentication

The Worker generates and persists a random 32-byte HMAC key in its `EdgeSync`
Durable Object before delivering it in an authenticated `PUT /api/goal` snapshot:

```json
{
  "version": 1,
  "fobs": [7, 42],
  "event_signing_key": "<64 lowercase hexadecimal characters>"
}
```

Every snapshot includes the complete authorized fob set (at most 512 IDs) and
the signing key. Edgeproxy persists the version, fobs, and key atomically before
returning `204`. Repeating the same version with the same normalized fob set and
key is idempotent, including after restart. Older versions or different contents
at the same version return `409`; changing the key requires a higher version.
Versions are nonnegative safe integers, up to 9007199254740991. The key is
returned only by the authenticated goal API, never in controller responses.
It is separate from the Ed25519 key used to sign controller fob lists.

Push requests contain the existing JSON event array (`id`, `time`, `controller`,
`fob`, `allowed`) and these headers:

- `X-Edge-Timestamp`: current Unix time in seconds, refreshed for each attempt.
- `X-Edge-Signature`: lowercase hex HMAC-SHA256 using the decoded goal key over:

```text
POST\n/webhooks/edge/swipes\n<timestamp>\n<exact request body bytes>
```

The Worker accepts timestamps within five minutes of its clock, verifies the
signature before importing events, validates the complete batch, and returns
`204` only after all events have been persisted. Event-ID deduplication also
protects against replay within the timestamp window. Ownership is resolved at
the event's original timestamp.

## Upgrade

Deploy the Worker and edgeproxy, then request an [operator full sync](#operator-full-sync)
to deliver the full goal and signing key immediately (the next reconciliation also provisions it).
No additional environment secret or D1 migration is required. Edgeproxy upgrades
its SQLite schema automatically and queues retained history for delivery.

Manual/nightly sync now reconciles goal state only. The old edgeproxy
`GET /api/swipes` pull endpoint has been removed.

# Access-list synchronization

Billing updates, admin edits/deletions, waiver signatures, and fob assignments
notify EdgeSync immediately after committing to D1. EdgeSync serializes delivery
and exclusively sends versioned full `PUT /api/goal` snapshots. A change notification
whose D1 revision is already acknowledged goes idle without network traffic;
operator and nightly full syncs force delivery even when that revision is unchanged.

Before each delivery, authenticated `GET /api/goal` reads the committed remote
version (`503` means no goal has been received). EdgeSync then reads the D1 revision
and authorized fobs together and persists a version greater than both the remote
version and its last local attempt before sending the snapshot. Only a `204`
acknowledges that D1 revision. Lost responses and conflicts retry by reading remote
state again and sending a fresh higher-version snapshot; changes committed during
delivery remain pending.

An alarm is armed when sync starts, before reading D1 or contacting edgeproxy.
Failed work retries after 60 seconds. Operator and scheduled syncs use the same
durable forced-sync operation: the pending flag survives failures and restarts
until remote delivery succeeds, and ordinary notifications cannot downgrade it.
Successful forced delivery logs `edge.full.completed` (without a date).
Once delivery catches up with D1, the alarm is
deleted: there is no periodic idle polling. An alarm from an older deployment
reconciles once and then follows the same retry-or-idle behavior.

This relies on post-commit notifications arriving. Daily full reconciliation at
**07:00 UTC (1 AM CST / 2 AM CDT)** is the backstop for missed notifications and
direct database edits. The same schedule cleans up expired fob claims, including
when edge sync is disabled. There is no local-date deduplication; repeated scheduled
invocations safely deliver another higher-version snapshot. Swipe uploads run
independently and do not arm sync alarms.

Existing `fullPending` objects (with a nightly date or `null`) recover as forced
work, even when `nightlyDone` already records that date. They are normalized to a
boolean before retrying. Successful reconciliation removes the pending marker
and obsolete `nightlyDone` key; no storage reset or migration is required.

For the snapshot-only protocol upgrade, roll out the Worker before edgeproxy:
the existing edge accepts full PUTs. Edgeproxy removes the PATCH route and drops
the obsolete `goal_patch` replay table automatically at startup, preserving the
committed goal, version, signing key, and swipe history. No D1 migration is needed.

## Operator full sync

From the repository root, schedule a full sync with:

```sh
bash site/scripts/resync-edge.sh
```

The script uses the installed Wrangler to discover the account and
`thelab-membership` queue, then publishes through the management API. It reuses
your `wrangler login` OAuth credentials or `CLOUDFLARE_API_TOKEN`; the credential
must have Queues Write permission. Set `ACCOUNT_ID` (or `CLOUDFLARE_ACCOUNT_ID`)
when you have multiple accounts; `QUEUE_ID` can also be supplied explicitly.
Start the log tail below **before** running the script to confirm completion.
