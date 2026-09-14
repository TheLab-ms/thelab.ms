# Worker bootstrap

Requires Node.js 22.12+ and dependencies installed with `npm ci`. Run from the
repository root:

```sh
npm run bootstrap -- --local
npm run dev
```

Local mode creates `.dev.vars` from `.dev.vars.example` if needed, generates
missing `AUTH_SECRET` and `EDGE_JWT_PRIVATE_KEY` values, and applies local D1
migrations. Fill in provider credentials in `.dev.vars`. Wrangler creates local
R2, queue, and Durable Object storage when the development server starts.
Existing variable values are preserved.

## Cloudflare

1. Run `npx wrangler login` (or export `CLOUDFLARE_API_TOKEN`). Select the account
   with `CLOUDFLARE_ACCOUNT_ID` or `account_id` in `wrangler.jsonc`. The account
   needs Workers with SQLite Durable Objects, Queues, D1, and R2 enabled, and
   credentials with permission to manage those resources and deploy Workers.
2. Review the resource names and `vars` in `wrangler.jsonc`, especially `SITE_URL`,
   Discord IDs/admin role, Turnstile site key, and optional edge URLs. This script
   bootstraps the default configuration, not named Wrangler environments.
3. Provide production secrets as exported environment variables or in an ignored
   `.env.bootstrap.json` file at the repository root:

   ```json
   {
     "DISCORD_CLIENT_SECRET": "...",
     "DISCORD_BOT_TOKEN": "...",
     "STRIPE_SECRET_KEY": "...",
     "STRIPE_WEBHOOK_SECRET": "...",
     "TURNSTILE_SECRET_KEY": "..."
   }
   ```

4. Run:

   ```sh
   npm run bootstrap -- --remote
   ```

Remote mode:

- Creates or reuses the configured D1 database and writes its ID into
  `wrangler.jsonc`. An existing configured ID must belong to the selected account.
- Creates or reuses the wiki R2 bucket and both membership queues, including the
  dead-letter queue.
- Generates a random 256-bit auth secret and an Ed25519 private key (base64
  PKCS#8 DER) if those secrets do not already exist in Cloudflare or the secret
  file. Newly generated secrets are saved in `.env.bootstrap.json` with mode
  `0600` so interrupted runs can reuse them. Local development keys are separate.
- Applies pending remote D1 migrations, then deploys the Worker with missing
  secrets. Deployment also applies Durable Object class migrations and configures
  queue consumers, cron, and assets.

Reruns reuse resources and preserve all existing remote secrets. The saved secret
file takes precedence over exported values. To intentionally change an existing
remote secret, use `npx wrangler secret put SECRET_NAME`. Missing provider secrets
are reported; the Worker can be deployed before those integrations are configured.
Keep `.env.bootstrap.json` private and backed up; Cloudflare cannot return secret
values. Review and commit the database ID change in `wrangler.jsonc`.

## Provider and domain setup

- Configure a Worker route/custom domain for `SITE_URL` in Cloudflare (or add it
  to `wrangler.jsonc` before bootstrap). The default workers.dev URL does not
  replace the application's configured canonical origin.
- Register `${SITE_URL}/login/discord/callback` as the Discord OAuth redirect.
  Configure the guild, membership role, and admin role IDs. The bot needs access
  to manage the membership role, with its own role above it.
- Configure Stripe's webhook endpoint at `${SITE_URL}/webhooks/stripe` and set
  its signing secret. Use matching test or live Stripe credentials.
- If using Turnstile, configure its hostname and both site and secret keys.
- If using the edge service, configure `EDGE_URL` and `PRINTER_EDGE_URL` as
  appropriate. The Worker publishes its signing public key automatically at
  `/.well-known/edge-jwks.json`; `EDGE_JWT_PUBLIC_KEYS` is only needed for additional
  keys during rotation. Configure the edge service to trust the Worker's issuer
  and JWKS endpoint.
- For existing Conway data, use `scripts/import-conway.py` after migrations and
  before accepting application writes; its usage header describes the import.

## Script checks

Run `bash -n scripts/bootstrap-worker.sh` and
`node --test scripts/bootstrap-worker.test.js`. Tests use isolated temporary
projects, mock remote Cloudflare operations, and apply real local D1 migrations.
