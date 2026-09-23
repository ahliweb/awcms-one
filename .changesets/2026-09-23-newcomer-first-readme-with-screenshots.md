---
bump: patch
type: docs
impact: internal
---

# A newcomer-first README, with real per-profile screenshots

`README.md` (+ `.id.md`) had grown into the same increment-by-increment chronicle `docs/status.md` (issue #188) already moved out of `AGENTS.md` — a first-time visitor to a public template had to read five increments' worth of history before reaching "how do I run this". This restructures it around what a newcomer actually needs, in order: what the platform is (one paragraph) → screenshots of the redesigned storefront per build profile → "Use this as a template" + quick start → the documentation index → running locally → architecture at a glance → gates. The chronicle itself was never deleted — it lives in [`CHANGELOG.md`](../CHANGELOG.md), and [`docs/status.md`](../docs/status.md) is the current-state reference both documents now point to.

- Three new images, `docs/assets/readme-{toko,berita,landing}.webp` — an above-the-fold, 1280×800 crop of each build profile's home page, generated with `apps/storefront`'s own Playwright e2e harness (issue #183) and converted to WebP at quality 80. Combined weight: ~72 KB, well inside a 600 KB budget for this change. `apps/storefront/scripts/screenshots-readme.mjs` and `apps/storefront/tests/e2e/screenshots.e2e.ts` gained three new flags/env vars (`--pages`/`E2E_SCREENSHOT_PAGES`, `--viewport`/`E2E_SCREENSHOT_VIEWPORTS`, `--above-fold`/`E2E_SCREENSHOT_FULLPAGE`) so this exact shot is reproducible with one command per profile — documented in `docs/pengujian.md`. `.github/workflows/e2e.yml`'s own full-page, every-page, every-viewport CI capture is unchanged, since it sets none of the new env vars.
- A CI status badge for `.github/workflows/ci.yml`.
- The "Gates" section now names `MAX_STALE_FILES` (40, issue #186's bounded knowledge-graph staleness check) and briefly lists the four workflows that run on every push but are not yet required status checks (CodeQL, the Playwright e2e suite, the GHCR image publish, the release publish).
- `tools/template-init/rewriters.mjs`'s `rewriteReadme` structural markers (the H1 hero span, the "Use this as a template" span) are unchanged in shape, so `bun run template:init` still rewrites this README correctly for a derived repository — verified with `bun test ./tests/template-init.test.mjs` and the `template-init-smoke` workflow.
