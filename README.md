# TheLab website and membership signup

Static landing/welcome pages and a small Cloudflare Worker. Signup uses Discord
identity, Stripe subscriptions, D1, one Durable Object per member, and a Cloudflare
Queue for Discord role reconciliation. There are **no scheduled triggers**.

## Flow

1. Choose monthly/yearly and a rate on the landing page. `/signup` redirects to
   Discord with `identify email` and browser-bound, expiring, single-use state.
2. `/login/discord/callback` requires a verified email and existing membership in
   TheLab's Discord guild. Accounts are identified by immutable Discord ID, never
   matched to a Stripe customer by email. OAuth tokens are not retained.
3. Standard or approved-discount members go straight to Stripe Checkout. A
   discount request goes to `/membership-pending` until leadership approves it.
   Existing subscriptions, including past-due ones, go to Stripe Billing Portal.
4. `/payment/success` checks the signed-in user's Checkout ownership, completion,
   payment status, and subscription status against Stripe, then redirects to the
   static `/welcome` page. The welcome page itself is public and grants no access.
5. Verified Stripe webhooks enqueue customer/event IDs. The consumer fetches
   **current** Stripe subscriptions, then adds/removes the Discord member role.
   `active` and `trialing` grant membership, matching Conway. Scheduled cancellation
   retains the role until the subscription actually lapses. `past_due`, `unpaid`,
   paused and canceled subscriptions do not grant membership.

The implementation follows `../conway`'s `monthly`/`yearly` Stripe lookup keys,
coupon `metadata.discountTypes`, OAuth scopes/callback path, billing portal
behavior and role eligibility. It is a **standalone** membership store: it does
not update Conway records, waivers or door-access systems. New Stripe customers
and subscriptions carry `metadata.thelab_discord_id`; existing Conway customers
are not automatically imported or matched by email.

## Local development

Use Node 24 LTS (or a supported Node 22 release) and npm:

```sh
npm ci
npm run db:local
npm run dev
```

Create an ignored `.dev.vars` using `.dev.vars.example`. Use Discord development
credentials and a Stripe test-mode key. Register the exact Discord redirect
`http://localhost:8787/login/discord/callback`. Open `http://localhost:8787`, matching
`SITE_URL` exactly. Local Wrangler provides D1, Durable Objects and Queue emulation.

For local Stripe webhook delivery:

```sh
stripe listen --forward-to localhost:8787/webhooks/stripe
```

Use the printed signing secret for local `STRIPE_WEBHOOK_SECRET`. Local queue
consumers call real Discord/Stripe unless running the automated tests.

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
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler d1 migrations apply thelab-membership --remote
npx wrangler deploy --dry-run
npm run deploy
```

The existing `make dev` and `make deploy` commands still work. Assets are served
directly; signup, callback, payment and webhook paths run through the Worker first.

## Member administration and discount approval

Set `DISCORD_ADMIN_ROLE_ID` in `wrangler.jsonc` (or `.dev.vars` locally) to the
numeric Discord role ID that grants leadership/admin access. Open **`/admin`**
and sign in with Discord. Admin access is disabled until that role is configured.
The bot checks the user's current guild roles on every member list, detail, and
save request. Removing the role immediately removes access. Admin sign-in uses
the existing Discord callback URL, but has its own eight-hour session and does
not register a member or start checkout. Use **Sign out** to end that session.

The list includes all members registered in this app, including pending and
inactive members, in pages of 25 ordered newest first. Open a member to view IDs,
registration and sync timestamps, and last-synced subscription status, and edit:

- Stored Discord username/email (refreshed from Discord at the next member sign-in).
- Separate contact name/email, internal notes, and custom JSON text key/value pairs.
- Saved monthly/yearly billing cycle, discount category, and approval status.

For a discount request, verify the member's numeric Discord ID and eligibility,
then select **Approved** or **Denied** for the requested category and save. Use
**None** with the standard rate. Family eligibility remains leadership's judgment.
Requests do not send automated notifications, so check the list regularly.

Tell the member to click **Check approval & continue** on the pending page or use
`/payment/resume` while signed in. Alternatively, send a signup URL preserving
the saved selection, such as `/signup?billing=yearly&discount=student`. Choosing
a different category creates a new request; choosing standard rate clears it.
Denied requests remain denied when retried with the same category.

Billing edits are **metadata only**: existing Stripe subscriptions and invoices
are unaffected. Manage those in Stripe. Saving changed billing/discount metadata
expires any outstanding Checkout link through the member's serialized Durable
Object. If Stripe cannot resolve or expire that link, the save fails and keeps
the entered fields for retry. Completed Checkout subscriptions are left intact.
Concurrent profile/billing edits are rejected with a reload message so stale
forms cannot silently overwrite newer changes. Stripe/Discord sync fields are
read-only and are not used to grant membership from this editor.

The initial migration includes the admin schema; no upgrade migration is needed
for this undeployed app. For a local database created with the old schema,
recreate the disposable local D1 database and run `npm run db:local` before use.

## Queue delivery and recovery

The webhook only acknowledges Stripe after `MEMBERSHIP_QUEUE.send()` succeeds.
No database receipt is written before enqueueing, so a failed send remains
retryable by Stripe. Queue jobs serialize with checkout per Discord ID, retrieve
current Stripe state, and use idempotent Discord PUT/DELETE operations. Event IDs
are marked processed **after** Discord succeeds, allowing crash-safe redelivery.
Unrelated Stripe customers and subscriptions without this app's metadata are ignored.

Failures use exponential backoff, honor Discord/Stripe retry delays, and move to
`thelab-membership-failed` after 20 retries. Monitor failed messages in the
Cloudflare Queues dashboard and Worker logs. After fixing configuration, provider
permissions, or having the user rejoin Discord, replay failed messages using
Cloudflare Queues' message pull/ack and push APIs (or dashboard controls):

1. Pull from `thelab-membership-failed` without acknowledging yet.
2. Push the same JSON body to `thelab-membership` and verify acceptance.
3. Acknowledge the original dead-letter message only after the push succeeds.

Messages contain `{ "customer_id": "cus_...", "event_id": "evt_..." }`. For an
explicit current-state resync, push `{ "customer_id": "cus_..." }` to the main
queue (without `event_id`). This also repairs roles after a member leaves/rejoins
Discord or a role is changed manually. With no cron or Discord gateway listener,
those Discord-only changes need a manual resync or the next Stripe event.

Stripe writes have durable idempotency records in the member Durable Object.
Ambiguous writes older than 23 hours stop for review instead of risking a duplicate
charge after Stripe expires its idempotency key. Inspect the customer's sessions
and subscriptions in Stripe before repairing such an operation; retain both D1
and Durable Object storage during deployments. Do not delete member/customer
mappings while subscriptions are in use.

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
event deduplication and current-state role reconciliation. Finish provider setup
with a Stripe test-mode signup, cancellation, discount approval and Discord role
check before using live credentials.

The `sharp` override keeps the test runtime's transitive image dependency on its
patched release; the membership Worker itself has no third-party runtime packages.
