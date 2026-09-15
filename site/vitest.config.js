import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        SITE_URL: 'https://thelab.example',
        // Edge tests supply their own URL and signing key; other tests stay offline.
        EDGE_URL: '',
        AUTH_SECRET: 'test-only-auth-secret-at-least-32-bytes',
        DISCORD_CLIENT_ID: 'test-client',
        DISCORD_CLIENT_SECRET: 'test-secret',
        DISCORD_BOT_TOKEN: 'test-bot',
        DISCORD_GUILD_ID: '111111111111111111',
        DISCORD_ROLE_ID: '222222222222222222',
        DISCORD_ADMIN_ROLE_ID: '444444444444444444',
        STRIPE_SECRET_KEY: 'sk_test_fake',
        STRIPE_WEBHOOK_SECRET: 'whsec_fake',
        TURNSTILE_SITE_KEY: 'test-site-key',
        TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      },
    },
  })],
  test: { include: ['test/**/*.test.js'], fileParallelism: false },
}));
