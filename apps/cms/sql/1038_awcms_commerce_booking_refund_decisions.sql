-- Issue #378 (ADR-0045 D4, D8; owner answer Q10) - the refund decision record:
-- one append-only row per cancellation or no-show of a reservation link, saying
-- which policy version applied, the policy-computed refund, any override and the
-- return under which the refund legs run. Data model:
-- docs/booking-commerce-adapter-data-model.md section 4.5.
--
-- ## The table decides nothing about money and moves none
--
-- It is the EVIDENCE for "why was this amount refunded" (controls C-10, C-11).
-- Money moves only through the existing return and refund legs (ADR-0033) and the
-- allocation ledger (ADR-0025); the application caps each leg per original
-- payment, so a row that is valid here can still be refused later. The amount is
-- never taken from a request: it is computed on the server from the policy rows
-- and the ledger.
--
-- ## Once per reservation link, mechanically
--
-- `UNIQUE (tenant_id, reservation_link_id)`: a reservation is cancelled or marked
-- no-show once, so a replay finds the same decision and never refunds twice;
-- `UNIQUE (tenant_id, source_key)` seeds the refund legs' own source keys.
--
-- ## Override (Q10, ADR-0045 D8)
--
-- `final_refund` may differ from `computed_refund` only with an override actor,
-- a mandatory reason of 10 to 500 characters and the time the step-up proof was
-- accepted - all four are set or all four are not (CHECK) - and NEVER above the
-- amount paid (CHECK), regardless of the actor. The override travels inline with
-- the cancel (D8): there is no second write to the row.
--
-- ## Append-only
--
-- A trigger freezes every column except `return_id`, which is set once (NULL to a
-- value) when the refund legs are planned under a return. `awcms_app` keeps
-- UPDATE on that one column only and has no DELETE; `awcms_worker` gets SELECT +
-- DELETE for the retention engine (sql/1040), whose cursor is `created_at`.
--
-- Staff columns are plain tenant-user references (composite FKs) because the
-- fact IS the actor; the customer is never stored (finding X7): a customer
-- cancel is `actor_kind = 'customer'` with no id, and the order's customer is
-- derived through the reservation link.

CREATE TABLE IF NOT EXISTS awcms_commerce_booking_refund_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  reservation_link_id uuid NOT NULL,
  trigger_kind text NOT NULL,
  actor_kind text NOT NULL,
  actor_tenant_user_id uuid,
  policy_id uuid,
  policy_source text NOT NULL,
  hours_before_start integer NOT NULL,
  refundable_percent numeric(5, 2) NOT NULL,
  amount_paid numeric(14, 2) NOT NULL,
  computed_refund numeric(14, 2) NOT NULL,
  final_refund numeric(14, 2) NOT NULL,
  override_reason text,
  override_actor_tenant_user_id uuid,
  override_stepup_at timestamptz,
  return_id uuid,
  source_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_booking_refund_decisions_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_link_fk
    FOREIGN KEY (tenant_id, reservation_link_id)
    REFERENCES awcms_commerce_booking_reservation_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_actor_fk
    FOREIGN KEY (tenant_id, actor_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_policy_fk
    FOREIGN KEY (tenant_id, policy_id)
    REFERENCES awcms_commerce_cancellation_policies (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_override_actor_fk
    FOREIGN KEY (tenant_id, override_actor_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_return_fk
    FOREIGN KEY (tenant_id, return_id)
    REFERENCES awcms_commerce_returns (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_link_key
    UNIQUE (tenant_id, reservation_link_id),
  CONSTRAINT awcms_commerce_booking_refund_decisions_source_key_key
    UNIQUE (tenant_id, source_key),
  CONSTRAINT awcms_commerce_booking_refund_decisions_trigger_kind_check
    CHECK (trigger_kind IN ('customer_cancel', 'staff_cancel', 'no_show')),
  CONSTRAINT awcms_commerce_booking_refund_decisions_actor_kind_check
    CHECK (actor_kind IN ('customer', 'staff', 'system')),
  CONSTRAINT awcms_commerce_booking_refund_decisions_actor_shape_check
    CHECK ((actor_kind = 'staff') = (actor_tenant_user_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_booking_refund_decisions_policy_source_check
    CHECK (policy_source IN ('product', 'tenant_default', 'none')),
  CONSTRAINT awcms_commerce_booking_refund_decisions_policy_shape_check
    CHECK ((policy_source = 'none') = (policy_id IS NULL)),
  CONSTRAINT awcms_commerce_booking_refund_decisions_percent_check
    CHECK (refundable_percent BETWEEN 0 AND 100),
  CONSTRAINT awcms_commerce_booking_refund_decisions_none_zero_check
    CHECK (policy_source <> 'none' OR refundable_percent = 0),
  CONSTRAINT awcms_commerce_booking_refund_decisions_paid_check
    CHECK (amount_paid >= 0),
  CONSTRAINT awcms_commerce_booking_refund_decisions_computed_check
    CHECK (computed_refund BETWEEN 0 AND amount_paid),
  -- The last line of defence for control C-10: an override can never exceed
  -- what was paid.
  CONSTRAINT awcms_commerce_booking_refund_decisions_final_check
    CHECK (final_refund BETWEEN 0 AND amount_paid),
  CONSTRAINT awcms_commerce_booking_refund_decisions_override_reason_check
    CHECK (override_reason IS NULL
      OR char_length(override_reason) BETWEEN 10 AND 500),
  CONSTRAINT awcms_commerce_booking_refund_decisions_override_shape_check
    CHECK (
      (final_refund <> computed_refund) = (override_reason IS NOT NULL)
      AND (override_reason IS NOT NULL) = (override_actor_tenant_user_id IS NOT NULL)
      AND (override_reason IS NOT NULL) = (override_stepup_at IS NOT NULL)
    ),
  CONSTRAINT awcms_commerce_booking_refund_decisions_source_key_check
    CHECK (char_length(source_key) BETWEEN 1 AND 300)
);

-- The FK columns' own indexes (db:fk-index). `reservation_link_id` and
-- `source_key` lead their unique keys above.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_order_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, order_id);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_actor_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, actor_tenant_user_id)
  WHERE actor_tenant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_policy_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, policy_id)
  WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_override_actor_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, override_actor_tenant_user_id)
  WHERE override_actor_tenant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_return_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, return_id)
  WHERE return_id IS NOT NULL;
-- The retention engine's (tenant, cursor) composite.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_tenant_created_idx
  ON awcms_commerce_booking_refund_decisions (tenant_id, created_at);

ALTER TABLE awcms_commerce_booking_refund_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_booking_refund_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_booking_refund_decisions_tenant_isolation
  ON awcms_commerce_booking_refund_decisions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only for the application role: it may set the one column the legs
-- planner writes, and nothing else, and may never delete.
REVOKE UPDATE, DELETE ON awcms_commerce_booking_refund_decisions FROM awcms_app;
GRANT UPDATE (return_id) ON awcms_commerce_booking_refund_decisions TO awcms_app;

-- The trigger is the second line (it also stops a role that holds UPDATE): every
-- column but `return_id` is frozen, and `return_id` is set once. Comparing the
-- jsonb forms keeps the guard correct if a later migration adds a column.
CREATE OR REPLACE FUNCTION awcms_commerce_booking_refund_decisions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_booking_refund_decisions_guard$
BEGIN
  IF (to_jsonb(NEW) - 'return_id') IS DISTINCT FROM (to_jsonb(OLD) - 'return_id')
  THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_refund_decisions row % is append-only: only return_id is set, once',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.return_id IS NOT NULL AND NEW.return_id IS DISTINCT FROM OLD.return_id
  THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_refund_decisions row %: return_id is set once',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_booking_refund_decisions_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_booking_refund_decisions_guard
  ON awcms_commerce_booking_refund_decisions;
CREATE TRIGGER awcms_commerce_booking_refund_decisions_guard
  BEFORE UPDATE ON awcms_commerce_booking_refund_decisions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_booking_refund_decisions_guard();

COMMENT ON TABLE awcms_commerce_booking_refund_decisions IS
  'Issue #378 (ADR-0045 D4, D8, Q10) - one append-only decision per cancelled or no-show reservation link: the policy version applied, computed and final refund (never above the amount paid), the override evidence and the return carrying the refund legs. Moves no money.';
