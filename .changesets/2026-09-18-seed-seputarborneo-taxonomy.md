---
bump: minor
type: content
impact: internal
---

# Seed seputarborneo reference taxonomy, institutions, sample posts, legal pages, ad placements, social links, and legacy redirects

`tools/seed-borneojek-mart.ts` previously seeded 3 store-flavoured blog terms, 3 posts, 2 legal pages, 0 institutions, 0 ad placements, and 0 redirects — against a real database every news page the storefront's `/berita`, `/rubrik/*`, `/daerah/*`, and `/mitra/*` routes render was empty. This gives every developer, reviewer, and CI job something real to look at instead of an empty news IA, modelled on seputarborneo's own reference structure (`include/nav_menu.php`, verified 2026-09-18) so it matches the shape `apps/storefront`'s news pages were actually built against.

- An 8-rubrik `category` taxonomy tree (politik/hukum/nasional/olahraga/wisata/daerah/mitra-borneo/umum) with umum's topical children — including a `wisata-travel` child, a deliberate slug choice recorded in `tools/seed-borneojek-mart.ts`'s own docblock: `awcms_blog_terms_slug_dedup` (`apps/cms/sql/035_awcms_blog_content_schema.sql`) is unique on `(tenant_id, taxonomy_type, slug)` with no `parent_id` component, so this one tree cannot hold seputarborneo's own two `wisata` slugs (a top-level rubrik and a UMUM child) the way its legacy two-column MySQL schema could.
- The full 24-institution legislative/executive directory, each `regionCode` resolved by NAME against `GET /api/v1/idn-regions/regions` at seed time rather than a hard-coded Kepmendagri code.
- 19 sample news posts spread across every rubrik, three carrying a Portable Text `videoNews` node with a clearly-marked placeholder YouTube id.
- Three additional legal pages: `redaksi` (generic placeholders, deliberately not seputarborneo's own company/personnel data), `pedoman-media-siber` (Dewan Pers's public text, ported), and `disclaimer` (genericized to this tenant).
- Six social links and a WhatsApp number on the site profile.
- 5 sample `legacy_blog`-origin redirects exercising `docs/routing.md`'s row-based legacy-redirect path.
- Ad placements are attempted for real (upload-session → PUT → finalize) and gracefully skipped with one explanatory line when a deployment has no `NEWS_MEDIA_R2_*` configured — this repo's local/CI compose stack, verified locally, is exactly such a deployment, so no ad placement is actually created here today; the moment R2 is configured, this step creates all 12 unattended.
- Every step is additive to the existing seed and follows the same idempotent `ensure*` posture already established — verified locally with two consecutive `bun run db:seed:cms` runs against a freshly reset/migrated database: the second run reports 0 created for everything this issue adds.
