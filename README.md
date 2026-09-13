# TheLab website and membership signup

Static landing/welcome pages and a small Cloudflare Worker. Signup uses Discord
identity, Stripe subscriptions, D1, one Durable Object per member, and a Cloudflare
Queue for Discord role reconciliation. A nightly scheduled job backs up edge
swipes and reconciles door-access fobs.

## Flow

1. Choose monthly/yearly billing on the landing page. `/signup` redirects to
   Discord with `identify email` and browser-bound, expiring JWT state.
2. `/login/discord/callback` requires a verified email and existing membership in
    TheLab's Discord guild. Existing accounts are resolved by Discord ID. A first
   login claims an unlinked waiver-only member with the same normalized, verified
   email. Stripe customers are never matched by email. OAuth tokens are not retained.
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
3. Members without a linked liability waiver go to `/waiver?signup=1` before
   Stripe Checkout. Signing continues through `/payment/resume`, preserving the
   selected billing cycle. Checkout shows the final price with any
   admin-assigned discount applied automatically. Members cannot select or change discounts.
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
not update Conway records. Door access is managed through this app's edgeproxy integration. New Stripe customers
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
`SITE_URL` exactly. Local Wrangler provides D1, R2, Durable Objects and Queue emulation.

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

### Liability waiver and Cloudflare Turnstile

Anyone can sign at **`/waiver`** without Discord authentication. Public signing
uses the entered name/email, associates by normalized email, and creates a
waiver-only member when needed. A first Discord member login or signup claims
that member using Discord's verified email; an email already linked to another
Discord account cannot transfer its membership. Email matching uses trimmed,
lowercase addresses, without provider-specific dot or plus-address rewriting.
Ambiguous matches require leadership assistance.

During signup, **`/waiver?signup=1`** instead attaches to the authenticated member,
even when the signer enters another name/email. Public `/waiver` remains usable
for other people even in a browser with a member login. Expired signup sessions
must sign in again and review the form. Both paths require all agreements and a
successful server-side Turnstile verification before recording a signature.

The text and version live in **`src/waiver-content.js`**. It currently contains
Conway's sample placeholder, as requested; replace it with TheLab's actual waiver
before launch. Increment `version` when changing the text and deploy the Worker.
The format supports `# Title`, blank-line-separated paragraphs, and required
`- [ ] Agreement` checkboxes. Text is escaped and displayed literally. A content
hash and version check reject forms opened before a text change, including changes
where the version was accidentally left unchanged.

Every signature retains its exact text, version, agreements, entered name/email,
timestamp, and stable member link in D1. Evidence is immutable and retained when
a member is deleted. Existing linked signatures remain sufficient for checkout
after source updates. Admin member pages show waiver status and signature evidence;
waiver-only members are searchable by name/email and use stable-ID admin URLs.

Create a **Turnstile widget** in Cloudflare, allowing the hostname in `SITE_URL`.
Set `TURNSTILE_SITE_KEY` in `wrangler.jsonc` and store the secret with:

```sh
npx wrangler secret put TURNSTILE_SECRET_KEY
```

For local development, use a development widget/key pair with `localhost` allowed
and set both keys in `.dev.vars`. Siteverify must return the configured hostname
and action `waiver`; verification failures and provider outages fail closed.
Turnstile tokens are single-use, so retrying a submission requires a fresh challenge.

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
npx wrangler r2 bucket create thelab-wiki
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
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler d1 migrations apply thelab-membership --remote
npx wrangler deploy --dry-run
npm run deploy
```

The existing `make dev` and `make deploy` commands still work. Assets are served
directly; signup, waiver, callback, payment and webhook paths run through the Worker first.

## Door fobs and swipe synchronization

Admins assign one unique optional **Fob ID** on each member's edit form. IDs are
decimal integers from 1 through 4294967295; blank removes the assignment. By default,
a fob is authorized when **Stripe status is exactly `active` AND the member has
a linked signed waiver**. Two admin-managed checkboxes override these requirements:

- **Non-billable:** activates the assigned fob regardless of payment or waiver status.
- **Legacy billing:** activates the assigned fob with a linked signed waiver, regardless of Stripe status.

Both default to unchecked. Non-billable takes precedence if both are checked.
An assigned fob is always required. Otherwise, `trialing` does not qualify for door access. Waiver
eligibility uses the same linked-signature rule as checkout, not a separate admin
checkbox. Discord/printer membership eligibility is separate.

Fob and access-override changes, Stripe reconciliation, and waiver signatures trigger immediate
reconciliation. A singleton `EdgeSync` Durable Object serializes fob snapshots
and versions, reads current D1 eligibility, and sends additions/removals with
`PATCH /api/goal`. Initial synchronization and full resync use `PUT /api/goal`.
An empty authorized set explicitly revokes every remotely managed fob. The edge
limit is 512; exceeding it fails the sync without sending a truncated list.

D1 triggers record access changes atomically using a revision marker. Before
access-affecting writes, the app arms a durable alarm; it checks pending revisions
every minute and retries failures. Unchanged revisions do not contact edgeproxy.
This is a recovery check, not periodic swipe polling. A failed edge call does not
undo a committed membership change. The last edge goal remains effective until
delivery succeeds, including during outages. Versions are allocated durably;
ambiguous deliveries and conflicts recover by reading the edge goal and computing
a new diff from current D1 state. Keep D1 and Durable Object storage across deploys.

**View fresh fob swipes** on `/admin` opens the swipe filter in member history.
History pages that include swipes, including member edit previews and pagination,
await a fresh edge fetch and completed D1 import before rendering. Filters for
other event types do not fetch swipes. Failed refreshes show a retry error rather
than silently serving stale history. Swipe imports run independently of fob
delivery, deduplicate stable edge IDs, and write in transactions of 50 events.
Responses are bounded to 32 MiB and 20 seconds; a limit or timeout fails the refresh.
Cloud copies are retained indefinitely. Unknown fobs remain visible; known fobs
are attributed using assignment intervals at the edge-recorded swipe time, not
the owner at import time. Keep the edge host's clock synchronized.

At **1 a.m. America/Chicago** each night, the Worker imports swipes and pushes a
complete authorized fob snapshot. UTC cron candidates at 06:00 and 07:00 are gated
by local time, with durable per-date completion to suppress the repeated fall-back
hour. Failed nightly work retries through the alarm. **Full resync** on `/admin`
performs the same backup and full goal delivery on demand, with live admin-role
and CSRF checks. It waits and reports completion or a retryable failure. Full resync
uses the latest stored Stripe state; it does not refetch every subscription from
Stripe. Nightly backups cannot recover swipes already expired from edge's seven-day
store; firmware retries can still yield distinct IDs for the same physical swipe.

### Configure Worker → edge access

1. Follow the [edge Cloudflare Access setup](edgeproxy/README.md#cloudflare-access-service-token-setup)
   to protect the machine API with a **Service Auth** policy for a dedicated token.
2. Set `EDGE_URL` in `wrangler.jsonc` to the HTTPS tunnel origin, without a trailing
   slash (for example `https://edge.example.com`). This may equal `PRINTER_EDGE_URL`.
3. Store the token credentials:

   ```sh
   npx wrangler secret put EDGE_ACCESS_CLIENT_ID
   npx wrangler secret put EDGE_ACCESS_CLIENT_SECRET
   ```

4. Deploy the Worker and edgeproxy, then select **Full resync** and confirm that
   controller polls return the expected fob set. Keep service-token expiry/rotation
   settings current in Cloudflare Access.

Leaving `EDGE_URL` empty disables integration. Fob assignments can still be edited,
but no goals are delivered. For this undeployed app, all new D1 schema and both
Durable Object classes are in the initial migrations. Recreate old disposable local
state and run `npm run db:local`; no upgrade migration is provided.

## Community wiki

**`/wiki`** is a public page index. Anyone can read pages and uploaded images;
members use **New page** or **Edit page** to enter the existing Discord sign-in
flow. The home page navigation and welcome page link to the wiki.

Editing follows the shared door membership rule **without requiring a fob**:
non-billable members qualify directly; otherwise a linked signed waiver and either
legacy billing or an exactly `active` Stripe subscription are required. `trialing`
alone does not qualify. Editor, preview, save, delete, and upload requests check
current membership and session identity; writes also require the editor's CSRF
token and matching origin. Public reads do not query D1 or personalize responses.

The editor offers a Markdown textarea, formatting buttons, server-rendered preview,
and image upload/insertion at the cursor. Pages have an immutable lowercase,
hyphenated address and editable title. Link to pages with
`[Guide](/wiki/guide)`. Headings, lists, tables, blockquotes, and fenced code blocks
are supported. Raw HTML is escaped, unsafe links are rejected by `markdown-it`,
and images must be wiki uploads. Markdown is limited to 128 KiB; image uploads
support JPEG, PNG, WebP, and GIF with signature checks and a 5 MiB limit.

### Storage and deployment

Provision `thelab-wiki` using the R2 command in the deployment section above.
`wrangler.jsonc` binds it as `WIKI_BUCKET` and adds the singleton `Wiki` Durable
Object as `WIKI`, with migration `v2-wiki`. Keep the bucket private: images are
served through the Worker. No additional secrets or D1 migrations are needed.

Markdown is stored in immutable R2 blobs at `pages/<slug>/<revision>.md` and images
at `images/<id>`. Durable Object SQLite holds only page metadata, revision pointers,
image references, and cleanup jobs. Preserve **both R2 and Durable Object storage**
across deploys. Writes, reference updates, and cleanup share a serialized lane.
Publication atomically updates metadata after R2 accepts the Markdown blob;
interrupted or ambiguous uploads have pre-registered cleanup jobs. Competing edits
return HTTP 409 and preserve the draft in the browser. Copy the draft, reload the
editor, and merge against the latest version. This is a simple wiki without a
revision-history UI; obsolete Markdown blobs are automatically removed after a
24-hour grace period.

### Caching and image cleanup

Public HTML, the index, and images use Cloudflare's Cache API. Every read first
looks up authoritative metadata in the Durable Object and selects a cache key
containing the current revision and renderer version. A successful write changes
the page/index revision, so subsequent reads in **all Cloudflare locations** bypass
old entries immediately. Old entries expire after 24 hours. This avoids the
local-only behavior of `cache.delete()` and requires no global-purge API token.
Cache hits skip R2 retrieval and Markdown rendering. Browser responses require
revalidation and outer CDN caching is disabled so every read checks current
metadata. Editor and mutation responses are `no-store`. Bump `CACHE_VERSION` in
`src/wiki.js` when changing published HTML or Markdown rendering.

Image references are derived from the same parsed Markdown used for display,
including reference-style images and direct image links across all pages. Removing
the final reference starts a 24-hour grace period; saving another reference cancels
deletion. Abandoned uploads expire 24 hours after upload. A durable alarm checks
hourly, deletes expired unreferenced images in bounded batches, and retries storage
failures. Actual removal occurs on the next cleanup run after the grace period.
The Worker checks image availability before consulting its cache, so deleted
images cannot be fetched from stale cached entries. Upload the image again if it
expires while an unsaved draft remains open.

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

## Member administration and discounts

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

- Name override and internal notes. Member names use **name override →
  Stripe billing name → Discord username → waiver name → member email**.
- Discord ID and Stripe customer/subscription IDs. The subscription must belong
  to the customer; accounts/customers already linked to another member are rejected.
- Saved monthly/yearly billing cycle and assigned discount category.
- Fob ID, non-billable status, and legacy billing status for door access.

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

To assign a discount, verify the member's numeric Discord ID and eligibility,
select the discount category, and save. Choose **Standard rate** to remove a
discount. Family eligibility remains leadership's judgment.

Tell the member to use `/payment/resume`. If needed it signs them in directly,
then resumes their saved billing cycle with the current admin-assigned discount.
Alternatively, send `/signup?billing=yearly` to select yearly billing. Signup
cannot clear or replace an assigned discount; user-supplied discount URL parameters
are ignored. Stripe Checkout displays the final discounted total before payment.

Pricing edits apply to future Checkout; manage existing prices and invoices in
Stripe. Saving changed billing/discount metadata or identity mappings
expires any outstanding Checkout link through the member's serialized Durable
Object. If Stripe cannot resolve or expire that link, the save fails and keeps
the entered fields for retry. Completed Checkout subscriptions are left intact.
Concurrent profile/billing edits are rejected with a reload message so stale
forms cannot silently overwrite newer changes. Subscription status and sync
timestamps are read-only; role eligibility is always reconciled against Stripe.

The initial migration includes the admin and member-history schema and stores the latest Stripe state
in `members`, with no OAuth state or Stripe webhook receipt tables. No upgrade migration is
needed for this undeployed app.
For a local database created with the old schema,
recreate the disposable local D1 database and run `npm run db:local` before use.

## Member history

Open **`/admin/events`** for a paginated history of member changes, filterable by
event type. Each member's edit page shows their ten most recent events and links
to **`/admin/members/<discord-id>/events`** for their full, filterable history.
History pages require the same live Discord admin-role check as member edits.
Timestamps are displayed in UTC, newest first; event IDs break ties within a second.

SQLite triggers in the initial migration record registration and actual changes to:

- Discord account ID, username, and email.
- Stripe billing name/email and the name override.
- Internal notes (an update marker only, without copying note contents).
- Saved billing cycle and discount category.
- Stripe customer/subscription links and the stored subscription status.
- Signed liability waivers (signature ID and version).

Changed values are stored as structured before/after details. History is written
atomically with each database change, including admin edits, Discord sign-in
refreshes, and Stripe reconciliation. Repeated saves of the same values, sync
timestamps, and version counters produce no events. This records committed member
state changes; it does not identify the editor or imply that a Discord role update
succeeded. Operational errors continue to appear in Worker logs.

Events are **retained indefinitely** and linked to the stable internal member ID,
so transferring the Discord account preserves history. Deleting a member retains
their events with a “Deleted member” label. There is no scheduled cleanup or
backfill of existing records. Since this app is undeployed, the history tables and
triggers are part of `0001_membership.sql`; recreate any old disposable local D1
database and apply `npm run db:local` to use the updated schema.

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
- `src/member-events.js` and `src/event-views.js`: member-history queries, filters,
  and rendering. The initial D1 migration owns automatic change capture.
- `src/printers.js`: member authorization and the edge JWT handoff.
- `src/wiki.js`, `src/wiki-store.js`, `src/wiki-markdown.js`, and `src/wiki-views.js`:
  public wiki routing/cache, R2 publication and cleanup coordination, safe Markdown,
  and page/editor views. `static/wiki-editor.js` implements the browser editor.
- `src/waiver.js` and `src/waiver-content.js`: public signing, Turnstile verification,
  source-controlled waiver text, and read-only admin signature evidence.
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
HTTP. They cover OAuth/browser state, admin-assigned discounts and pricing rules, serialized
checkout/idempotency, success verification, signed webhooks, queue failure/retry,
duplicate delivery and current-state role reconciliation. Finish provider setup
with a Stripe test-mode signup, cancellation, admin-assigned discount and Discord role
check before using live credentials.

Wiki tests use local R2 and a real Durable Object to verify permissions, conflicts,
cache revision changes, safe rendering, upload bounds, shared references, abandoned
image cleanup, and recovery after ambiguous writes or failed deletes.

The `sharp` override keeps the test runtime's transitive image dependency on its
patched release. The wiki uses `markdown-it` as a runtime dependency.
