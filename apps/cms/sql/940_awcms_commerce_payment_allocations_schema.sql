-- Issue #285 (epic #281, ADR-0025) — payment-allocation ledger:
-- `awcms_commerce_payment_allocations`, the append-only record of every
-- amount of money that settled (or un-settled) an order, per tender. Next
-- free numbers in the reserved commerce 9xx range (ADR-0015): this issue owns
-- 940-944 (940 schema, 941 permissions, 942 worker grants, 943 backfill; 944
-- is held and unused).
--
-- Same conventions as `sql/901`/`sql/917`/`sql/936` (not repeated in full):
-- `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation policy, `id uuid`
-- PK `DEFAULT gen_random_uuid()`, `numeric(14,2)` money (ADR-0003), an index
-- for every FK column, `text` + `CHECK` for every enumerated column (never a
-- native ENUM — `sql/901`'s header).
--
-- ## Why a ledger, and why not a column on `awcms_commerce_orders`
--
-- Until now an order's payment was ONE fact: `payment_method` (how the
-- customer said they would pay) plus `payment_status` (a single axis that the
-- order-status machine overwrote to `paid` the moment `pending_payment -> paid`
-- ran). That cannot say "Rp 60.000 cash and Rp 40.000 QRIS", "Rp 50.000 paid,
-- Rp 50.000 still due" or "Rp 20.000 of that was refunded". This table can:
-- every row is one tender leg (or one compensating reversal of an earlier
-- leg), and the order's settlement is DERIVED from the rows —
--
--   settled = SUM(amount) over succeeded `payment` rows
--           - SUM(amount) over succeeded `reversal` rows
--   outstanding = order.total - settled
--
-- Nothing stores a running balance, so a balance can never drift from the
-- rows that justify it (the same "derive, never denormalise a total" rule
-- the loyalty and gift-card ledgers of epic #281 follow).
-- `awcms_commerce_orders.payment_status` stays, as a CACHE of that derivation
-- (`application/payment-allocation-directory.ts` rewrites it in the same
-- transaction as every ledger insert) so the existing admin list filter and
-- storefront order record keep their one-column read; this migration only
-- widens its CHECK with `partially_paid`.
--
-- ## Append-only, mechanically
--
--   * `awcms_app` loses DELETE (the REVOKE at the bottom — `sql/125`'s
--     precedent: `sql/019` granted all four verbs on every table, so a
--     migration that merely does not GRANT DELETE withholds nothing).
--   * A BEFORE UPDATE trigger freezes every column of a row except one
--     transition: `status` `pending` -> `succeeded`|`failed` (a gateway leg
--     created when the hosted-checkout session opens and resolved by the
--     webhook/reconcile job), which also stamps `settled_at`. An amount, a
--     tender, a reference or an actor can never be edited after the fact — a
--     mistake is corrected by a NEW `reversal` row, exactly as a bookkeeping
--     ledger works.
--   * `awcms_worker` keeps SELECT + DELETE (`sql/942`) only because the
--     generic data-lifecycle engine needs it for the retention ceiling
--     declared in `commerce/module.ts` (ten years — fiscal-record horizon).
--
-- ## Columns worth explaining
--
--   * `kind`: `payment` (money received) or `reversal` (money given back / a
--     mistaken entry cancelled). `reverses_allocation_id` is set on a reversal
--     and only on a reversal, and points at the succeeded `payment` row it
--     compensates; a reversal's `tender_type` is copied from that row by the
--     application (a refund goes back the way it came), and the sum of a
--     payment's reversals can never exceed its amount (enforced under the
--     order-row lock in the application — a CHECK cannot span rows).
--   * `status`: `succeeded` for every manual/cash leg (the operator is
--     attesting the money is in hand); `pending` -> `succeeded`/`failed` only
--     for a `gateway` leg. A pending or failed leg never counts toward
--     `settled`.
--   * `tender_type`: `cash`, `manual_qris`, `manual_bank_transfer`,
--     `gateway`. Store credit / gift card are NOT in the list on purpose — the
--     value ledgers of #288/#289 do not exist yet, and a CHECK value no code
--     path can write is a claim, not a feature; widen the constraint in the
--     migration that ships the first writer.
--   * `tendered_amount` / `change_amount`: the CASH leg only. `amount` is what
--     was APPLIED to the order; `tendered_amount` is what the customer handed
--     over; `change_amount` is what went back. The CHECK makes
--     `tendered = amount + change` an invariant of the row, so change can
--     never be fabricated on a non-cash leg or used to hide a shortfall on
--     another tender (the application computes change from the cash leg only,
--     after every non-cash leg has been subtracted from the amount due).
--   * `source` / `actor_kind` / `actor_tenant_user_id`: who recorded the leg
--     and through which door. `actor_tenant_user_id` is a plain uuid STAMP,
--     not a FK — `sql/931`'s reasoning for `pos_cashier_tenant_user_id`: a
--     fiscal record must outlive the staff account that rang it up.
--   * `source`: `gateway_checkout` is the pending gateway leg opened with the
--     hosted-checkout session (it keeps that source when it later resolves —
--     the trigger freezes the column, and WHO resolved it is in the audit
--     trail and the `payment.recorded` event); `gateway_webhook` /
--     `gateway_reconcile` are for a gateway leg that had no pending row to
--     resolve (a session opened before this ledger existed).
--   * `source_key`: the row-level idempotency key, `UNIQUE (tenant_id,
--     source_key)`. The API layer also uses the shared `awcms_idempotency_keys`
--     store (replay/conflict semantics for a retried HTTP request); this
--     column is the independent second guard for the paths that have no
--     client-supplied key at all — `gateway:{provider}:{provider_ref}` (a
--     webhook replay, or the reconcile job racing the webhook, can never
--     double-allocate), `confirmation:{id}` (an accepted manual-transfer
--     confirmation), `backfill:{order id}` (this migration set's own backfill,
--     `sql/943`).
--
-- ## Tenant-safe references
--
-- Both references are COMPOSITE foreign keys on `(tenant_id, …)`, backed by a
-- `UNIQUE (tenant_id, id)` on the referenced table — so even a bug (or a
-- caller holding a service credential that bypasses RLS) cannot attach an
-- allocation of tenant A to an order or a payment of tenant B. The unique
-- index on `awcms_commerce_orders (tenant_id, id)` is redundant with the
-- primary key as a constraint but is what PostgreSQL requires of a composite
-- FK target; it is created here, additively, and changes nothing for existing
-- readers.

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_id_id_key
  ON awcms_commerce_orders (tenant_id, id);

CREATE TABLE IF NOT EXISTS awcms_commerce_payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'payment',
  reverses_allocation_id uuid,
  tender_type text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  status text NOT NULL DEFAULT 'succeeded',
  provider text,
  provider_reference text,
  tendered_amount numeric(14, 2),
  change_amount numeric(14, 2),
  note text,
  source text NOT NULL,
  source_key text NOT NULL,
  actor_kind text NOT NULL,
  actor_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- Insertion order. Every leg of one POS sale is written in one transaction,
  -- so they share `created_at = now()`; without this the tie fell to the
  -- random `id` and a receipt could list the tenders in a different order
  -- from the one the cashier entered them in.
  entry_seq bigint GENERATED ALWAYS AS IDENTITY,
  CONSTRAINT awcms_commerce_payment_allocations_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_payment_allocations_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_payment_allocations_reverses_fk
    FOREIGN KEY (tenant_id, reverses_allocation_id)
    REFERENCES awcms_commerce_payment_allocations (tenant_id, id),
  CONSTRAINT awcms_commerce_payment_allocations_kind_check
    CHECK (kind IN ('payment', 'reversal')),
  CONSTRAINT awcms_commerce_payment_allocations_tender_type_check
    CHECK (tender_type IN ('cash', 'manual_qris', 'manual_bank_transfer', 'gateway')),
  CONSTRAINT awcms_commerce_payment_allocations_status_check
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  CONSTRAINT awcms_commerce_payment_allocations_amount_check
    CHECK (amount > 0),
  CONSTRAINT awcms_commerce_payment_allocations_source_check
    CHECK (source IN ('pos', 'admin', 'storefront_manual', 'gateway_checkout', 'gateway_webhook', 'gateway_reconcile', 'backfill')),
  CONSTRAINT awcms_commerce_payment_allocations_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 255),
  CONSTRAINT awcms_commerce_payment_allocations_actor_check
    CHECK (
      (actor_kind = 'tenant_user' AND actor_tenant_user_id IS NOT NULL) OR
      (actor_kind = 'system' AND actor_tenant_user_id IS NULL)
    ),
  -- A reversal names the payment it compensates; a payment never does.
  CONSTRAINT awcms_commerce_payment_allocations_reversal_link_check
    CHECK ((kind = 'reversal') = (reverses_allocation_id IS NOT NULL)),
  -- A reversal is a fact the moment it is written — never pending/failed.
  CONSTRAINT awcms_commerce_payment_allocations_reversal_status_check
    CHECK (kind = 'payment' OR status = 'succeeded'),
  -- Only a gateway leg can wait on an outside party.
  CONSTRAINT awcms_commerce_payment_allocations_pending_gateway_check
    CHECK (status = 'succeeded' OR tender_type = 'gateway'),
  -- `settled_at` is stamped exactly when the row stops being pending.
  CONSTRAINT awcms_commerce_payment_allocations_settled_at_check
    CHECK ((status = 'pending') = (settled_at IS NULL)),
  -- A gateway leg always names its provider; no other tender does.
  CONSTRAINT awcms_commerce_payment_allocations_provider_check
    CHECK ((tender_type = 'gateway') = (provider IS NOT NULL)),
  -- Cash change: only a cash PAYMENT carries tendered/change, together, and
  -- `tendered = amount + change` is an invariant of the row.
  CONSTRAINT awcms_commerce_payment_allocations_cash_change_check
    CHECK (
      (tendered_amount IS NULL AND change_amount IS NULL) OR
      (
        tender_type = 'cash' AND kind = 'payment'
        AND tendered_amount IS NOT NULL AND change_amount IS NOT NULL
        AND change_amount >= 0
        AND tendered_amount = amount + change_amount
      )
    ),
  -- The backfill is the platform speaking, never a person.
  CONSTRAINT awcms_commerce_payment_allocations_backfill_actor_check
    CHECK (source <> 'backfill' OR actor_kind = 'system')
);

-- Row-level idempotency (see header): one ledger row per source key per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_source_key
  ON awcms_commerce_payment_allocations (tenant_id, source_key);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_tenant_idx
  ON awcms_commerce_payment_allocations (tenant_id);

-- The order's own ledger read (`listAllocationsForOrder`, the settlement sum).
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_tenant_order_idx
  ON awcms_commerce_payment_allocations (tenant_id, order_id, created_at);

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_order_idx
  ON awcms_commerce_payment_allocations (order_id);

-- The tender-mix report's range scan, and the (tenant, cursor) composite the
-- generic purge engine's `commerce.payment_allocations` descriptor requires.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_tenant_created_idx
  ON awcms_commerce_payment_allocations (tenant_id, created_at);

-- "How much of this payment has already been reversed" (the reversal cap).
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_reverses_idx
  ON awcms_commerce_payment_allocations (tenant_id, reverses_allocation_id)
  WHERE reverses_allocation_id IS NOT NULL;

ALTER TABLE awcms_commerce_payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_payment_allocations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_payment_allocations_tenant_isolation
  ON awcms_commerce_payment_allocations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only guard. The only legal UPDATE is a pending gateway leg
-- resolving; every other column is frozen. The BEGIN/END below are PL/pgSQL
-- block delimiters inside a dollar-quoted body, not transaction control —
-- `sql/033`'s precedent (the migration runner strips dollar-quoted blocks
-- before its transaction-control scan).
CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_guard()
RETURNS trigger AS $awcms_commerce_payment_allocations_guard$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION
      'awcms_commerce_payment_allocations row % is append-only: only a pending gateway leg may resolve to succeeded/failed (a correction is a new reversal row)',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.reverses_allocation_id IS DISTINCT FROM OLD.reverses_allocation_id
    OR NEW.tender_type IS DISTINCT FROM OLD.tender_type
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
    OR NEW.tendered_amount IS DISTINCT FROM OLD.tendered_amount
    OR NEW.change_amount IS DISTINCT FROM OLD.change_amount
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.actor_kind IS DISTINCT FROM OLD.actor_kind
    OR NEW.actor_tenant_user_id IS DISTINCT FROM OLD.actor_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_payment_allocations row % is append-only: resolving a pending leg may change only status/settled_at',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_payment_allocations_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_payment_allocations_append_only
  ON awcms_commerce_payment_allocations;
CREATE TRIGGER awcms_commerce_payment_allocations_append_only
  BEFORE UPDATE ON awcms_commerce_payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_payment_allocations_guard();

-- `sql/019` granted `awcms_app` all four verbs on every table in the schema;
-- an append-only ledger must not be deletable by the role that records it.
-- UPDATE stays (the pending -> succeeded/failed transition) and is narrowed
-- to that one transition by the trigger above.
REVOKE DELETE ON awcms_commerce_payment_allocations FROM awcms_app;

-- Widen `payment_status` with `partially_paid` — the derived state between
-- `unpaid` and `paid` (a plain CHECK cannot be altered in place; `sql/931`'s
-- precedent for `payment_method`). No data change: every existing row keeps
-- the value it has.
ALTER TABLE awcms_commerce_orders
  DROP CONSTRAINT IF EXISTS awcms_commerce_orders_payment_status_check;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_payment_status_check
  CHECK (payment_status IN ('unpaid', 'partially_paid', 'dp_paid', 'paid', 'refunded'));

-- The outstanding-balances report's own scan: orders still owing something.
CREATE INDEX IF NOT EXISTS awcms_commerce_orders_tenant_unsettled_idx
  ON awcms_commerce_orders (tenant_id, created_at DESC)
  WHERE payment_status IN ('unpaid', 'partially_paid', 'dp_paid')
    AND status NOT IN ('cancelled', 'expired')
    AND deleted_at IS NULL;

COMMENT ON TABLE awcms_commerce_payment_allocations IS
  'Issue #285 (ADR-0025) — append-only payment ledger: one row per tender leg or compensating reversal. An order''s settlement is DERIVED from these rows; awcms_commerce_orders.payment_status is a cache of that derivation.';
COMMENT ON COLUMN awcms_commerce_payment_allocations.amount IS
  'The amount APPLIED to the order (numeric(14,2), > 0). For a cash leg this excludes change — see tendered_amount/change_amount.';
COMMENT ON COLUMN awcms_commerce_payment_allocations.source_key IS
  'Row-level idempotency key, unique per tenant: gateway:{provider}:{provider_ref}, confirmation:{id}, backfill:{order id}, api:{Idempotency-Key}, pos:{Idempotency-Key}:{n}.';
COMMENT ON COLUMN awcms_commerce_orders.payment_status IS
  'Cache of the payment-allocation ledger derivation (Issue #285): unpaid | partially_paid | dp_paid | paid | refunded. Independent of status (the order lifecycle).';
