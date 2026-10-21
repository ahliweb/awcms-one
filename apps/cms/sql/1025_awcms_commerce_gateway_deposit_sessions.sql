-- Issue #379 (ADR-0041, threat-model control C-07) - gateway deposit sessions.
--
-- A hosted-checkout session used to carry no amount at all: the figure the
-- provider should report was implicitly "the order total, now", and the amount
-- guard (`sql/934`, `domain/payment-amount-guard.ts`) compared the provider's
-- `gross_amount` to that. A deposit (or the balance after one) is a gateway leg
-- that is LESS than the total, so the expected figure has to be decided by the
-- server, once, and frozen on the session it belongs to.
--
-- ## What this migration adds to `awcms_commerce_payment_gateway_sessions`
--
--   * `purpose` - `full` | `deposit` | `balance`. `full` (the default, and what
--     every row created before this migration is) is the whole-total session
--     of ADR-0025; `deposit` collects the down payment of a down-payment order;
--     `balance` collects what remains after it.
--   * `expected_amount numeric(14,2)` - the figure the session was created to
--     collect, in the same unit the provider reports `gross_amount` in. It is
--     computed by the server inside the order-row lock (`FOR NO KEY UPDATE`,
--     ADR-0025 D4), from the ledger, never from the request body and never from
--     a provider response; it is exactly the `gross_amount` sent to the
--     provider, and the webhook/reconcile guard compares the provider's figure
--     to it in integer cents. `NULL` only for a session created before this
--     migration, which reads as `purpose = 'full'` with the order total (what it
--     was); the guard then keeps comparing against the order total, unchanged.
--
-- ## Why a trigger freezes them
--
-- The point of the column is that nobody can rewrite what a session was meant
-- to collect after the fact - not a bug, not an operator with a query console.
-- `awcms_commerce_payment_gateway_sessions_guard` therefore refuses any UPDATE
-- that changes `purpose`, `expected_amount` or the session's identity (tenant,
-- order, provider, provider reference); every other column may still move
-- (`status`, `last_checked_at`, `raw_status`, `updated_at`), which is all the
-- intake route, the reconcile job and the admin "check status" action ever
-- write. The same style as the allocation ledger's guard
-- (`sql/940`, ADR-0025 D2).
--
-- A non-`full` session must carry an expected amount (a CHECK), and an expected
-- amount is always positive. Nothing else changes: no new table, no new grant
-- (the existing `awcms_app` privileges on the table cover the new columns), no
-- change for a tenant that never creates a deposit session.

ALTER TABLE awcms_commerce_payment_gateway_sessions
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'full';

ALTER TABLE awcms_commerce_payment_gateway_sessions
  ADD COLUMN IF NOT EXISTS expected_amount numeric(14, 2);

ALTER TABLE awcms_commerce_payment_gateway_sessions
  DROP CONSTRAINT IF EXISTS awcms_commerce_payment_gateway_sessions_purpose_check;

ALTER TABLE awcms_commerce_payment_gateway_sessions
  ADD CONSTRAINT awcms_commerce_payment_gateway_sessions_purpose_check
    CHECK (purpose IN ('full', 'deposit', 'balance'));

ALTER TABLE awcms_commerce_payment_gateway_sessions
  DROP CONSTRAINT IF EXISTS awcms_commerce_payment_gateway_sessions_expected_amount_check;

ALTER TABLE awcms_commerce_payment_gateway_sessions
  ADD CONSTRAINT awcms_commerce_payment_gateway_sessions_expected_amount_check
    CHECK (
      (expected_amount IS NULL OR expected_amount > 0)
      AND (purpose = 'full' OR expected_amount IS NOT NULL)
    );

COMMENT ON COLUMN awcms_commerce_payment_gateway_sessions.purpose IS
  'full | deposit | balance (Issue #379, ADR-0041 D1). Frozen at creation by awcms_commerce_payment_gateway_sessions_guard. Rows created before sql/1025 are full.';

COMMENT ON COLUMN awcms_commerce_payment_gateway_sessions.expected_amount IS
  'Server-computed amount this session collects (Issue #379, ADR-0041 D1): exactly the gross_amount sent to the provider, compared to the provider''s reported figure in integer cents by the webhook and reconcile guard. Frozen at creation. NULL only on a session created before sql/1025 (reads as the order total).';

CREATE OR REPLACE FUNCTION awcms_commerce_payment_gateway_sessions_guard()
RETURNS trigger AS $awcms_commerce_payment_gateway_sessions_guard$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.expected_amount IS DISTINCT FROM OLD.expected_amount
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.order_id IS DISTINCT FROM OLD.order_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
  THEN
    RAISE EXCEPTION
      'awcms_commerce_payment_gateway_sessions row % is frozen: purpose, expected_amount and the session identity cannot change after creation',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$awcms_commerce_payment_gateway_sessions_guard$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_payment_gateway_sessions_frozen
  ON awcms_commerce_payment_gateway_sessions;
CREATE TRIGGER awcms_commerce_payment_gateway_sessions_frozen
  BEFORE UPDATE ON awcms_commerce_payment_gateway_sessions
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_payment_gateway_sessions_guard();
