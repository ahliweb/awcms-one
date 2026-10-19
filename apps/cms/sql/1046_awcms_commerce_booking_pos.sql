-- Issue #383 (ADR-0045 D19; booking UX flows section 5, surface D; threat
-- controls C-34, C-35, C-36) - the schema the POS side of the booking adapter
-- needs: three permissions, one tenant setting and one relaxed ledger guard. No
-- table: the POS stores NO reservation state and NO balance (C-36); a check-in
-- and a check-out are Booking's transitions (`BookingPort.checkIn` / `checkOut`),
-- a balance is a row of the payment-allocation ledger, and the evidence of who
-- did what is the audit log.
--
-- ## 1. The permissions (R2: seeded with the routes that enforce them)
--
-- Check-in, check-out and taking the balance are SEPARATE keys (C-35): one person
-- cannot start a stay, end it and take the money with a single grant, and a
-- tenant can put each under its own separation-of-duties rule. None is the
-- generic `commerce.pos.create` or `commerce.payments.create`: those would hand
-- every till operator the ability to take money into, or check a guest out of,
-- ANY reservation. Each is also bound, by the route, to an OPEN register session
-- the actor holds (ADR-0028). The lookup that precedes them needs no key of its
-- own: it is the existing `commerce.booking_reservation_links.read`.
--
--   * `commerce.booking_check_ins.create`        - check a confirmed guest in.
--   * `commerce.booking_check_outs.create`       - check a checked-in guest out.
--   * `commerce.booking_balance_payments.create` - take the outstanding balance
--     of a reservation's order through the ordinary payment ledger, into the
--     actor's own open register session.
--
-- Existing `AccessAction` verbs only (`create`); a global catalog seeded
-- idempotently, so existing tenants do not retroactively gain the keys.
--
-- ## 2. The tenant setting `checkin_requires_settlement` (D19, residual R3)
--
-- Whether a guest may be checked in while a balance is still owed is a tenant
-- policy the owner has not recorded; both variants are built and the value is a
-- real column of the one-row-per-tenant settings table (the
-- `booking_service_tenant_user_id` precedent, sql/1040):
--
--   * TRUE  (the DEFAULT) - BLOCK: the check-in route answers
--     `409 BALANCE_NOT_SETTLED` while anything is owed.
--   * FALSE               - ALLOW: the check-in proceeds and the balance stays
--     visible and collectable; the audit row says it was waived.
--
-- The default is TRUE (fail closed: money first) and is a recommendation the
-- OWNER MUST CONFIRM before the issue merges (residual R3). It supersedes the
-- earlier ADR-0045 D19 default of `false`. A tenant with no settings row reads
-- the same default in the application (`fetchCheckInRequiresSettlement`).
--
-- ## 3. The ledger guard: a balance taken at the till belongs to the till's session
--
-- sql/971 / sql/974 demand that a PAYMENT leg stamped with a register session
-- names the SAME session as its order. That is right for a POS sale (the order
-- is rung in that session). A booking order is a storefront order: it carries no
-- register session of its own (`register_session_id` is for `pos` orders only),
-- so the balance a cashier takes at the front desk could never be stamped, and
-- would fall into no cash-up at all - skimming it would never show as a variance
-- (C-35). The guard is relaxed by exactly one case:
--
--   a payment leg whose source is `pos`, on an order with NO register session of
--   its own and an ACTIVE booking reservation link, may name any OPEN session.
--
-- Everything else stays as strict as before: the session must be `open` at the
-- insert, every other payment still names its order's own session, a reversal
-- keeps the sql/974 rule. Who may use the session (its current cashier) is
-- checked by the application under the session-row lock. `CREATE OR REPLACE`
-- resets a function's settings, so `search_path` is pinned in the definition
-- (the gate `db:function-search-path:check`, sql/1032).

INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'booking_check_ins', 'create', 'Check a confirmed Booking reservation in at the till, inside the actor''s own open register session (Issue #383)'),
  ('commerce', 'booking_check_outs', 'create', 'Check a checked-in Booking reservation out at the till, inside the actor''s own open register session (Issue #383)'),
  ('commerce', 'booking_balance_payments', 'create', 'Take the outstanding balance of a Booking reservation''s order through the payment ledger, into the actor''s own open register session (Issue #383)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;

ALTER TABLE awcms_commerce_store_settings
  ADD COLUMN IF NOT EXISTS checkin_requires_settlement boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN awcms_commerce_store_settings.checkin_requires_settlement IS
  'Issue #383 (ADR-0045 D19) - TRUE (default): a Booking reservation cannot be checked in at the till while a balance is owed (409 BALANCE_NOT_SETTLED). FALSE: check-in proceeds with the balance visible. The default is a recommendation the owner confirms (residual R3).';

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
      -- The one exception (Issue #383): the balance of a booking order taken at
      -- the till. The order has no session of its own and a live reservation link.
      booking_balance := NEW.source = 'pos'
        AND order_session IS NULL
        AND EXISTS (
          SELECT 1
          FROM awcms_commerce_booking_reservation_links l
          WHERE l.tenant_id = NEW.tenant_id
            AND l.order_id = NEW.order_id
            AND l.status = 'active'
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
