---
bump: patch
type: docs
impact: internal
---

# Point AGENTS.md at product development flow v2.0.0

Adds a "Product development flow v2.0.0" section to `AGENTS.md` (and its Indonesian mirror) and a one-line pointer in `docs/alur-kerja-pengembangan.md`. Upstream `ahliweb/awcms` adopts the flow in ADR-0156: UX/UI is validated at step 4 before the ERD, step 11 runs per slice as frontend (against a mock from the contract), backend, then integration, and a screen with no data source in the contract fails gate 9.

- States what 11.1/11.2/11.3 mean here, since this repo owns its backend (ADR-0024): storefronts and apps, `apps/cms` modules, then integration.
- Records that `apps/cms/docs/awcms/alur-pengembangan.md` is upstream's copy and shows v1 numbering until the next subtree sync; `apps/cms` is untouched.
