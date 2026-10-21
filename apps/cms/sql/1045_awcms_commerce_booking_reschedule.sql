-- Issue #382 (ADR-0045 D7, D15; contracts sections 3.7 and 3.8; threat controls
-- C-37, C-38, C-39, C-41) - the additive schema booking RESCHEDULE and NO-SHOW
-- need on top of the adapter tables of sql/1035-1038 and sql/1043. One
-- migration, four small, independent parts.
--
-- ## 1. The reschedule record (C-38, C-39)
--
-- A reschedule moves the order's reference from the old Booking reservation to
-- its replacement: the old reservation link goes `superseded`, a new link for the
-- replacement points at the SAME order and order line, and Booking's own
-- `externalRef` is carried to the replacement by the port. Both sides change in
-- one transaction, so the order is never left with ONE reference (the
-- reconciliation lists the drift if a path outside the adapter ever causes it).
-- No order, order line or payment allocation is edited: money moves only as a
-- NEW record.
--
-- `awcms_commerce_booking_reschedules` is that evidence, one append-only row per
-- reschedule: which links, the night counts, and how the price difference was
-- carried (ADR-0045 D7 as amended by the coordinator, issue #382):
--
--   - `none`   - the stay kept its length; only the reference moved.
--   - `charge` - more nights: a SUPPLEMENTARY ORDER (an ordinary order created by
--     the ordinary order path, priced by the server's cart quote, paid by the
--     ordinary payment paths). `supplement_order_id` names it.
--   - `refund` - fewer nights: the value of the removed nights, judged by the
--     cancellation policy of the ORIGINAL booking from the ORIGINAL start (a
--     reschedule can never buy a better window), is refunded as pending legs of a
--     return of kind `cancellation` (sql/1043). `refund_amount` can be zero (the
--     policy refunds nothing); `return_id` names the return when it is not.
--
-- The amount is never an input: every figure is computed on the server in integer
-- cents. `priced_amount` is the price of the difference (the supplement's total,
-- or the value of the removed nights), `refund_amount` is what the policy gives
-- back, and the CHECKs keep the two apart (a charge refunds nothing; a refund is
-- never above its price).
--
-- Mutability: none. A trigger refuses every UPDATE and `awcms_app` holds neither
-- UPDATE nor DELETE. `UNIQUE (tenant_id, from_link_id)` and `UNIQUE (tenant_id,
-- to_link_id)` make a link superseded once and created once;
-- `UNIQUE (tenant_id, client_key)` is the idempotency key (G5), namespaced by the
-- acting party like the cancel's.
--
-- ## 2. A no-show retains, and refunds nothing (C-41)
--
-- A no-show decision (`trigger_kind = 'no_show'`, which sql/1038 already admits)
-- records what the policy RETAINS in `retained_amount`. Its computed and final
-- refund are zero, and a trigger refuses to give it a return: a no-show can
-- never create a refund leg, by construction and not only by the application.
-- Cancel decisions keep `retained_amount` NULL.
--
-- ## 3. The permission
--
-- `commerce.booking_reservation_links.update` (reschedule), seeded here with the
-- route that enforces it (R2). `cancel` and `approve` were seeded by sql/1044.
--
-- ## 4. Worker grants
--
-- The retention engine (`awcms_worker`) SELECTs and DELETEs the reschedule
-- record by `id` like every adapter table (sql/1040); the application role can
-- do neither.

-- ---------------------------------------------------------------------------
-- 1. reschedule records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_booking_reschedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  from_link_id uuid NOT NULL,
  to_link_id uuid NOT NULL,
  from_nights integer NOT NULL,
  to_nights integer NOT NULL,
  difference_direction text NOT NULL,
  priced_amount numeric(14, 2) NOT NULL DEFAULT 0,
  refund_amount numeric(14, 2) NOT NULL DEFAULT 0,
  supplement_order_id uuid,
  return_id uuid,
  policy_id uuid,
  policy_source text,
  hours_before_start integer,
  refundable_percent numeric(5, 2),
  actor_tenant_user_id uuid NOT NULL,
  client_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_booking_reschedules_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_from_link_fk
    FOREIGN KEY (tenant_id, from_link_id)
    REFERENCES awcms_commerce_booking_reservation_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_to_link_fk
    FOREIGN KEY (tenant_id, to_link_id)
    REFERENCES awcms_commerce_booking_reservation_links (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_supplement_order_fk
    FOREIGN KEY (tenant_id, supplement_order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_return_fk
    FOREIGN KEY (tenant_id, return_id)
    REFERENCES awcms_commerce_returns (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_policy_fk
    FOREIGN KEY (tenant_id, policy_id)
    REFERENCES awcms_commerce_cancellation_policies (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_actor_fk
    FOREIGN KEY (tenant_id, actor_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id),
  CONSTRAINT awcms_commerce_booking_reschedules_from_link_key
    UNIQUE (tenant_id, from_link_id),
  CONSTRAINT awcms_commerce_booking_reschedules_to_link_key
    UNIQUE (tenant_id, to_link_id),
  CONSTRAINT awcms_commerce_booking_reschedules_client_key_key
    UNIQUE (tenant_id, client_key),
  CONSTRAINT awcms_commerce_booking_reschedules_not_self_check
    CHECK (from_link_id <> to_link_id),
  CONSTRAINT awcms_commerce_booking_reschedules_nights_check
    CHECK (from_nights >= 1 AND to_nights >= 1),
  CONSTRAINT awcms_commerce_booking_reschedules_direction_check
    CHECK (difference_direction IN ('none', 'charge', 'refund')),
  -- The direction is the sign of the night difference, nothing else.
  CONSTRAINT awcms_commerce_booking_reschedules_direction_shape_check
    CHECK (
      (difference_direction = 'none' AND to_nights = from_nights)
      OR (difference_direction = 'charge' AND to_nights > from_nights)
      OR (difference_direction = 'refund' AND to_nights < from_nights)
    ),
  CONSTRAINT awcms_commerce_booking_reschedules_amounts_check
    CHECK (
      priced_amount >= 0
      AND refund_amount >= 0
      -- A refund is never above the price of what was removed (C-39), and only
      -- a refund refunds anything.
      AND refund_amount <= priced_amount
      AND (difference_direction = 'refund' OR refund_amount = 0)
      -- A zero-difference reschedule prices nothing.
      AND (difference_direction <> 'none' OR priced_amount = 0)
      -- A charge has a price (the supplementary order cannot be free).
      AND (difference_direction <> 'charge' OR priced_amount > 0)
    ),
  -- A supplementary order exactly when the stay got longer; a return exactly
  -- when a positive refund was planned.
  CONSTRAINT awcms_commerce_booking_reschedules_supplement_check
    CHECK ((difference_direction = 'charge') = (supplement_order_id IS NOT NULL)),
  CONSTRAINT awcms_commerce_booking_reschedules_return_shape_check
    CHECK ((return_id IS NOT NULL) = (refund_amount > 0)),
  -- The policy evidence is recorded exactly for a refund (the only direction a
  -- policy decides), the same shape as the refund decision's.
  CONSTRAINT awcms_commerce_booking_reschedules_policy_shape_check
    CHECK (
      (difference_direction = 'refund') = (policy_source IS NOT NULL)
      AND (difference_direction = 'refund') = (hours_before_start IS NOT NULL)
      AND (difference_direction = 'refund') = (refundable_percent IS NOT NULL)
      AND (policy_source IS NULL OR policy_source IN ('product', 'tenant_default', 'none'))
      AND (policy_source IS NULL OR (policy_source = 'none') = (policy_id IS NULL))
      AND (policy_source IS NOT NULL OR policy_id IS NULL)
      AND (refundable_percent IS NULL OR refundable_percent BETWEEN 0 AND 100)
    ),
  CONSTRAINT awcms_commerce_booking_reschedules_client_key_check
    CHECK (
      char_length(client_key) BETWEEN 1 AND 300
      AND char_length(request_hash) BETWEEN 1 AND 128
    )
);

-- The FK columns' own indexes (db:fk-index). `from_link_id`, `to_link_id` and
-- `client_key` lead their unique keys above.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_order_idx
  ON awcms_commerce_booking_reschedules (tenant_id, order_id, created_at);
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_supplement_order_idx
  ON awcms_commerce_booking_reschedules (tenant_id, supplement_order_id)
  WHERE supplement_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_return_idx
  ON awcms_commerce_booking_reschedules (tenant_id, return_id)
  WHERE return_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_policy_idx
  ON awcms_commerce_booking_reschedules (tenant_id, policy_id)
  WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_actor_idx
  ON awcms_commerce_booking_reschedules (tenant_id, actor_tenant_user_id);
-- The retention engine's (tenant, cursor) composite.
CREATE INDEX IF NOT EXISTS awcms_commerce_booking_reschedules_tenant_created_idx
  ON awcms_commerce_booking_reschedules (tenant_id, created_at);

ALTER TABLE awcms_commerce_booking_reschedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_booking_reschedules FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_booking_reschedules_tenant_isolation
  ON awcms_commerce_booking_reschedules
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Append-only for the application role (neither UPDATE nor DELETE); the trigger
-- is the second line and also stops a role that holds UPDATE. The BEGIN/END
-- below are PL/pgSQL block delimiters in a dollar-quoted body, not transaction
-- control (sql/033's precedent).
REVOKE UPDATE, DELETE ON awcms_commerce_booking_reschedules FROM awcms_app;

CREATE OR REPLACE FUNCTION awcms_commerce_booking_reschedules_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_booking_reschedules_guard$
BEGIN
  RAISE EXCEPTION
    'awcms_commerce_booking_reschedules row % is append-only: a reschedule is never edited',
    OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_booking_reschedules_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_booking_reschedules_guard
  ON awcms_commerce_booking_reschedules;
CREATE TRIGGER awcms_commerce_booking_reschedules_guard
  BEFORE UPDATE ON awcms_commerce_booking_reschedules
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_booking_reschedules_guard();

COMMENT ON TABLE awcms_commerce_booking_reschedules IS
  'Issue #382 (ADR-0045 D7, controls C-37 to C-39) - one append-only row per reschedule: the superseded and the new reservation link of the same order, the night counts and how the price difference was carried (none, a supplementary order, or a policy-limited refund return). Moves no money itself; every amount is computed on the server in integer cents.';

-- ---------------------------------------------------------------------------
-- 2. no-show: retention recorded, no refund possible
-- ---------------------------------------------------------------------------

ALTER TABLE awcms_commerce_booking_refund_decisions
  ADD COLUMN IF NOT EXISTS retained_amount numeric(14, 2);

-- A no-show decision records what the policy retains and refunds nothing; every
-- other decision has no retained amount. The CHECK is the database's own answer
-- to control C-41 (no refund created by a no-show).
ALTER TABLE awcms_commerce_booking_refund_decisions
  ADD CONSTRAINT awcms_commerce_booking_refund_decisions_no_show_check
  CHECK (
    (trigger_kind = 'no_show') = (retained_amount IS NOT NULL)
    AND (
      trigger_kind <> 'no_show'
      OR (
        computed_refund = 0
        AND final_refund = 0
        AND retained_amount BETWEEN 0 AND amount_paid
      )
    )
  );

COMMENT ON COLUMN awcms_commerce_booking_refund_decisions.retained_amount IS
  'Issue #382 (ADR-0045 D15, control C-41) - for a no-show decision, the amount the policy version retains (never above the amount paid); NULL for a cancellation. A no-show decision has no refund and never receives a return.';

-- The sql/1038 guard plus one rule: a no-show decision is never given a return.
-- Everything else in it is unchanged (the jsonb comparison freezes the new
-- column too).
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

  IF NEW.trigger_kind = 'no_show' AND NEW.return_id IS NOT NULL
  THEN
    RAISE EXCEPTION
      'awcms_commerce_booking_refund_decisions row %: a no-show retains and creates no refund leg',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_booking_refund_decisions_guard$;

-- ---------------------------------------------------------------------------
-- 3. the permission (R2: seeded with the route that enforces it)
-- ---------------------------------------------------------------------------

INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'booking_reservation_links', 'update', 'Reschedule a Booking reservation: move it to new dates and carry the price difference through the order path (Issue #382)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. worker grants
-- ---------------------------------------------------------------------------

GRANT SELECT, DELETE ON awcms_commerce_booking_reschedules TO awcms_worker;
