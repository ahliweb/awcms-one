🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# Documentation

Architecture, schema, API, CMS workflow, storefront behaviour, testing, deployment, and process documentation for `awcms-one` — describing the repository **as it actually is in the tree today**, never as it was originally planned. Where the tree and an issue's original text disagree, these documents follow the tree, and say so. [`status.md`](status.md) is the single current-state summary these documents' own detail backs up; history — which issue or epic built which piece — lives in [`CHANGELOG.md`](../CHANGELOG.md) and the [ADR index](adr/README.md).

| Document | Contents |
| --- | --- |
| [`status.md`](status.md) | The current-state reference: what exists by surface, what does not yet, each item linking to its own detail |
| [`arsitektur.md`](arsitektur.md) | The two-deployable topology, the one-way import direction, the subtree embed, the anonymous runtime seam (ADR-0007), the third (authenticated-customer) trust tier (ADR-0016), external provider ports/outboxes/webhook intake (ADR-0017), the derived CSP |
| [`adr/`](adr/README.md) | Twenty Architecture Decision Records — the trade-off behind each structural decision above |
| [`skema-basis-data.md`](skema-basis-data.md) | The `awcms_commerce_*` tables: columns, types, constraints, indexes, RLS |
| [`kamus-data.md`](kamus-data.md) | Data dictionary: every column, its meaning, and its legacy `commerce_bj_mart` source column |
| [`api.md`](api.md) | The `/api/v1/commerce/*` endpoints, envelope, pagination, permissions, domain events |
| [`cms.md`](cms.md) | Authoring, the product state machine, permissions, audit logging, media, taxonomy |
| [`routing.md`](routing.md) | Every storefront route and how `getStaticPaths()` derives it |
| [`seo.md`](seo.md) | Metadata, `Product` JSON-LD, and the XSS defence around it |
| [`aksesibilitas.md`](aksesibilitas.md) | What is in place, and how it is verified — a real axe-core run in CI, not only by reading code |
| [`responsif.md`](responsif.md) | The mostly-fluid grid, and how it is verified — a real browser checking for overflow in CI, not only by reading code |
| [`ui-ux.md`](ui-ux.md) | The design system: tokens, product imagery, computed badge contrast, price/stock presentation |
| [`pengujian.md`](pengujian.md) | The four test tiers — which need PostgreSQL, which drive a real browser, and which do not |
| [`deployment.md`](deployment.md) | Build vs. serve, environment variables, the production topology, published images, what the container may and may not reach |
| [`alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) | Branching, real branch protection settings, changesets, the release cut |
| [`rilis.md`](rilis.md) | The end-to-end release runbook: changesets to tag, `release:images`, `release:publish`, evidence, consumer verification |
| [`template.md`](template.md) | Using awcms-one as a template: `template:init`, the build-profile matrix, per-profile seeds, BjekMart as the reference example |

## What this directory does not duplicate

[`knowledge/curated/`](../knowledge/curated/) already states five facts not inferable from code — the monorepo's structural map, subtree ownership boundaries, the backend/storefront contract seam, security/tenant-isolation pointers, and re-platform rationale — and this directory links to each rather than restating it. `apps/cms/src/modules/commerce/README.md` is the commerce module's own, code-adjacent documentation; [`cms.md`](cms.md) here links to it for field-by-field detail rather than repeating it. `apps/cms`'s own architecture, threat model, and ADR corpus (a separate numbering space from [`adr/`](adr/README.md) here) live under `apps/cms/docs/` as `ahliweb/awcms`'s own documentation, carried by the subtree embed — this repository does not govern or duplicate it.

## Language

English at the bare path is the authoritative source; Indonesian at `<name>.id.md` is the mirror, stamped by `bun run docs:i18n:stamp` after translation and checked by `bun run audit:translation`. Every document in this directory, including every file under `adr/`, is in scope for that gate — see `packages/gerbang/lib/docs-i18n-checks.mjs`'s `isInScope`, which covers everything under `docs/**`.
