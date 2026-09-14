# DokuWiki → Workers wiki

Requires Node 22.12+ and `npm ci`. Run commands from the repository root.

## Download

```sh
npm run wiki:download
```

The downloader recursively enumerates **page namespaces and media namespaces**, follows existing page links (including those in historical revisions), and downloads original media, including unlinked files. It saves:

| Path | Contents |
| --- | --- |
| `wiki-export/pages/*.md` | Current pages converted to Markdown |
| `wiki-export/raw/*.txt` | Original DokuWiki source |
| `wiki-export/html/*.html` | Original rendered article HTML |
| `wiki-export/media/<sha256>/*` | Byte-for-byte original attachments |
| `wiki-export/history/` | Revision Markdown, raw source, and per-page JSON archives with authors and change summaries |
| `wiki-export/manifest.json` | Source IDs → destination slugs, checksums, timestamps, file inventory, failures and conversion warnings |
| `wiki-export/.cache/` | Resumable HTTP cache (gitignored) |

The downloader retries failed requests and caches successful responses atomically. Re-run the same command after interruption; successful downloads are reused. Use `--refresh` for a new network snapshot, preferably with a **new output directory** (`--out wiki-export-final`) before cutover. `--no-history` explicitly limits the export to current content. `--source https://wiki.thelab.ms` selects the source origin.

Markdown links point at destination `/wiki/...` routes. Namespace IDs and underscores become flat hyphenated slugs; collisions receive a stable hash suffix. Attachments use content-addressed `/wiki/files/<sha256>/<filename>` URLs. Heading `{#original_id}` suffixes retain DokuWiki section links. Tables, lists, formatting and code use Markdown; embedded players become links. Original source and rendered HTML remain available for fidelity review.

## Check completeness

```sh
npm run wiki:import -- --dry-run
```

This checks every file checksum, duplicate slugs, page/file limits and local attachment references **before any writes**. Download failures cause a nonzero exit and normally block import. Review `errors` and `warnings` in `manifest.json`. `--allow-incomplete` explicitly permits an export with recorded source failures; it does not ignore checksum failures or missing referenced local files.

The public crawl covers content exposed to its session. Private or unlisted content that is neither indexed nor linked, deleted pages absent from the index, historical media versions, users, ACLs and server/plugin configuration require a DokuWiki server backup for a truly complete retirement. Obtain `data/` and `conf/` from the old host before decommissioning. To enumerate content visible to a logged-in DokuWiki session, set `DOKUWIKI_COOKIE` and use a **separate** `--out` directory so it does not reuse the anonymous cache. Treat that export according to its access requirements: imported pages/files are publicly readable.

Historical page revisions are preserved as downloadable JSON archives containing Markdown and original DokuWiki source, authors and change summaries. The Workers wiki does not have native revision browsing; each imported page links to its archive and original source. The migration archive page lists all attachments, including orphans.

## Import

Deploy the Worker changes in this repository, then set a temporary import secret. Use the same securely generated value for the Wrangler secret and the local environment variable:

```sh
npm run deploy
npx wrangler secret put WIKI_IMPORT_TOKEN
export WIKI_IMPORT_TOKEN='your-random-import-secret'
npm run wiki:import -- --target https://thelab.ms
```

For another export directory, add `--directory wiki-export-final`.

The importer uploads original media/source/history to R2 first, then creates pages through the singleton Wiki Durable Object. This updates the actual authoritative page index and revision cache keys; uploading `.md` files to R2 alone would not publish them. Original page timestamps are retained. Imported files are pinned, so unlinked historical/orphan media are not removed by the normal image cleanup alarm. Files are limited to 25 MiB; current pages including provenance to 128 KiB. Non-image originals download with their filename; SVGs are served with a sandbox CSP.

Writes require the import secret at both the HTTP and Durable Object boundaries. The endpoint is disabled unless `WIKI_IMPORT_TOKEN` is configured. Imports are **create-only and retry-safe**: identical pages/files are skipped; a differing existing page returns 409 instead of overwriting an editor's work. Re-run after a network interruption. Resolve a conflict in the normal editor or use a fresh destination for a revised migration snapshot.

After writing, the importer reads back every published page and attachment, compares rendered content and SHA-256 checksums, and fails if verification differs. To repeat just these public-read checks (no token needed), run `npm run wiki:import -- --target https://thelab.ms --verify-only`.

After reviewing `/wiki`, `/wiki/start`, `/wiki/migration-archive`, representative tables/images, and the failure report:

```sh
npx wrangler secret delete WIKI_IMPORT_TOKEN
unset WIKI_IMPORT_TOKEN
```

Changing the old wiki hostname/DNS and setting redirects is a separate cutover step. Use the manifest's ID/slug mapping for old page redirects and preserve URL fragments. Keep the downloaded archive and old-server backup.

## Local verification

```sh
npm run wiki:test-migration
npm test -- test/wiki.test.js
npx wrangler dev --port 8788 --var SITE_URL:http://localhost:8788 --var WIKI_IMPORT_TOKEN:local-migration-test
```

In another terminal:

```sh
WIKI_IMPORT_TOKEN=local-migration-test npm run wiki:import -- --target http://localhost:8788
```

Import twice to verify idempotence. Local testing uses local Wrangler storage, not production R2 or Durable Objects.
