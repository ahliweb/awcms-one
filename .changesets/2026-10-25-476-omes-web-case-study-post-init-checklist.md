---
bump: minor
type: docs
impact: public
---

# OMES-Web case study, post-init checklist, and a CHANGELOG reset that sticks (issue #476)

`docs/template.md` (and its Indonesian mirror) gains a case study of the first derived product, OMES-Web, with anti-duplication rules and compatibility and upgrade guidance, and `template:init` now ends by printing a post-init checklist. Reading the product's repository to write the case study also exposed a defect in the tool, fixed here.

- **Case study.** What OMES-Web owns, what it consumes, and the evidence it produced (stale identity prose, a hardcoded host version, an aged changeset backlog, a missing merge-commit-only setting, a 155-commit sync backlog). Everything is read from `ahliweb/omes-web`; open items are marked open. Nothing in the template names the product.
- **Anti-duplication rules** for what a derived product must not copy, fork or restate, and **compatibility guidance** for subtree sync (ancestry, main-only remote without tags, merge commit only), repository settings, changesets and the CHANGELOG after a fork, and adopting later template releases.
- **Post-init checklist.** `template:init` prints seven governance areas and says which parts it rewrites and which stay manual (the README title and body, `AGENTS.md`, `CONTRIBUTING*`, `compose.production.yaml` and others still name awcms-one). It is generated from `tools/template-init/checklist.mjs`, and `tests/template-init.test.mjs` checks every automatic claim against the real plan and that no manual file is rewritten.
- **Fix: the CHANGELOG reset was silently undone.** The doc-citation cleanup read `CHANGELOG.md` from disk instead of the reset text and wrote it back over the reset, so a derived repository kept every template release under a `package.json` at `0.1.0`. The reset text is now the starting point, and the test asserts a single `## [` heading is left. `tests/rilis-catatan.test.mjs` no longer requires the template's own `v0.1.0` history in a derived repository.
- **Leakage test widened.** The values `template:init` owns in `.env.example` and `apps/storefront/.env.example`, and the reset `CHANGELOG.md`, are now scanned for BjekMart strings for all three profiles.
- A repository initialised before this fix may still carry the template's history in `CHANGELOG.md`; the case study describes the relabel OMES-Web used.
