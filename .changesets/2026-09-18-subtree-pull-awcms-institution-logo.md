---
bump: patch
type: dependency
impact: internal
---

# Sync `apps/cms` from upstream `ahliweb/awcms` — institution logo, SVG safety scan

`git subtree pull --prefix=apps/cms awcms main`, merged with a merge commit
(the one rule AGENTS.md protects every future sync with), bringing
`apps/cms` from the v10.3.0 embed point (`749404d4`) to upstream `main`
`4e049743` — awcms PR #807, opened for awcms-one issue #59 (C1, "Logo
Instansi").

- `awcms_blog_institutions` gains `logo_media_id`/`logo_alt` (`sql/153`),
  exposed as `logoMediaId`/`logoAlt` on `/api/v1/blog/institutions`; the
  storefront renders it in issue #59's step 3.
- `media_library` now recognises SVG uploads at all (its sniffer never
  matched SVG's shape before) and scans them with a denylist — script
  elements, event handlers, `javascript:`/`data:` URIs after
  character-reference decoding, any `<!ENTITY` declaration.
- Upstream's `js-yaml`/`smol-toml`/`svgo` override bumps ride along.

Only felt while developing:

- The seven generated-document conflicts (`repo-inventory.md`,
  `PROJECT_STATE.*`, `ARCHITECTURE.*`, `.claude/skills/README.*`) were
  resolved by keeping this repo's copy and re-running upstream's generators,
  exactly as AGENTS.md's divergence rule prescribes; `prettier --write` on
  the regenerated tables and on `commerce/README.id.md` was needed for
  `bun run lint`.
- `sql/153_awcms_blog_institution_logo.sql` (upstream) now sits beside this
  repo's `sql/153_awcms_commerce_schema.sql`. The migration runner keys by
  full filename and applies both in lexical order, so nothing breaks — but
  every upstream migration from here on will share a number with a commerce
  one until the commerce migrations move out of upstream's range, which is
  tracked as a follow-up issue.
