# TheLab website and membership signup

Static landing/welcome pages and a small Cloudflare Worker. Signup uses Discord
identity, Stripe subscriptions, D1, one Durable Object per member, and a Cloudflare
Queue for Discord role reconciliation. There are **no scheduled triggers**.

## Flow

1. Choose monthly/yearly and a rate on the landing page. `/signup` redirects to
   Discord with `identify email` and browser-bound, expiring JWT state.
2. `/login/discord/callback` requires a verified email and existing membership in
    TheLab's Discord guild. Accounts are linked by Discord ID, never
   matched to a Stripe customer by email. OAuth tokens are not retained.
   The app issues signed JWTs in HttpOnly, SameSite=Lax cookies (Secure on HTTPS),
   valid for 24 hours for members. Discord returns an opaque access token, not an
   identity JWT; the browser stores only the app's JWT. No login sessions are stored
   in D1. OAuth state is signed with `AUTH_SECRET`, uses a separate `oauth` audience,
   and expires after 10 minutes. It carries the login purpose, billing selection,
   allowed return destination, and a hash of a random nonce in the HttpOnly
   `thelab_oauth` cookie. The callback verifies the JWT and cookie before contacting
   Discord and clears the cookie on success or failure. State is stateless: a copied
   JWT and its original cookie remain valid until expiry; Discord authorization
   codes are single-use.
3. Standard or approved-discount members go straight to Stripe Checkout. A
   discount request goes to `/membership-pending` until leadership approves it.
   Existing subscriptions, including past-due ones, go to Stripe Billing Portal.
4. `/payment/success` checks the signed-in user's Checkout ownership, completion,
   payment status, and subscription status against Stripe, then redirects to the
   static `/welcome` page. The welcome page itself is public and grants no access.
5. Verified Stripe webhooks enqueue customer IDs. The consumer fetches
   **current** Stripe subscriptions, then adds/removes the Discord member role.
   `active` and `trialing` grant membership, matching Conway. Scheduled cancellation
   retains the role until the subscription actually lapses. `past_due`, `unpaid`,
   paused and canceled subscriptions do not grant membership.

The implementation follows `../conway`'s `monthly`/`yearly` Stripe lookup keys,
coupon `metadata.discountTypes`, OAuth scopes/callback path, billing portal
behavior and role eligibility. It is a **standalone** membership store: it does
not update Conway records, waivers or door-access systems. New Stripe customers
and subscriptions carry `metadata.thelab_discord_id` and a stable
`metadata.thelab_member_id`; existing Conway customers
are not automatically imported or matched by email.

## Local development

Use Node 24 LTS (or a supported Node 22 release) and npm:

```sh
npm ci
npm run db:local
npm run dev
```

Create an ignored `.dev.vars` using `.dev.vars.example`. Set `AUTH_SECRET` to a
random secret of at least 32 bytes (generate
one with `openssl rand -hex 32`). Use the same secret across Worker instances;
rotating it invalidates main-site login and OAuth JWTs. Printer JWTs use a separate Ed25519 key. Use Discord development
credentials and a Stripe test-mode key. Register the exact Discord redirect
`http://localhost:8787/login/discord/callback`. Open `http://localhost:8787`, matching
`SITE_URL` exactly. Local Wrangler provides D1, Durable Objects and Queue emulation.

For local Stripe webhook delivery:

```sh
stripe listen --forward-to localhost:8787/webhooks/stripe
```

Use the printed signing secret for local `STRIPE_WEBHOOK_SECRET`. Local queue
consumers call real Discord/Stripe unless running the automated tests.

## Hero image assets

The landing page uses pre-rendered WebP/JPEG variants with responsive `srcset`
selection. After replacing `static/assets/streetview.jpg`, regenerate them with:

```sh
npm run images:hero
```

Commit the generated `static/assets/streetview-{width}.{webp,jpg}` files. They are
served directly as static assets, with no image processing needed at runtime.
The widths in the generator and the landing page's `srcset` lists must match;
the `sizes` values assume the original photo's 4:3 aspect ratio.

## Provider configuration

### Discord

Register `https://thelab.ms/login/discord/callback` in the OAuth application.
Invite its bot to the guild, grant **Manage Roles**, and place the bot's highest
role above the configured membership role. Set `DISCORD_GUILD_ID` and
`DISCORD_ROLE_ID` in `wrangler.jsonc`. Users must join the server themselves through
`https://discord.thelab.ms` before signup. No `guilds.join` scope is requested.

### Stripe

- Create active recurring Prices with lookup keys **`monthly`** and **`yearly`**,
  respectively recurring every one month/year. Set the intended annual amount in
  Stripe; the site does not assume an annual discount. The advertised standard
  monthly rate is $50 and discounted monthly rate is $25.
- Configure coupons with `metadata.discountTypes`, a comma-separated list of
  Conway category values: `student`, `retired`, `military`, `firstResponder`,
  `family`. Matching is case-insensitive. For example a recurring 50% coupon can
  have `student,retired,military,firstResponder,family`. Ensure its duration,
  applicable product and annual-rate behavior match your policy. A missing valid
  coupon blocks discounted checkout rather than charging full price.
- Enable Billing Portal with payment-method updates and cancellation. Configure
  any allowed price changes in the portal. Checkout uses cards for synchronous
  payment confirmation and creates no trials itself.
- Register `https://thelab.ms/webhooks/stripe` with payload API version
  **`2024-06-20`** and these events:
  - `customer.subscription.created`, `.updated`, `.deleted`
  - `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed`
   - `invoice.paid`, `invoice.payment_failed`
   - `customer.updated` (refreshes billing name/email)
- Use credentials and prices/coupons from the same Stripe account and mode.

## Deployment

Provision resources once:

```sh
npx wrangler d1 create thelab-membership
npx wrangler queues create thelab-membership-failed --message-retention-period-secs 1209600
npx wrangler queues create thelab-membership --message-retention-period-secs 1209600
```

Replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` with the resulting ID.
The 14-day queue retention above requires a paid plan; free-tier queues allow at
most 86400 seconds. Use the retention supported by your account and monitor failed
deliveries before that period elapses.
Set the canonical `SITE_URL` (origin only, no trailing slash), Discord guild and
role IDs. Configure a Workers custom domain for that origin. Add secrets:

```sh
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put AUTH_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler d1 migrations apply thelab-membership --remote
npx wrangler deploy --dry-run
npm run deploy
```

The existing `make dev` and `make deploy` commands still work. Assets are served
directly; signup, callback, payment and webhook paths run through the Worker first.

## Member machines dashboard

The standalone [`edgeproxy`](edgeproxy/README.md) serves a member-facing dashboard at
`https://<edge-host>/machines` with 3D printer status, remaining print time, and still
images refreshing every five seconds. Main-site `/machines` is a shortcut into its
sign-in flow. The browser talks directly to edgeproxy for page and image requests.

Set `PRINTER_EDGE_URL` to the HTTPS edge origin in `wrangler.jsonc`, and store the
dedicated base64 PKCS#8 Ed25519 private key with
`npx wrangler secret put PRINTER_JWT_PRIVATE_KEY`. Configure the corresponding
public key, issuer, and public origin on edgeproxy. See the edge README for key
generation and Cloudflare WAF path exceptions.

The Worker reuses Discord/member login and grants printer JWTs only when the
authenticated member's current D1 subscription state is `active` or `trialing`.
Printer JWTs have a five-minute lifetime, an edge-specific audience, and an
active-member/read-scope claim. A nonce-bound browser handoff establishes an
HttpOnly cookie on the edge host. Edge verifies every dashboard/image request.
Automatic renewal rechecks D1; membership changes take effect within five minutes
after Stripe webhook/queue reconciliation updates the database.

## Member administration and discount approval

Set `DISCORD_ADMIN_ROLE_ID` in `wrangler.jsonc` (or `.dev.vars` locally) to the
numeric Discord role ID that grants leadership/admin access. Open **`/admin`**
to enter Discord sign-in directly. Admin access is disabled until that role is configured.
The bot checks the user's current guild roles on every member list, detail, and
save request. Removing the role immediately removes access. Admin sign-in uses
the existing Discord callback URL, with an eight-hour admin JWT, and does
not register a member or start checkout. Member JWTs cannot authorize admin requests.
Expired or missing credentials enter Discord OAuth directly and return to the
requested admin page or payment operation. Role-denied requests return an error.
Use **Sign out** to clear the admin cookie and return home. A separately copied
JWT remains valid until expiry; logout does not maintain a server-side revocation list.

The list includes all members registered in this app, including pending and
inactive members, in pages of 25 ordered newest first. Open a member to view IDs,
registration and sync timestamps, and last-synced subscription status, and edit:

- Name override and internal notes. Member names always use **name override →
  Stripe billing name → Discord username** (the first nonblank value).
- Discord ID and Stripe customer/subscription IDs. The subscription must belong
  to the customer; accounts/customers already linked to another member are rejected.
- Saved monthly/yearly billing cycle, discount category, and approval status.

Discord username/email and Stripe billing name/email are read-only. Discord sign-in
refreshes the Discord fields; Stripe reconciliation refreshes billing details from
the Customer, including on `customer.updated`. Checkout saves the entered billing
name to the Stripe Customer. Existing billing fields populate on the next Stripe
event or a manual queue resync.

Changing Discord ID fetches the new guild account's username, clears the previous
Discord email until the new account signs in, increments the member's auth version
to invalidate old member JWTs (even if the Discord ID is later restored),
and removes the old account's membership role. Memberships retain their stable
internal ID and Durable Object. Identity edits tag the linked Stripe customer and
membership subscriptions with the current identity and enqueue role reconciliation.
Automatic subscription selection remains enabled: a manually entered subscription
ID may be replaced by the next sync, which prefers active/trialing subscriptions,
then ongoing subscriptions, then the most recently created canceled subscription.

For a discount request, verify the member's numeric Discord ID and eligibility,
then select **Approved** or **Denied** for the requested category and save. Use
**None** with the standard rate. Family eligibility remains leadership's judgment.
Requests do not send automated notifications, so check the list regularly.

Tell the member to click **Check approval & continue** on the pending page or use
`/payment/resume`. If needed it signs them in directly, then resumes their saved
selection without another OAuth round-trip. Alternatively, send a signup URL preserving
the saved selection, such as `/signup?billing=yearly&discount=student`. Choosing
a different category creates a new request; choosing standard rate clears it.
Denied requests remain denied when retried with the same category.

Pricing edits apply to future Checkout; manage existing prices and invoices in
Stripe. Saving changed billing/discount metadata or identity mappings
expires any outstanding Checkout link through the member's serialized Durable
Object. If Stripe cannot resolve or expire that link, the save fails and keeps
the entered fields for retry. Completed Checkout subscriptions are left intact.
Concurrent profile/billing edits are rejected with a reload message so stale
forms cannot silently overwrite newer changes. Subscription status and sync
timestamps are read-only; role eligibility is always reconciled against Stripe.

The initial migration includes the admin schema and stores the latest Stripe state
in `members`, with no OAuth state or Stripe event tables. No upgrade migration is
needed for this undeployed app.
For a local database created with the old schema,
recreate the disposable local D1 database and run `npm run db:local` before use.

## Queue delivery and recovery

The webhook only acknowledges Stripe after `MEMBERSHIP_QUEUE.send()` succeeds.
No database receipt is written before enqueueing, so a failed send remains
retryable by Stripe. Queue jobs serialize with checkout per stable membership ID, retrieve
current Stripe state, and use idempotent Discord PUT/DELETE operations. Duplicate
deliveries repeat reconciliation safely; no event IDs are stored. Jobs are
acknowledged **after** Discord succeeds, even if the saved Stripe state already
matches, so failed role updates are retried.
Unrelated Stripe customers and subscriptions without this app's metadata are ignored,
unless explicitly linked by an admin.

Failures use exponential backoff, honor Discord/Stripe retry delays, and move to
`thelab-membership-failed` after 20 retries. Monitor failed messages in the
Cloudflare Queues dashboard and Worker logs. After fixing configuration, provider
permissions, or having the user rejoin Discord, replay failed messages using
Cloudflare Queues' message pull/ack and push APIs (or dashboard controls):

1. Pull from `thelab-membership-failed` without acknowledging yet.
2. Push the same JSON body to `thelab-membership` and verify acceptance.
3. Acknowledge the original dead-letter message only after the push succeeds.

Messages contain `{ "customer_id": "cus_..." }`. For an explicit current-state
resync, push the same body to the main queue. This also repairs roles after a member
leaves/rejoins Discord or a role is changed manually. With no cron or Discord gateway
listener, those Discord-only changes need a manual resync or the next Stripe event.

Admin identity edits enqueue `{ "member_id": "<stable internal ID>" }`, which
resolves the current customer and Discord account inside the membership lock.

Stripe writes have durable idempotency records in the member Durable Object.
Ambiguous writes older than 23 hours stop for review instead of risking a duplicate
charge after Stripe expires its idempotency key. Inspect the customer's sessions
and subscriptions in Stripe before repairing such an operation; retain both D1
and Durable Object storage during deployments. Do not delete member/customer
mappings while subscriptions are in use.

## Worker source layout

- `src/index.js`: HTTP routing, OAuth/payment flows, webhooks, and queue delivery.
- `src/membership.js`: explicit member registration and stable-member-ID Durable
  Object RPC. Checkout, login profile refreshes, admin edits, and reconciliation
  share a promise-chain lock, including across provider requests. RPC failures
  carry an explicit status, retry delay, and error ID.
- `src/membership-policy.js`: discount categories, access eligibility, and current
  subscription selection.
- `src/providers.js`: bounded provider HTTP, Stripe/Discord APIs, Discord identity
  exchange, and Stripe signature verification.
- `src/auth.js` and `src/encoding.js`: login tokens, browser-bound OAuth state,
  cookies, and shared JWT encoding.
- `src/admin.js`, `src/admin-views.js`, and `src/member-metadata.js`: admin request
  handling, HTML rendering, and editable-field validation.
- `src/printers.js`: member authorization and the edge JWT handoff.
- `src/http.js` and `src/logging.js`: HTTP utilities and redacted diagnostics.

Discord and Stripe IDs are resolved at request/queue boundaries. Internal member
operations use the immutable `member_id`; identity-sensitive calls recheck the
expected Discord account or Stripe customer inside the lock.

## Error logging

Workers observability is enabled in `wrangler.jsonc`. For live diagnostics, run
`npx wrangler tail --format json`, or open the Worker's **Observability → Logs**
in Cloudflare. Local errors appear in the `npm run dev` terminal. Include warning
logs when investigating rejected sign-ins/forms (4xx); operational failures (5xx)
are logged at error level.

Structured events cover provider calls (`provider.failed`), HTTP requests,
admin access/saves, Durable Object operations, and queue deliveries. They include
the operation/path, status, error ID, and stack/cause for unexpected exceptions.
Matching `error_id` values connect provider/DO failures to the calling request or
queue delivery. Request errors also include a generated `request_id`; queue
failures include message ID, attempt, and retry delay.

For Discord login failures, inspect `provider.failed` for the endpoint
(`/api/v10/oauth2/token`, `/api/v10/users/@me`, or the guild member lookup),
failure kind (`transport`, `redirect`, `http`, `invalid_response`), elapsed time,
and upstream HTTP status. Transport failures retain the underlying exception;
401/403 upstream responses indicate credentials/access need investigation, and
429 includes the provider retry delay. Provider redirects are rejected rather
than followed, so credentials stay on the intended host.

Application logs omit request headers/bodies, URL queries, and provider response
bodies. Configured secrets and common credential patterns are redacted from
exception diagnostics. Do not add raw OAuth payloads or member edit fields to logs.

## Verification

```sh
npm test
npx wrangler deploy --dry-run
```

Tests run in workerd with real local D1 and Durable Objects and mocked provider
HTTP. They cover OAuth/browser state, approval and pricing rules, serialized
checkout/idempotency, success verification, signed webhooks, queue failure/retry,
duplicate delivery and current-state role reconciliation. Finish provider setup
with a Stripe test-mode signup, cancellation, discount approval and Discord role
check before using live credentials.

The `sharp` override keeps the test runtime's transitive image dependency on its
patched release; the membership Worker itself has no third-party runtime packages.
