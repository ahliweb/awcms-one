---
bump: minor
type: structure
impact: internal
---

# Importer from the seputarborneo MariaDB dump into `blog_content` + SEO redirects

`tools/import-seputarborneo.ts` (`bun run import:seputarborneo`) reads seputarborneo.com's legacy MariaDB archive — `berita_red`, `berita_vid`, `ikl_online`, `logo`, `config` — and imports it into `blog_content`/`seo_distribution` over the same public `/api/v1/*` surface `tools/seed-borneojek-mart.ts` already drives. This is the tool that turns issue #57's freshly-seeded taxonomy/institution tree into a real, populated news archive rather than an empty shell.

The **why** is mostly about what could NOT be assumed: the 228 MB dump is a real production export a future run must never hold whole in memory or accidentally commit, its taxonomy carries five documented legacy-spelling quirks a normalization pass has to reproduce exactly, and its HTML bodies need converting into this platform's closed Portable Text vocabulary without a general-purpose HTML parser dependency. Two real limitations of the public API surfaced during this work and are documented rather than worked around: no public field can backdate `published_at` for a past-dated article (only `.../schedule` accepts a future one), and no public field sets a post's rendered byline (the legacy `user` column becomes provenance in `contentJson.legacySource`, not a byline).

- A new streaming MariaDB dump reader (`tools/lib/mysql-dump-reader.ts`) that learns each table's column order from its own `CREATE TABLE` statement rather than a hard-coded list — verified necessary against the real dump, whose `berita_vid` schema differs from the reference repo's own migrated fixture.
- A new, purpose-built HTML→Portable Text converter (`tools/lib/html-to-portable-text.ts`) and a minimal HTTP client (`tools/lib/awcms-api.ts`), both new files this importer alone uses.
- `--dry-run` (the default) runs with no network call and no database at all — verified end to end against the real dump: 25,490 `berita_red` rows read, 0 unmapped taxonomy values.
- The full `--limit 200` run against a live, seeded tenant is deliberately deferred to after issue #57 merges (this repo's B1/B2 wave split) and is not part of this change's own verification.
