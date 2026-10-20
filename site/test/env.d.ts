// Bindings that exist only in tests (see vitest.config.ts).
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
}
