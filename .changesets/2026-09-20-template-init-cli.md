---
bump: minor
type: content
impact: public
---

# `bun run template:init` — idempotent brand/profile initialisation for derived repos

Issue #138 (ADR-0018 D4/D5): a new root-level script that rewrites this
repository's brand surface (name, domain, colours, contact, `SITE_PROFILE`)
for a repository created from GitHub's own "Use this template" button, so a
derived repo's first commit is already green.

- `tools/template-init.ts` (entry) + `tools/template-init/**` (CLI parsing
  and prompting, targeted text-surgery rewriters, a `plan`/`apply` split so
  `--dry-run` and a real run share one code path, and the trailing gate
  chain: `docs:i18n:stamp`, `bun install`, `audit:dokumen`,
  `audit:translation`, `audit:rilis`, `bun test`).
- Idempotent by construction: every rewrite is diffed against the file's
  current content, so a second run with identical flags touches nothing
  (exit `0`, "nothing to do"); a run with different flags rewrites only what
  changed. `CHANGELOG.md`/`.changesets/*.md`/`package.json`'s version reset
  happen exactly once, gated on the new `package.json#awcmsOne.templateVersion`
  field. Refuses a dirty working tree, and refuses to run against the
  template itself (`package.json.name === "awcms-one"`), without `--yes`.
- Removes BjekMart-only artefacts — `tools/seed-borneojek-mart.ts` plus
  `tools/seed-data/*.json`/`tools/seed-assets/**` (today's layout) **or**
  `tools/seed-data/contoh/borneojek-mart/**` (issue #139's planned layout,
  whichever is present), `tools/import-seputarborneo.ts` and its test — and
  resets `graphify-out/`/`knowledge/generated/` to absent, which
  `packages/gerbang/audit-graf.mjs` already treats as a valid, gate-passing
  state.
- New CI workflow `.github/workflows/template-init-smoke.yml`, matrixed over
  `toko`/`berita`/`landing`, not yet a required status check.
- Two corrections to `docs/template.md`'s wave-0 draft, made in this same
  change: `SECURITY.md` carries no rewritable contact line as the tree
  actually stands, and `SITE_NAME`/`SITE_URL`/`SITE_DESCRIPTION`/
  `SITE_PROFILE` live in `apps/storefront/.env.example`, not the root one.
