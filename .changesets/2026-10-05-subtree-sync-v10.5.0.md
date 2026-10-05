---
bump: minor
type: dependency
impact: public
---

# Sync the AWCMS subtree to v10.5.0 (`1558faa`)

`apps/cms` now embeds `ahliweb/awcms` at v10.5.0 (14 upstream commits since
`cfc2df9a`): three new upstream modules — `inventory` (multi-location stock
ledger, `sql/169`–`170`), `tax` (jurisdiction-neutral tax calculation,
`sql/171`–`173`) and `procurement` (supplier, receiving and transfer
documents, `sql/174`–`175`) with their admin screens — the `Idempotency-Key`
header as one shared OpenAPI parameter component, and a focusable named
`.data-table-scroll` region on every admin table. Merged with a merge commit,
as every subtree sync must be.

- The new modules are available in `apps/cms` but not yet wired into
  `commerce`; the adapters stay tracked in #282, #293 and #283.
- Commerce OpenAPI fragments reference upstream's shared `Idempotency-Key`
  parameter instead of declaring their own, and every commerce admin data
  table gained the focusable named scroll region.
- **Operator action:** run `bun run db:migrate` — seven new upstream migrations
  (`sql/169`–`175`) apply; no renumbering is needed (this repo's media-library
  migrations already sit in the `880` band).
- `apps/cms/scripts/client-asset-budget.ts`'s `APP_BUDGET_BYTES` is 433,800 B
  (measured 433,723 B on the merged build).
- `apps/cms/tests/openapi-bundle.test.ts`'s idempotency test carries an explicit 60 s
  timeout: two bundles of the merged document exceed bun's 5 s default under
  the full-suite load.
