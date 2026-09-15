---
bump: minor
type: docs
impact: public
---

# Architecture and reference documentation, describing the merged tree as it actually is

Adds `docs/` (issue #7): architecture, six ADRs, the database schema, a data dictionary mapping every `awcms_commerce_*` column to its legacy `commerce_bj_mart` source column, the commerce API, the CMS authoring workflow, storefront routing, SEO, accessibility, responsive design, UI/UX, testing, deployment, and the development workflow — plus `docs/README.md` as the index. Every document is mirrored to Indonesian (`docs:i18n:stamp`) and lands with `AGENTS.md`/`README.md` updated to describe the tree as it now is: every child issue of #1 (#2, #4, #5, #6, #11) has landed, so the "not here yet" framing both documents carried is retired.

- `bun run audit:dokumen`'s ADR-index and `ADR-NNNN`-citation checks run for real for the first time in this repository, now that `docs/adr/` exists — both green against the six ADRs landed here.
- Where the tree disagreed with the original issue text, the documents follow the tree: the URL shape (`/product/{slug}`, per the live-site evidence on issue #5), the real API envelope (`{ items, nextCursor }`, not the originally assumed shape), and the real, verified branch-protection settings (a required `Check` status check; no merge-strategy restriction) are what is documented, not what was planned.
- A pre-existing, unrelated defect surfaced by activating the ADR-citation check for the first time — a generated Obsidian note under `knowledge/generated/graphify/` extracts `packages/gerbang/audit-dokumen.mjs`'s own illustrative example (`` `ADR-0042` ``) as a false citation — is filed as [issue #15](https://github.com/ahliweb/awcms-one/issues/15) rather than patched here, since fixing it needs a change to `packages/gerbang/` or a knowledge-graph regeneration, both outside this change's own scope.
