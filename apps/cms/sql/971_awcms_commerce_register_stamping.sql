-- Issue #284 (ADR-0028) — stamp a POS sale, and every payment-ledger leg
-- written while the sale's session is open, with the REGISTER SESSION it
-- belongs to. This is what lets a cash-up derive the expected amount per
-- tender from the existing ledger without ever rewriting a sale or a payment
-- (the sale and its legs are written exactly as before, plus one uuid).
--
-- ## Why a stamp on the leg, not a time window
--
-- "Legs created between `opened_at` and `closed_at`" looks equivalent and is
-- not: a leg's `created_at` is its TRANSACTION's start time, so a sale that
-- began just before the session opened (and read the open session after it
-- committed), or one that began just before a close, lands on the wrong side
-- of the window. A stamp written under the session-row lock is exact: the
-- session a leg is stamped with is the session that was open when it was
-- written, by construction (the writers lock the session `FOR SHARE`, the
-- close takes `FOR NO KEY UPDATE`, so a close and a stamped write serialise).
--
-- ## What is stamped
--
--   * `awcms_commerce_orders.register_session_id` — set ONCE, on the INSERT of
--     a POS sale; never changes (trigger below); only a `pos` order may carry
--     it (CHECK). A sale can only be attached to an `open` session (trigger).
--   * `awcms_commerce_payment_allocations.register_session_id` — set by the
--     ledger writers (`application/register-session-stamp.ts`) when the leg's
--     order carries a session AND that session is still `open`: a POS tender,
--     but also a balance paid later at the counter or a cash refund recorded
--     while the shift is open. A leg recorded after the session closed is
--     deliberately NOT stamped — a closed session is immutable, so late
--     activity can never change a closed cash-up (it is reported as such, not
--     silently folded in). The column is frozen by the ledger's append-only
--     trigger (replaced below).
--
-- Both columns are nullable: every pre-existing row, every storefront order
-- and every sale rung up while the register feature is off keeps NULL, which
-- is exactly today's behaviour (the expand step; there is nothing to
-- backfill — no historical session exists).

ALTER TABLE awcms_commerce_orders
  ADD COLUMN IF NOT EXISTS register_session_id uuid;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_register_session_fk
  FOREIGN KEY (tenant_id, register_session_id)
  REFERENCES awcms_commerce_register_sessions (tenant_id, id);

-- Only a counter sale belongs to a register.
ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_register_session_channel_check
  CHECK (register_session_id IS NULL OR channel = 'pos');

CREATE INDEX IF NOT EXISTS awcms_commerce_orders_register_session_idx
  ON awcms_commerce_orders (register_session_id)
  WHERE register_session_id IS NOT NULL;

ALTER TABLE awcms_commerce_payment_allocations
  ADD COLUMN IF NOT EXISTS register_session_id uuid;

ALTER TABLE awcms_commerce_payment_allocations
  ADD CONSTRAINT awcms_commerce_payment_allocations_register_session_fk
  FOREIGN KEY (tenant_id, register_session_id)
  REFERENCES awcms_commerce_register_sessions (tenant_id, id);

-- The cash-up's own sum: every stamped leg of a session.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_register_session_idx
  ON awcms_commerce_payment_allocations (tenant_id, register_session_id)
  WHERE register_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_register_session_fk_idx
  ON awcms_commerce_payment_allocations (register_session_id)
  WHERE register_session_id IS NOT NULL;

-- A sale may only be ATTACHED to an open session, and the attachment never
-- changes afterwards. The BEGIN/END below are PL/pgSQL block delimiters in a
-- dollar-quoted body, not transaction control (`sql/033`'s precedent).
CREATE OR REPLACE FUNCTION awcms_commerce_orders_register_session_guard()
RETURNS trigger AS $awcms_commerce_orders_register_session_guard$
DECLARE
  session_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.register_session_id IS DISTINCT FROM OLD.register_session_id THEN
      RAISE EXCEPTION
        'awcms_commerce_orders row %: register_session_id is set once at sale time and never changes',
        OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.register_session_id IS NOT NULL THEN
    SELECT status INTO session_status
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = NEW.tenant_id AND id = NEW.register_session_id;
    IF session_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION
        'a sale can only be attached to an open register session (session % is %)',
        NEW.register_session_id, COALESCE(session_status, 'missing')
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$awcms_commerce_orders_register_session_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_orders_register_session_guard
  ON awcms_commerce_orders;
CREATE TRIGGER awcms_commerce_orders_register_session_guard
  BEFORE INSERT OR UPDATE OF register_session_id ON awcms_commerce_orders
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_orders_register_session_guard();

-- A stamped leg must name the same session as its order, and that session
-- must be open at the moment the leg is written.
CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_register_guard()
RETURNS trigger AS $awcms_commerce_payment_allocations_register_guard$
DECLARE
  order_session uuid;
  session_status text;
BEGIN
  IF NEW.register_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT register_session_id INTO order_session
  FROM awcms_commerce_orders
  WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
  IF order_session IS DISTINCT FROM NEW.register_session_id THEN
    RAISE EXCEPTION
      'a payment leg can only be stamped with the register session of its own order'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO session_status
  FROM awcms_commerce_register_sessions
  WHERE tenant_id = NEW.tenant_id AND id = NEW.register_session_id;
  IF session_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION
      'a payment leg can only be stamped with an open register session (session % is %)',
      NEW.register_session_id, COALESCE(session_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_payment_allocations_register_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_payment_allocations_register_guard
  ON awcms_commerce_payment_allocations;
CREATE TRIGGER awcms_commerce_payment_allocations_register_guard
  BEFORE INSERT ON awcms_commerce_payment_allocations
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_payment_allocations_register_guard();

-- `sql/940`'s append-only guard, replaced so the new column is frozen too
-- (the body is otherwise identical).
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
    OR NEW.register_session_id IS DISTINCT FROM OLD.register_session_id
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

COMMENT ON COLUMN awcms_commerce_orders.register_session_id IS
  'Issue #284 (ADR-0028) — the register session a POS sale was rung up in; set once at sale time, only for channel = pos, only against an open session.';
COMMENT ON COLUMN awcms_commerce_payment_allocations.register_session_id IS
  'Issue #284 (ADR-0028) — the open register session the leg was recorded in (same session as its order); frozen. NULL for every leg recorded outside an open session.';
