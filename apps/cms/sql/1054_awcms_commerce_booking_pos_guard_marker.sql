-- Issue #448 (ADR-0045 D19; follow-up to the security audit of PR #443) - narrow
-- the booking-balance exception of the register-session ledger guard to the one
-- route that is meant to use it.
--
-- sql/1046 admitted ANY `source = 'pos'` payment leg recorded by a register
-- session's own open cashier on an order that has an active booking reservation
-- link. The exception exists for exactly one write path - `collectBookingBalance`
-- (`booking-pos.ts`) - and that path already stamps every leg with a marker: its
-- ledger `source_key` is `posbal:<reservation link id>:<digest>:<leg index>`. The
-- guard now requires that marker too, and binds it to the SAME link that makes
-- the order a live booking order:
--
--   a payment leg whose source is `pos`, on an order with NO register session of
--   its own, whose `source_key` starts with `posbal:<id>:` where `<id>` is an
--   ACTIVE booking reservation link OF THAT ORDER, recorded by a TENANT USER who
--   is the CURRENT CASHIER of the named session, which must be `open`.
--
-- No column, table or data change: the marker already exists on every leg the
-- route writes (`source_key` is NOT NULL, tenant-unique and immutable, sql/940),
-- so nothing the application does today is refused. What is refused now: a
-- different `pos` code path, a script or a future route that happens to run on a
-- booking order inside an open session and stamps money into the cashier's shift
-- without going through the audited balance route (reservation lookup, separate
-- `booking_balance_payments.create` key, settlement summary, audit event).
--
-- The marker is a convention, not a secret: a caller that can run an INSERT as
-- the application role and knows the convention can still forge it. It narrows
-- the exception from "any pos leg on a booking order" to "a leg that names this
-- order's own live link", which is what the review asked for; the cashier
-- binding, the open-session requirement and every other rule are unchanged.
--
-- `CREATE OR REPLACE` resets a function's settings, so `search_path` is pinned in
-- the definition (the gate `db:function-search-path:check`, sql/1032). The
-- comparison uses `LIKE` on the link id's text, never a uuid cast of a slice of
-- the key, so a malformed key is a refusal and not a cast error.

CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_register_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_payment_allocations_register_guard$
DECLARE
  order_session uuid;
  session_status text;
  booking_balance boolean;
BEGIN
  IF NEW.register_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.kind <> 'reversal' THEN
    SELECT register_session_id INTO order_session
    FROM awcms_commerce_orders
    WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    IF order_session IS DISTINCT FROM NEW.register_session_id THEN
      -- The one exception (Issue #383, narrowed by Issue #448): the balance of a
      -- booking order taken at the till. The order has no session of its own, the
      -- leg carries the balance route's marker naming a live reservation link OF
      -- THIS ORDER, and the leg is recorded by the named session's own open
      -- cashier.
      booking_balance := NEW.source = 'pos'
        AND order_session IS NULL
        AND NEW.actor_kind = 'tenant_user'
        AND EXISTS (
          SELECT 1
          FROM awcms_commerce_booking_reservation_links l
          WHERE l.tenant_id = NEW.tenant_id
            AND l.order_id = NEW.order_id
            AND l.status = 'active'
            AND NEW.source_key LIKE 'posbal:' || l.id::text || ':%'
        )
        AND EXISTS (
          SELECT 1
          FROM awcms_commerce_register_sessions s
          WHERE s.tenant_id = NEW.tenant_id
            AND s.id = NEW.register_session_id
            AND s.status = 'open'
            AND s.current_cashier_tenant_user_id = NEW.actor_tenant_user_id
        );
      IF NOT COALESCE(booking_balance, false) THEN
        RAISE EXCEPTION
          'a payment leg can only be stamped with the register session of its own order'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
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
$awcms_commerce_payment_allocations_register_guard$;
