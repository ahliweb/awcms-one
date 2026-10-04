-- Issue #284 review fix (ADR-0028 D2) — a REVERSAL may be stamped with a
-- register session other than its order's.
--
-- `sql/971`'s leg guard demanded that a stamped leg name the SAME session as
-- its order. That is right for a payment (the money entered the drawer of the
-- shift that rang the sale), but a cash REFUND for a sale from an earlier,
-- already-closed shift leaves the drawer that is open NOW: the operator passes
-- that open session (`registerSessionId` on the reversal API) so today's
-- expected cash is not overstated. The order's own session is closed, so
-- without this relaxation such a refund could only be recorded unstamped.
--
-- What stays exactly as strict as before: the session must be `open` at the
-- moment of the insert, and a PAYMENT leg must still name its order's own
-- session. Who may use the session (its current cashier) is checked in the
-- application, under the session-row lock, before the insert.
--
-- `CREATE OR REPLACE` only: a new migration rather than an edit of `sql/971`,
-- whose checksum is immutable once any database has applied it.

CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_register_guard()
RETURNS trigger AS $awcms_commerce_payment_allocations_register_guard$
DECLARE
  order_session uuid;
  session_status text;
BEGIN
  IF NEW.register_session_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.kind <> 'reversal' THEN
    SELECT register_session_id INTO order_session
    FROM awcms_commerce_orders
    WHERE tenant_id = NEW.tenant_id AND id = NEW.order_id;
    IF order_session IS DISTINCT FROM NEW.register_session_id THEN
      RAISE EXCEPTION
        'a payment leg can only be stamped with the register session of its own order'
        USING ERRCODE = 'restrict_violation';
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
$awcms_commerce_payment_allocations_register_guard$ LANGUAGE plpgsql;
