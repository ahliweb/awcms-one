-- Issue #360 (ADR-0042, PRD outcome M7) - the one index segment evaluation
-- adds to an existing table.
--
-- Evaluation derives order facts (count, paid spend, first and last paid
-- date) with ONE grouped scan of a tenant's paid orders, not one lookup per
-- customer. This partial covering index lets that scan be an index-only scan
-- over just the paid, live orders: `customer_id`, `total` and `status` are the
-- only other columns the aggregate reads. It is a plain index on the existing
-- `awcms_commerce_orders` (no new column, no data change); the predicate
-- matches the evaluator's "paid order" definition exactly
-- (`application/segment-sql.ts`).
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_paid_facts_idx
  ON awcms_commerce_orders (tenant_id, paid_at)
  INCLUDE (customer_id, total, status)
  WHERE paid_at IS NOT NULL AND deleted_at IS NULL;
