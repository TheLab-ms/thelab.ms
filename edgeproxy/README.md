# Edge proxy kiosk

The key-fob kiosk is served at `https://edge.thelab.ms/kiosk` on the **LAN
listener** (`-lan`, default `:80`). Local DNS and HTTPS termination should route
that hostname to this listener and preserve the request's Host header.
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
Durable Object before delivering it in an authenticated full goal update:

```json
{
  "version": 1,
  "fobs": [7, 42],
  "event_signing_key": "<64 lowercase hexadecimal characters>"
}
```

Edgeproxy persists this key atomically with the goal. Fob-only PATCH requests
preserve it; changing the key requires a higher-version full goal. The key is
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
and sends versioned diffs (or a full snapshot when necessary).

An alarm is armed when sync starts, before reading D1 or contacting edgeproxy.
Failed work retries after 60 seconds. Full snapshots retain their pending mode
and nightly date across retries. Once delivery catches up with D1, the alarm is
deleted: there is no periodic idle polling. An alarm from an older deployment
reconciles once and then follows the same retry-or-idle behavior.

This relies on post-commit notifications arriving. The existing nightly full
reconciliation at 1 AM America/Chicago is the backstop for missed notifications
and direct database edits. Swipe uploads run independently and do not arm sync
alarms.

## Operator full sync

Run the Wrangler commands below from the repository's `site/` directory.

Manual sync is available through the Cloudflare management API, rather than the
admin website. It sends the complete current authorized fob set and event signing
key; it does not re-fetch billing state or re-import delivered swipes.

1. Obtain the account ID with `npx wrangler whoami` and the ID of
   `thelab-membership` with `npx wrangler queues info thelab-membership`.
2. Set `ACCOUNT_ID`, `QUEUE_ID`, and `CLOUDFLARE_API_TOKEN` in your shell. The API
   token needs **Account → Queues → Edit** (`Queues Write`) for that account.
3. Start `npx wrangler tail thelab-ms --format pretty` in another terminal.
4. Publish the operator message:

   ```sh
   curl --fail-with-body --silent --show-error \
     "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages" \
     --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
     --header 'Content-Type: application/json' \
     --data '{"content_type":"json","body":{"type":"edge.sync","mode":"full"}}'
   ```

An API response with `success: true` means **queued**, not completed. Look for
`edge.full.completed` in the Worker logs to confirm delivery. `edge.failed` and
`queue.failed` report failures; the pending alarm and queue delivery retries
handle recovery. Repeating the command is safe: it sends another versioned full
snapshot. The installed Wrangler has no queue-publish command, so publication
uses the API directly.

Removing the admin sync action and idle watchdog requires only a Worker deploy;
there is no new D1 migration, queue, binding, or environment secret.
