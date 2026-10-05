---
bump: minor
type: structure
impact: public
---

# Commerce stock on the upstream inventory ledger (issue #282, ADR-0038)

A tenant's commerce stock was one integer on each product and variant. Upstream AWCMS now ships a multi-location stock ledger (module `inventory`, embedded by the v10.5.0 sync), and a store can move onto it **without a second source of truth**: in the new `ledger` mode the ledger is authoritative and `stock` becomes a write-through cache of it, so the storefront, cart quote, POS, barcodes and admin lists read exactly what they read before. The default, `counter`, is today's behaviour byte for byte. Decision and rejected alternatives: `docs/adr/0038-commerce-stock-is-a-write-through-cache-of-the-inventory-ledger.md`; operator runbook in `docs/deployment.md`.

- New: `apps/cms/sql/947_awcms_commerce_inventory_adapter.sql` — `inventory_mode` / `inventory_location_id` (composite FK to the inventory location) / `inventory_mode_changed_at` on `awcms_commerce_store_settings`, two `commerce.inventory.{read,configure}` permissions, and the `awcms_worker` inventory grants the expiry job and the cache projector need (a column-level `UPDATE (updated_at)` on locations, never a table-level one). Existing tenants run `bun run identity-access:permissions:backfill` to receive the permissions.
- New: `bun run commerce:inventory:cutover --tenant <id> --location <id> [--commit]` — dry-run by default; one transaction posts an `opening` per stock unit, flips the mode and verifies, behind an exclusive per-tenant mode lock. A second run is refused.
- In `ledger` mode an order or POS sale posts `sale`, a cancel/expiry restock and a return's restock post `sale_return`, through the ledger port inside the caller's transaction, sorted against deadlocks and in a savepoint: an out-of-stock cart is still `409 CART_CHANGED` / `PosCartChangedError` with nothing written, and eight parallel orders for the last unit sell exactly one. Any other ledger refusal is `409 INVENTORY_UNAVAILABLE`.
- A movement made by something else (a receipt, an adjustment, a transfer) reaches the cache through the new `commerce.inventory_stock_cache_projector` consumer, which re-reads the ledger and never trusts the payload. This is a recorded local divergence in `consumer-registry.ts` (see `AGENTS.md`).
- A product/variant edit, a create with stock, or a CSV stock change that would change a count is `409 STOCK_MANAGED_BY_INVENTORY` in `ledger` mode (the unchanged value is accepted).
- New endpoints: `GET /api/v1/commerce/inventory`, `GET …/inventory/reconciliation`, `POST …/inventory/resync`, `POST …/inventory/rollback` (`commerce.inventory.read` / `.configure`). `commerce` now declares a dependency on `inventory`.
- Low stock is upstream's `inventory.low_stock` projection, not a commerce report (supersedes the ADR-0035 D1 note for #282).
- **Backward compatible, opt-in per tenant.** Nothing changes until an operator runs the cut-over; `POST …/inventory/rollback` returns a tenant to the counter.
