🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# Documentation

Architecture, schema, API, CMS workflow, storefront behaviour, testing, deployment, and process documentation for `awcms-one` — describing the repository **as it actually is after every implementation PR merged** (increment 1: issues #2–#6, #11; increment 2, epic [#21](https://github.com/ahliweb/awcms-one/issues/21): issues #22–#30; increment 3, epic [#46](https://github.com/ahliweb/awcms-one/issues/46): issues #47–#60; increment 4, epic [#32](https://github.com/ahliweb/awcms-one/issues/32): issues #86–#93), never as it was originally planned. Where the tree and an issue's original text disagree, these documents follow the tree, and say so.

| Document | Contents |
| --- | --- |
| [`arsitektur.md`](arsitektur.md) | The two-deployable topology, the one-way import direction, the subtree embed, the anonymous runtime seam (ADR-0007), the third (authenticated-customer) trust tier (ADR-0016), the derived CSP |
| [`adr/`](adr/README.md) | Sixteen Architecture Decision Records — the trade-off behind each structural decision above |
| [`skema-basis-data.md`](skema-basis-data.md) | The `awcms_commerce_*` tables: columns, types, constraints, indexes, RLS |
| [`kamus-data.md`](kamus-data.md) | Data dictionary: every column, its meaning, and its legacy `commerce_bj_mart` source column |
| [`api.md`](api.md) | The `/api/v1/commerce/*` endpoints, envelope, pagination, permissions, domain events |
| [`cms.md`](cms.md) | Authoring, the product state machine, permissions, audit logging, media, taxonomy |
| [`routing.md`](routing.md) | Every storefront route and how `getStaticPaths()` derives it |
| [`seo.md`](seo.md) | Metadata, `Product` JSON-LD, and the XSS defence around it |
| [`aksesibilitas.md`](aksesibilitas.md) | What is in place, and that it was verified by reading code, not by a tool |
| [`responsif.md`](responsif.md) | The fluid, breakpoint-free grid, and that it was verified by reading code, not a browser |
| [`ui-ux.md`](ui-ux.md) | No product imagery, computed badge contrast, price/stock presentation |
| [`pengujian.md`](pengujian.md) | The three test suites, which need PostgreSQL, and which do not |
| [`deployment.md`](deployment.md) | Build vs. serve, environment variables, what the container may and may not reach |
| [`alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) | Branching, real branch protection settings, changesets, the release cut |

## What this directory does not duplicate

[`knowledge/curated/`](../knowledge/curated/) already states five facts not inferable from code — the monorepo's structural map, subtree ownership boundaries, the backend/storefront contract seam, security/tenant-isolation pointers, and re-platform rationale — and this directory links to each rather than restating it. `apps/cms/src/modules/commerce/README.md` is the commerce module's own, code-adjacent documentation; [`cms.md`](cms.md) here links to it for field-by-field detail rather than repeating it. `apps/cms`'s own architecture, threat model, and ADR corpus (a separate numbering space from [`adr/`](adr/README.md) here) live under `apps/cms/docs/` as `ahliweb/awcms`'s own documentation, carried by the subtree embed — this repository does not govern or duplicate it.

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, stamped by `bun run docs:i18n:stamp` after translation and checked by `bun run audit:translation`. Every document in this directory, including every file under `adr/`, is in scope for that gate — see `packages/gerbang/lib/docs-i18n-checks.mjs`'s `isInScope`, which covers everything under `docs/**`.
