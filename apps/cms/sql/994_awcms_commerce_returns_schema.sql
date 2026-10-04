-- Issue #287 (ADR-0033, epic #281) — returns, refunds and exchanges.
--
-- Four tables inside the `commerce` module (ADR-0008 — one module, not a new
-- one), every one tenant-isolated the way every commerce table is: `tenant_id`
-- + ENABLE and FORCE ROW LEVEL SECURITY + one policy with a `WITH CHECK`,
-- every cross-table reference a COMPOSITE foreign key on `(tenant_id, …)` so a
-- row can never point at another tenant's order, line or payment.
--
--   * `awcms_commerce_returns`       one return (or exchange) of goods that
--                                    were sold on ONE order. Carries the
--                                    cents-exact money split (goods gross,
--                                    discount share, shipping refunded) the
--                                    refund and the sales reports both read.
--   * `awcms_commerce_return_lines`  one returned order line: how many units,
--                                    why, and what happens to them (restock /
--                                    damaged / quarantine). APPEND-ONLY.
--   * `awcms_commerce_refunds`       one refund LEG: money going back along
--                                    ONE original payment allocation, by the
--                                    original tender or into store credit.
--                                    Its status machine is the only thing
--                                    that ever changes on it.
--   * `awcms_commerce_refund_compensations`
--                                    the append-only log of the downstream
--                                    effects a settled refund had (loyalty
--                                    points taken back, affiliate commission
--                                    adjusted, store credit issued/loaded).
--                                    One row per (refund, kind): the
--                                    idempotency anchor AND the thing
--                                    reconcile reads.
--
-- ## What the database guarantees on its own
--
-- Not "the application checks it" — a buggy or concurrent writer cannot
-- break these (each has an integration test that tries):
--
--   * Σ returned quantity of an order line <= the quantity sold: a BEFORE
--     INSERT trigger on the return lines locks the order-item row and sums.
--     The application also locks the order first, so two returns of one order
--     queue; the trigger is the independent second guard (two raw inserts on
--     two connections still cannot over-return).
--   * Σ shipping refunded on an order <= the shipping it was charged.
--   * Σ of the active refund legs (pending / processing) + the reversals
--     already booked <= the payment they refund: a BEFORE trigger on refunds.
--   * `return_lines` and `refund_compensations` are append-only; `returns`
--     and `refunds` change only along their status machines.
--   * Retries: `UNIQUE (tenant_id, source_key)` on returns and refunds, and
--     `UNIQUE (tenant_id, refund_id, kind)` on compensations.
--
-- `awcms_app` loses DELETE on all four (sql/019 grants every verb by default;
-- the REVOKE is what achieves it) and UPDATE on the two append-only ones; only
-- the retention worker deletes (sql/997).

-- The line reference below needs a (tenant_id, id) target.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_order_items_tenant_id_id_key
  ON awcms_commerce_order_items (tenant_id, id);

-- ---------------------------------------------------------------------------
-- returns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  -- `exchange` = a return whose replacement is a SEPARATE order linked below;
  -- an order's lines are never edited in place.
  kind text NOT NULL DEFAULT 'return',
  -- `open` until every refund leg has settled (or at once when nothing is
  -- refunded); then `completed`. Never reopened.
  status text NOT NULL DEFAULT 'open',
  note text,
  -- Cents-exact split. goods_gross = Σ line goods (pre-discount),
  -- discount_share = the order discount released with them,
  -- refund_total = goods_gross - discount_share + shipping_refund.
  goods_gross numeric(14, 2) NOT NULL DEFAULT 0,
  discount_share numeric(14, 2) NOT NULL DEFAULT 0,
  shipping_refund numeric(14, 2) NOT NULL DEFAULT 0,
  refund_total numeric(14, 2) NOT NULL DEFAULT 0,
  exchange_order_id uuid,
  source_key text NOT NULL,
  actor_tenant_user_id uuid NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_returns_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_returns_source_key_key
    UNIQUE (tenant_id, source_key),
  CONSTRAINT awcms_commerce_returns_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_returns_exchange_order_fk
    FOREIGN KEY (tenant_id, exchange_order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_returns_kind_check
    CHECK (kind IN ('return', 'exchange')),
  CONSTRAINT awcms_commerce_returns_status_check
    CHECK (status IN ('open', 'completed')),
  CONSTRAINT awcms_commerce_returns_amounts_check
    CHECK (
      goods_gross >= 0 AND discount_share >= 0 AND shipping_refund >= 0
      AND discount_share <= goods_gross
      AND refund_total = goods_gross - discount_share + shipping_refund
    ),
  CONSTRAINT awcms_commerce_returns_exchange_check
    CHECK (
      exchange_order_id IS NULL
      OR (kind = 'exchange' AND exchange_order_id <> order_id)
    ),
  CONSTRAINT awcms_commerce_returns_completed_check
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT awcms_commerce_returns_note_check
    CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT awcms_commerce_returns_source_key_length_check
    CHECK (length(source_key) BETWEEN 1 AND 300)
);

-- The order detail's list, and the (tenant, cursor) composite the generic
-- purge engine filters by.
CREATE INDEX IF NOT EXISTS awcms_commerce_returns_order_idx
  ON awcms_commerce_returns (tenant_id, order_id, created_at);
CREATE INDEX IF NOT EXISTS awcms_commerce_returns_tenant_created_idx
  ON awcms_commerce_returns (tenant_id, created_at);
-- FK index for `exchange_order_fk`.
CREATE INDEX IF NOT EXISTS awcms_commerce_returns_exchange_order_idx
  ON awcms_commerce_returns (tenant_id, exchange_order_id)
  WHERE exchange_order_id IS NOT NULL;

ALTER TABLE awcms_commerce_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_returns FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_returns_tenant_isolation
  ON awcms_commerce_returns
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_returns FROM awcms_app;

-- The BEGIN/END below are PL/pgSQL block delimiters inside a dollar-quoted
-- body, not transaction control — `sql/033`'s precedent (the migration runner
-- strips dollar-quoted blocks before its transaction-control scan).

-- Σ shipping refunded on an order may not exceed the shipping it was charged.
-- Locks the order row first (the same lock every ledger writer takes), so two
-- returns of one order cannot both pass the check.
CREATE OR REPLACE FUNCTION awcms_commerce_returns_insert_guard()
RETURNS trigger AS $awcms_commerce_returns_insert_guard$
DECLARE
  charged numeric(14, 2);
  already numeric(14, 2);
BEGIN
  SELECT shipping_cost INTO charged
  FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'awcms_commerce_returns: order % not found', NEW.order_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  SELECT COALESCE(SUM(shipping_refund), 0) INTO already
  FROM awcms_commerce_returns
  WHERE tenant_id = NEW.tenant_id AND order_id = NEW.order_id;
  IF already + NEW.shipping_refund > COALESCE(charged, 0) THEN
    RAISE EXCEPTION
      'awcms_commerce_returns: shipping refunded on order % would exceed the shipping charged (%)',
      NEW.order_id, COALESCE(charged, 0)
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_returns_insert_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_returns_insert_guard
  ON awcms_commerce_returns;
CREATE TRIGGER awcms_commerce_returns_insert_guard
  BEFORE INSERT ON awcms_commerce_returns
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_returns_insert_guard();

-- A return is history: only its status (open -> completed, once) and its
-- exchange link (NULL -> an order, once) ever change.
CREATE OR REPLACE FUNCTION awcms_commerce_returns_update_guard()
RETURNS trigger AS $awcms_commerce_returns_update_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.goods_gross IS DISTINCT FROM OLD.goods_gross
    OR NEW.discount_share IS DISTINCT FROM OLD.discount_share
    OR NEW.shipping_refund IS DISTINCT FROM OLD.shipping_refund
    OR NEW.refund_total IS DISTINCT FROM OLD.refund_total
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.actor_tenant_user_id IS DISTINCT FROM OLD.actor_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % is history: only status and the exchange link may change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'open' AND NEW.status = 'completed')
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % : status moves only open -> completed',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.exchange_order_id IS NOT NULL
    AND NEW.exchange_order_id IS DISTINCT FROM OLD.exchange_order_id
  THEN
    RAISE EXCEPTION
      'awcms_commerce_returns row % : the exchange order is linked once and never changed',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_returns_update_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_returns_update_guard
  ON awcms_commerce_returns;
CREATE TRIGGER awcms_commerce_returns_update_guard
  BEFORE UPDATE ON awcms_commerce_returns
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_returns_update_guard();

COMMENT ON TABLE awcms_commerce_returns IS
  'Issue #287 (ADR-0033) — one return or exchange of goods sold on one order. History: only status (open -> completed) and the one-time exchange link change.';

-- ---------------------------------------------------------------------------
-- return lines
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  return_id uuid NOT NULL,
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  -- Snapshots of the line's catalogue identity, so the inventory port and the
  -- sales projection never depend on the order item row being unchanged.
  product_id uuid NOT NULL,
  variant_id uuid,
  quantity integer NOT NULL,
  reason text NOT NULL,
  disposition text NOT NULL,
  -- Units that went back into SELLABLE stock (quantity for `restock`, else 0).
  stock_effect integer NOT NULL,
  goods_gross numeric(14, 2) NOT NULL,
  discount_share numeric(14, 2) NOT NULL,
  refund_amount numeric(14, 2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_return_lines_return_fk
    FOREIGN KEY (tenant_id, return_id)
    REFERENCES awcms_commerce_returns (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_return_lines_order_item_fk
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES awcms_commerce_order_items (tenant_id, id),
  CONSTRAINT awcms_commerce_return_lines_quantity_check
    CHECK (quantity > 0),
  CONSTRAINT awcms_commerce_return_lines_reason_check
    CHECK (reason IN (
      'defective', 'wrong_item', 'not_as_described', 'damaged_in_transit',
      'changed_mind', 'size_fit', 'duplicate_order', 'other'
    )),
  CONSTRAINT awcms_commerce_return_lines_disposition_check
    CHECK (disposition IN ('restock', 'damaged', 'quarantine')),
  CONSTRAINT awcms_commerce_return_lines_stock_effect_check
    CHECK (stock_effect = CASE WHEN disposition = 'restock' THEN quantity ELSE 0 END),
  CONSTRAINT awcms_commerce_return_lines_amounts_check
    CHECK (
      goods_gross >= 0 AND discount_share >= 0 AND refund_amount >= 0
      AND discount_share <= goods_gross
      AND refund_amount = goods_gross - discount_share
    ),
  CONSTRAINT awcms_commerce_return_lines_note_check
    CHECK (note IS NULL OR length(note) <= 500)
);

-- The over-return guard's SUM, the projection's per-return read, and the FK
-- index for `order_item_fk`.
CREATE INDEX IF NOT EXISTS awcms_commerce_return_lines_item_idx
  ON awcms_commerce_return_lines (tenant_id, order_item_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_return_lines_return_idx
  ON awcms_commerce_return_lines (tenant_id, return_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_return_lines_tenant_created_idx
  ON awcms_commerce_return_lines (tenant_id, created_at);

ALTER TABLE awcms_commerce_return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_return_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_return_lines_tenant_isolation
  ON awcms_commerce_return_lines
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE UPDATE, DELETE ON awcms_commerce_return_lines FROM awcms_app;

-- Σ returned quantity of an order line may never exceed the quantity sold.
-- The order-item row is locked first so two writers on two connections queue
-- here even if neither took the order lock; the lock is taken BEFORE the
-- row's own foreign-key check, so it cannot deadlock against it (ADR-0025 D4).
CREATE OR REPLACE FUNCTION awcms_commerce_return_lines_insert_guard()
RETURNS trigger AS $awcms_commerce_return_lines_insert_guard$
DECLARE
  sold integer;
  already integer;
  line_order uuid;
BEGIN
  SELECT quantity, order_id INTO sold, line_order
  FROM awcms_commerce_order_items
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_item_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'awcms_commerce_return_lines: order item % not found', NEW.order_item_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF line_order IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'awcms_commerce_return_lines: order item % does not belong to order %',
      NEW.order_item_id, NEW.order_id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO already
  FROM awcms_commerce_return_lines
  WHERE tenant_id = NEW.tenant_id AND order_item_id = NEW.order_item_id;
  IF already + NEW.quantity > sold THEN
    RAISE EXCEPTION
      'awcms_commerce_return_lines: returning % of order item % would exceed the quantity sold (% sold, % already returned)',
      NEW.quantity, NEW.order_item_id, sold, already
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_return_lines_insert_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_return_lines_insert_guard
  ON awcms_commerce_return_lines;
CREATE TRIGGER awcms_commerce_return_lines_insert_guard
  BEFORE INSERT ON awcms_commerce_return_lines
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_return_lines_insert_guard();

CREATE OR REPLACE FUNCTION awcms_commerce_append_only_guard()
RETURNS trigger AS $awcms_commerce_append_only_guard$
BEGIN
  RAISE EXCEPTION '% rows are append-only (a correction is a new row)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_append_only_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_return_lines_append_only
  ON awcms_commerce_return_lines;
CREATE TRIGGER awcms_commerce_return_lines_append_only
  BEFORE UPDATE ON awcms_commerce_return_lines
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_append_only_guard();

COMMENT ON TABLE awcms_commerce_return_lines IS
  'Issue #287 (ADR-0033) — one returned order line (units, reason, stock disposition, cents-exact value). Append-only; Σ quantity per order item <= quantity sold (trigger).';

-- ---------------------------------------------------------------------------
-- refunds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  return_id uuid NOT NULL,
  order_id uuid NOT NULL,
  -- The succeeded PAYMENT allocation this leg sends money back along.
  allocation_id uuid NOT NULL,
  -- Copied from the allocation: a refund goes back the way it came, unless it
  -- is redirected into store credit (`destination`).
  tender_type text NOT NULL,
  amount numeric(14, 2) NOT NULL,
  destination text NOT NULL DEFAULT 'original_tender',
  -- pending -> processing -> succeeded | failed; failed -> processing (retry).
  -- A cash / manual / stored-value / store-credit leg is created `succeeded`
  -- in the same transaction; only a gateway leg waits for the provider.
  status text NOT NULL DEFAULT 'pending',
  -- How it settled: `ledger` (booked as a fact — cash handed back, a manual
  -- transfer made, value returned to the account), `provider` (the gateway
  -- refund API answered), `offline` (an authorised operator attested it was
  -- made outside the system), `store_credit`.
  settled_via text,
  provider text,
  provider_reference text,
  provider_refund_id text,
  attempts integer NOT NULL DEFAULT 0,
  failure_code text,
  reversal_allocation_id uuid,
  store_credit_account_id uuid,
  offline_reason text,
  offline_by_tenant_user_id uuid,
  source_key text NOT NULL,
  actor_tenant_user_id uuid NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_refunds_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_refunds_source_key_key
    UNIQUE (tenant_id, source_key),
  CONSTRAINT awcms_commerce_refunds_return_fk
    FOREIGN KEY (tenant_id, return_id)
    REFERENCES awcms_commerce_returns (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_refunds_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_refunds_allocation_fk
    FOREIGN KEY (tenant_id, allocation_id)
    REFERENCES awcms_commerce_payment_allocations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_refunds_reversal_fk
    FOREIGN KEY (tenant_id, reversal_allocation_id)
    REFERENCES awcms_commerce_payment_allocations (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_refunds_store_credit_fk
    FOREIGN KEY (tenant_id, store_credit_account_id)
    REFERENCES awcms_commerce_stored_value_accounts (tenant_id, id),
  CONSTRAINT awcms_commerce_refunds_amount_check
    CHECK (amount > 0),
  CONSTRAINT awcms_commerce_refunds_destination_check
    CHECK (destination IN ('original_tender', 'store_credit')),
  CONSTRAINT awcms_commerce_refunds_status_check
    CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  CONSTRAINT awcms_commerce_refunds_settled_via_check
    CHECK (settled_via IS NULL OR settled_via IN ('ledger', 'provider', 'offline', 'store_credit')),
  CONSTRAINT awcms_commerce_refunds_attempts_check
    CHECK (attempts >= 0),
  -- A settled refund is booked in the payment ledger and says how.
  CONSTRAINT awcms_commerce_refunds_settled_check
    CHECK (
      (status = 'succeeded') = (reversal_allocation_id IS NOT NULL)
      AND (status = 'succeeded') = (settled_at IS NOT NULL)
      AND (status = 'succeeded') = (settled_via IS NOT NULL)
    ),
  CONSTRAINT awcms_commerce_refunds_store_credit_check
    CHECK (destination = 'store_credit' OR store_credit_account_id IS NULL),
  -- An offline settlement is attributable and explained.
  CONSTRAINT awcms_commerce_refunds_offline_check
    CHECK (
      settled_via IS DISTINCT FROM 'offline'
      OR (offline_by_tenant_user_id IS NOT NULL
          AND offline_reason IS NOT NULL
          AND length(btrim(offline_reason)) > 0)
    ),
  CONSTRAINT awcms_commerce_refunds_offline_reason_check
    CHECK (offline_reason IS NULL OR length(offline_reason) <= 500),
  CONSTRAINT awcms_commerce_refunds_source_key_length_check
    CHECK (length(source_key) BETWEEN 1 AND 300)
);

CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_return_idx
  ON awcms_commerce_refunds (tenant_id, return_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_order_idx
  ON awcms_commerce_refunds (tenant_id, order_id);
-- "How much of this payment is already promised to a refund" (the cap).
CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_allocation_idx
  ON awcms_commerce_refunds (tenant_id, allocation_id, status);
CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_reversal_idx
  ON awcms_commerce_refunds (tenant_id, reversal_allocation_id)
  WHERE reversal_allocation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_store_credit_idx
  ON awcms_commerce_refunds (tenant_id, store_credit_account_id)
  WHERE store_credit_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_refunds_tenant_created_idx
  ON awcms_commerce_refunds (tenant_id, created_at);

ALTER TABLE awcms_commerce_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_refunds FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_refunds_tenant_isolation
  ON awcms_commerce_refunds
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_refunds FROM awcms_app;

-- A refund leg may never promise more than its payment can still give back:
-- amount + the legs already promised (pending / processing) + the reversals
-- already booked <= the payment. Fires only for a leg that is (or becomes)
-- active; a settled leg is represented by its reversal row, which the
-- payment ledger caps on its own (below, sql/995).
CREATE OR REPLACE FUNCTION awcms_commerce_refunds_cap_guard()
RETURNS trigger AS $awcms_commerce_refunds_cap_guard$
DECLARE
  paid numeric(14, 2);
  alloc_order uuid;
  reversed numeric(14, 2);
  promised numeric(14, 2);
BEGIN
  SELECT amount, order_id INTO paid, alloc_order
  FROM awcms_commerce_payment_allocations
  WHERE tenant_id = NEW.tenant_id AND id = NEW.allocation_id
    AND kind = 'payment' AND status = 'succeeded';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'awcms_commerce_refunds: allocation % is not a succeeded payment', NEW.allocation_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF alloc_order IS DISTINCT FROM NEW.order_id THEN
    RAISE EXCEPTION 'awcms_commerce_refunds: allocation % does not belong to order %', NEW.allocation_id, NEW.order_id
      USING ERRCODE = 'check_violation';
  END IF;
  -- The order lock every ledger writer takes, so concurrent writers queue.
  PERFORM 1 FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id
  FOR NO KEY UPDATE;
  SELECT COALESCE(SUM(amount), 0) INTO reversed
  FROM awcms_commerce_payment_allocations
  WHERE tenant_id = NEW.tenant_id AND reverses_allocation_id = NEW.allocation_id
    AND status = 'succeeded';
  SELECT COALESCE(SUM(amount), 0) INTO promised
  FROM awcms_commerce_refunds
  WHERE tenant_id = NEW.tenant_id AND allocation_id = NEW.allocation_id
    AND id <> NEW.id AND status IN ('pending', 'processing');
  IF NEW.amount + reversed + promised > paid THEN
    RAISE EXCEPTION
      'awcms_commerce_refunds: refunding % along payment % would exceed what is refundable (% paid, % reversed, % already promised)',
      NEW.amount, NEW.allocation_id, paid, reversed, promised
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_refunds_cap_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_refunds_cap_guard_ins
  ON awcms_commerce_refunds;
CREATE TRIGGER awcms_commerce_refunds_cap_guard_ins
  BEFORE INSERT ON awcms_commerce_refunds
  FOR EACH ROW
  WHEN (NEW.status IN ('pending', 'processing'))
  EXECUTE FUNCTION awcms_commerce_refunds_cap_guard();

DROP TRIGGER IF EXISTS awcms_commerce_refunds_cap_guard_upd
  ON awcms_commerce_refunds;
CREATE TRIGGER awcms_commerce_refunds_cap_guard_upd
  BEFORE UPDATE OF status, amount ON awcms_commerce_refunds
  FOR EACH ROW
  WHEN (NEW.status IN ('pending', 'processing'))
  EXECUTE FUNCTION awcms_commerce_refunds_cap_guard();

-- A refund's identity and money are fixed at creation; only its settlement
-- state changes, along pending -> processing -> succeeded | failed and
-- failed -> processing (a retry). Nothing leaves `succeeded`.
CREATE OR REPLACE FUNCTION awcms_commerce_refunds_update_guard()
RETURNS trigger AS $awcms_commerce_refunds_update_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.return_id IS DISTINCT FROM OLD.return_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.allocation_id IS DISTINCT FROM OLD.allocation_id
    OR NEW.tender_type IS DISTINCT FROM OLD.tender_type
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.destination IS DISTINCT FROM OLD.destination
    OR NEW.source_key IS DISTINCT FROM OLD.source_key
    OR NEW.actor_tenant_user_id IS DISTINCT FROM OLD.actor_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_refunds row % : identity and amount are fixed once recorded',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'succeeded' THEN
    RAISE EXCEPTION
      'awcms_commerce_refunds row % is settled and never changes again',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('processing', 'succeeded', 'failed'))
    OR (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'failed'))
    OR (OLD.status = 'failed' AND NEW.status IN ('processing', 'succeeded'))
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_refunds row % : illegal status move % -> %',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_refunds_update_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_refunds_update_guard
  ON awcms_commerce_refunds;
CREATE TRIGGER awcms_commerce_refunds_update_guard
  BEFORE UPDATE ON awcms_commerce_refunds
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_refunds_update_guard();

COMMENT ON TABLE awcms_commerce_refunds IS
  'Issue #287 (ADR-0033) — one refund leg along one original payment allocation (original tender or store credit). Identity and amount are frozen; only the settlement state machine moves. Σ active legs + reversals <= the payment (trigger).';

-- ---------------------------------------------------------------------------
-- refund compensations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_refund_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  refund_id uuid NOT NULL,
  kind text NOT NULL,
  -- loyalty_reversal: the (negative) points taken back; affiliate_adjustment /
  -- store_credit_*: the money. The other column is NULL.
  points bigint,
  amount numeric(14, 2),
  -- The ledger entry / commission / account the effect landed on.
  ref_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_refund_compensations_refund_fk
    FOREIGN KEY (tenant_id, refund_id)
    REFERENCES awcms_commerce_refunds (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT awcms_commerce_refund_compensations_kind_check
    CHECK (kind IN ('loyalty_reversal', 'affiliate_adjustment', 'store_credit_issue', 'store_credit_load')),
  CONSTRAINT awcms_commerce_refund_compensations_value_check
    CHECK ((points IS NULL) <> (amount IS NULL))
);

-- One effect of one kind per refund, forever: the idempotency anchor.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_refund_compensations_refund_kind_key
  ON awcms_commerce_refund_compensations (tenant_id, refund_id, kind);
CREATE INDEX IF NOT EXISTS awcms_commerce_refund_compensations_tenant_created_idx
  ON awcms_commerce_refund_compensations (tenant_id, created_at);

ALTER TABLE awcms_commerce_refund_compensations ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_refund_compensations FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_refund_compensations_tenant_isolation
  ON awcms_commerce_refund_compensations
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE UPDATE, DELETE ON awcms_commerce_refund_compensations FROM awcms_app;

DROP TRIGGER IF EXISTS awcms_commerce_refund_compensations_append_only
  ON awcms_commerce_refund_compensations;
CREATE TRIGGER awcms_commerce_refund_compensations_append_only
  BEFORE UPDATE ON awcms_commerce_refund_compensations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_append_only_guard();

COMMENT ON TABLE awcms_commerce_refund_compensations IS
  'Issue #287 (ADR-0033) — append-only log of the downstream effects a settled refund had (loyalty reversal, affiliate adjustment, store credit). One row per (refund, kind): the idempotency anchor and what reconcile reads.';
