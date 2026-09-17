---
bump: patch
type: docs
impact: internal
---

# Increment-2 documentation refresh: ADR-0007..0010, mirrors, root skills, knowledge graph

Every root `docs/**` document, `README.md`/`AGENTS.md`/`SECURITY.md`, and `knowledge/curated/monorepo-map.md` described the repository as it stood after increment 1 (issue #1's slice: catalog listing + product detail, no live database). Nine implementation PRs (#34–#42, epic #21) since landed the full BjekMart/news-portal parity increment — a provisioned PostgreSQL, the complete `commerce` module (catalog depth, marketing, orders), and the complete public storefront (catalog, news, cart, checkout, order tracking, wishlist) — without a single governance document catching up. A reader following this repository's own documentation would have been told cart, checkout, and orders "do not exist yet" on a `main` where they had shipped weeks earlier.

- Rewrote every root `docs/**` document against the merged tree, verified file-by-file against the code rather than the original issue text (`arsitektur.md`, `api.md`, `cms.md`, `routing.md`, `pengujian.md`, `skema-basis-data.md`, `kamus-data.md`, `aksesibilitas.md`, `responsif.md`, `ui-ux.md`, `seo.md`); reconciled `deployment.md` and `alur-kerja-pengembangan.md` with the ops/marketing/orders PRs that postdated them.
- Added four ADRs: ADR-0007 (cart/checkout/order-tracking stay static; the browser calls `apps/cms`'s anonymous commerce endpoints directly — the revised decision from the epic's amendment), ADR-0008 (one `commerce` module, not three), ADR-0009 (guest checkout by order code + phone), ADR-0010 (manual payment and alternative courier first, gateways via outbox) — each with its Indonesian mirror, and `docs/adr/README.md`'s index updated both ways.
- Rewrote `README.md`/`AGENTS.md`'s "what is here today, and what is not" sections and gates tables for the current tree (the `check-cms` CI job, both `Check` and `check-cms` as required status checks, the local subtree divergence list); rewrote `SECURITY.md`'s attack-surface section to cover the storefront's anonymous commerce endpoints, the derived CSP, and rate limits.
- Added `.claude/skills/awcms-one-storefront` and `.claude/skills/awcms-one-commerce` (+ Indonesian mirrors, + a root skills index) — practical how-tos for adding a storefront page and a commerce table/endpoint, mirroring `apps/cms/.claude/skills/awcms-new-endpoint`'s format.
- Updated `knowledge/curated/monorepo-map.md`'s structural map for the current workspace layout.

Nothing here changes runtime behaviour; every change is documentation.
