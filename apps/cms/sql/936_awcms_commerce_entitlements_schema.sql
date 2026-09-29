-- Issue #267 (IRMbyDUS: entitlement module, depends on #266/sql/935) —
-- `awcms_commerce_entitlements`. Next free number in the reserved commerce
-- 9xx range (ADR-0015, `936` after `sql/935`). Follows `sql/917`'s and
-- `sql/933`'s conventions exactly (`ENABLE` + `FORCE ROW LEVEL SECURITY`,
-- one tenant-isolation `USING` policy, `id uuid` PK `DEFAULT
-- gen_random_uuid()`, `created_at`/`updated_at timestamptz DEFAULT now()`,
-- an FK index for every FK column, no per-table GRANT — `sql/019`'s `ALTER
-- DEFAULT PRIVILEGES` already covers `awcms_app`).
--
-- ## Naming: NOT `src/modules/identity-access/domain/entitlement.ts`
--
-- That file's "entitlement" is an unrelated concept — tenant/plan
-- feature-gating (ADR-0084, `awcms_entitlements`/`awcms_plans`/
-- `awcms_plan_entitlements`/`awcms_tenant_entitlements`), a deny-only
-- structural gate layered on top of authorization. THIS table answers a
-- completely different question — "did this customer buy access to this
-- product" — and is owned by `commerce`, not `identity_access`. The table
-- name is deliberately namespaced `awcms_commerce_entitlements` (not a bare
-- `awcms_entitlements`), and the application/domain files that follow live
-- under `src/modules/commerce/{domain,application}/commerce-entitlement*.ts`
-- (never a bare `entitlement.ts`, which `access:entitlement:deny-only:check`
-- already reserves for the identity-access file) so a reader, a grep, and
-- that check all keep the two apart.
--
-- ## Grant path: the order-paid domain event, idempotently
--
-- One row per (order, product): `application/commerce-entitlement-directory.ts`'s
-- `grantEntitlementsForPaidOrder` inserts one row per line item of a PAID
-- order (`awcms_commerce_order_items.product_id`), called from the
-- `commerce.order_paid_entitlement_grantor` consumer
-- (`domain-event-runtime/infrastructure/consumer-registry.ts`) registered
-- against `COMMERCE_ORDER_PAID_EVENT_TYPE`. Two independent idempotency
-- mechanisms, deliberately, the same "no single point of duplication"
-- discipline `application/consumer-effect.ts`'s own header argues for:
--
--   1. `applyConsumerEffectOnce` (this repo's standard per-(consumer, event)
--      marker) guards the whole handler against a REDELIVERED event;
--   2. the UNIQUE index below (`tenant_id, source_order_id, product_id`)
--      guards the INSERT itself against any other path that could re-run the
--      same grant (a manual replay, a future second consumer, a retry that
--      raced the marker) — `grantEntitlementsForPaidOrder` inserts with
--      `ON CONFLICT ... DO NOTHING`, so firing the same order-paid event
--      twice yields exactly one row per (order, product), never two.
--
-- `source_order_id` is part of the identity on purpose: a customer who buys
-- the SAME product in two different orders gets two independent grant rows
-- (each traceable to the order that paid for it), not one row silently
-- reused — the same "an order is the tenant's own transaction record"
-- reasoning `sql/913`'s `awcms_commerce_orders` descriptor already applies.
--
-- ## Revocation: admin-endpoint-only, a status flip, never a DELETE
--
-- `status` is `active`/`revoked`, never removed by row: `order-status.ts`'s
-- own header records that this codebase has NO `refunded` order status or
-- event yet, so there is nothing to hook an automatic revoke-on-refund to.
-- `application/commerce-entitlement-directory.ts`'s `revokeEntitlementByAdmin`
-- is therefore the ONLY revocation path today — sets `revoked_at`/`status`,
-- audited via `entitlement.revoked` (`logging/application/audit-log.ts`),
-- exactly as `entitlement.granted` audits the other direction. `verifyEntitlement`
-- reads `status`/`revoked_at` directly off this table on every call — no
-- cache, so a revoke takes effect on the very next check.
--
-- ## RLS: tenant isolation only, owner-scoping stays application-level
--
-- Same shape as `awcms_commerce_customer_accounts`/`_customer_sessions`/
-- `_orders`: ADR-0016 D1 keeps a customer OUT of this schema's
-- tenant_user/identity/profile/principal RLS vocabulary entirely (there is
-- no `app.current_customer_id` session variable anywhere in this codebase),
-- so a second `USING` clause keyed on the calling customer is not a shape
-- this system has. Owner-scoping for the customer-facing "my entitlements"/
-- "entitlement check" routes is enforced the same way
-- `application/order-directory.ts`'s `listOrdersForAccount` already enforces
-- it for orders: the customer id is read ONLY from the verified bearer
-- session (`requireCustomerSession`), never accepted from request input, and
-- every query in `commerce-entitlement-directory.ts` filters on it
-- explicitly.

CREATE TABLE IF NOT EXISTS awcms_commerce_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  owner_customer_id uuid NOT NULL REFERENCES awcms_commerce_customers (id),
  product_id uuid NOT NULL REFERENCES awcms_commerce_products (id),
  source_order_id uuid NOT NULL REFERENCES awcms_commerce_orders (id),
  status text NOT NULL DEFAULT 'active',
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_entitlements_status_check
    CHECK (status IN ('active', 'revoked')),
  -- A revoked row must carry when it was revoked, and an active row must
  -- not — the two columns are not allowed to disagree with `status`.
  CONSTRAINT awcms_commerce_entitlements_revoked_at_check
    CHECK (
      (status = 'active' AND revoked_at IS NULL) OR
      (status = 'revoked' AND revoked_at IS NOT NULL)
    )
);

-- The idempotency guard the header describes: one grant per (order, product).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_entitlements_order_product_key
  ON awcms_commerce_entitlements (tenant_id, source_order_id, product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_tenant_idx
  ON awcms_commerce_entitlements (tenant_id);

-- The (tenant, cursor) composite `data-lifecycle:registry:check` requires
-- for every table's `dataLifecycle` descriptor — this table's generic purge
-- engine query filters + orders by (tenant_id, revoked_at), even though the
-- purge predicate can never actually match (see this migration's own header
-- and the descriptor's `deletion.rationale` in `commerce/module.ts`).
CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_tenant_revoked_idx
  ON awcms_commerce_entitlements (tenant_id, revoked_at);

-- `verifyEntitlement(customerId, productId)`'s own lookup shape — the one
-- query this whole module exists to answer quickly.
CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_tenant_owner_product_idx
  ON awcms_commerce_entitlements (tenant_id, owner_customer_id, product_id)
  WHERE status = 'active';

-- "My entitlements" list — newest grant first, for one customer.
CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_tenant_owner_idx
  ON awcms_commerce_entitlements (tenant_id, owner_customer_id, granted_at DESC);

CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_product_idx
  ON awcms_commerce_entitlements (product_id);

CREATE INDEX IF NOT EXISTS awcms_commerce_entitlements_source_order_idx
  ON awcms_commerce_entitlements (source_order_id);

ALTER TABLE awcms_commerce_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_entitlements FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_entitlements_tenant_isolation
  ON awcms_commerce_entitlements
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
