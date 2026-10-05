---
"awcms": minor
---

feat(commerce): procurement integration with the stock ledger - ledger-reference lookup and orphan detection (Issue #283, ADR-0038 addendum)

Adds `GET /api/v1/commerce/inventory/items` (`application/commerce-inventory-items.ts`, `commerce.inventory.read`) resolving a SKU or name to the `commerce.variant` / `commerce.product` ledger reference a procurement line must carry, and an `orphans` section on the first page of `GET /api/v1/commerce/inventory/reconciliation` (`listLedgerOrphans`, a read-only `SELECT` of `awcms_inventory_balances`; `not_found`, `product_has_variants`, `wrong_unit`, `unknown_item_type`, capped at 100). No migration.
