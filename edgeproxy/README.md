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
4. The kiosk polls its LAN endpoint, which reads the Worker's token-only
   `/keyfob/status` endpoint for completion. An unvisited code reports pending;
   no member or fob details are exposed by that endpoint.

The existing `CONWAYEDGE_WORKER_ISSUER` supplies the membership site's HTTPS
origin for QR links and completion polling. `CONWAYEDGE_PUBLIC_URL` remains
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
