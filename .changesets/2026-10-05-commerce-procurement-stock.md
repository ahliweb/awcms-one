---
bump: minor
type: structure
impact: public
---

# Procurement feeds commerce stock (issue #283, ADR-0038 addendum)

Upstream `awcms`'s `procurement` module (suppliers, receiving, supplier returns, requisitions, transfers; upstream ADR-0128) already posts to the inventory ledger. This change makes it work with commerce stock on a tenant in `ledger` mode, with no new table or migration:

- **Convention.** A procurement line stocking commerce goods uses `itemType` `commerce.variant` (variant uuid) or `commerce.product` (uuid of a product with no live variant), unit `unit`, at the sales location (or another location and then a `transfer`). New `GET /api/v1/commerce/inventory/items?q=<sku or name>` (`commerce.inventory.read`, keyset-paged, at most 50) resolves a SKU or name to `{ itemType, itemRef, sku, name, variantName, unitCode }`.
- **Orphan detection.** `GET /api/v1/commerce/inventory/reconciliation` now also returns, on its first page, `orphans`: non-zero `commerce.*` ledger balances at the sales location naming no live unit (`not_found`, `product_has_variants`, `wrong_unit`, `unknown_item_type`), capped at 100 with `truncated`.
- **Counter mode.** A procurement receipt on a `counter` tenant stays in the ledger and does not change commerce stock - cut over to `ledger` first (runbook in `docs/deployment.md`; existing tenants run `identity-access:permissions:backfill` for `procurement.*`).
- **Reporting.** Upstream's `procurement.receiving` / `procurement.suppliers` projections are the receiving reports (supersedes the ADR-0035 D1 note for #283).
- **Backward compatible.** The `orphans` field is additive; nothing changes for a tenant that never uses procurement.
