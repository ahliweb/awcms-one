-- Issue #288 (ADR-0030) — the stored-value tenders in the payment-allocation
-- ledger (`sql/940`, ADR-0025). `sql/940`'s header said it plainly: "Store
-- credit / gift card are NOT in the list on purpose — a CHECK value no code
-- path can write is a claim, not a feature; widen the constraint in the
-- migration that ships the first writer." This is that migration: the writer
-- is `application/payment-allocation-directory.ts` +
-- `application/stored-value-ledger.ts`, and `sql/985`'s ledger trigger refuses
-- any `redeem`/`refund` entry that does not mirror one of these rows.
--
-- ## What changes
--
--   * `tender_type` gains `gift_card` and `store_credit`.
--   * `stored_value_account_id` (composite FK, tenant-safe) names the account
--     the leg drew from — and the account a REVERSAL returns value to (the
--     reversal copies the payment's tender and account, exactly as it copies
--     the tender today: a refund goes back the way it came). It is set for
--     exactly the two stored-value tenders and for no other (CHECK).
--   * `provider_reference` stays NULL for these tenders: the code is never
--     written anywhere on this table (the receipt shows the account's masked
--     last four, joined from the account).
--   * The append-only guard is replaced so the new column is frozen too (the
--     body is otherwise `sql/971`'s, verbatim).
--   * A DEFERRED constraint trigger makes the pairing two-way: a stored-value
--     allocation row cannot survive a COMMIT without its mirror ledger entry
--     (`sql/985` already refuses the reverse). The redemption and the ledger
--     entry are therefore written in ONE transaction, with no network call.
--   * `awcms_commerce_orders.payment_method` (a legacy summary HINT; the ledger
--     is the truth — ADR-0025 D8) is widened with the two values, so a sale
--     paid entirely with a gift card still has an honest hint.

ALTER TABLE awcms_commerce_payment_allocations
  ADD COLUMN IF NOT EXISTS stored_value_account_id uuid;

ALTER TABLE awcms_commerce_payment_allocations
  ADD CONSTRAINT awcms_commerce_payment_allocations_stored_value_account_fk
  FOREIGN KEY (tenant_id, stored_value_account_id)
  REFERENCES awcms_commerce_stored_value_accounts (tenant_id, id);

-- Every FK column gets its own index (`db:fk-index:check`); the partial
-- predicate keeps it empty for the (vast majority of) legs that have none.
CREATE INDEX IF NOT EXISTS awcms_commerce_payment_allocations_stored_value_idx
  ON awcms_commerce_payment_allocations (stored_value_account_id)
  WHERE stored_value_account_id IS NOT NULL;

ALTER TABLE awcms_commerce_payment_allocations
  DROP CONSTRAINT IF EXISTS awcms_commerce_payment_allocations_tender_type_check;

ALTER TABLE awcms_commerce_payment_allocations
  ADD CONSTRAINT awcms_commerce_payment_allocations_tender_type_check
  CHECK (tender_type IN (
    'cash', 'manual_qris', 'manual_bank_transfer', 'gateway', 'gift_card', 'store_credit'
  ));

-- A stored-value leg names its account; no other leg does.
ALTER TABLE awcms_commerce_payment_allocations
  ADD CONSTRAINT awcms_commerce_payment_allocations_stored_value_check
  CHECK (
    (tender_type IN ('gift_card', 'store_credit'))
    = (stored_value_account_id IS NOT NULL)
  );

-- ...and never carries a free-text reference (the code must not land here).
ALTER TABLE awcms_commerce_payment_allocations
  ADD CONSTRAINT awcms_commerce_payment_allocations_stored_value_reference_check
  CHECK (
    stored_value_account_id IS NULL OR provider_reference IS NULL
  );

-- `sql/971`'s append-only guard, replaced so the new column is frozen too.
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
    OR NEW.stored_value_account_id IS DISTINCT FROM OLD.stored_value_account_id
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

-- The other half of the two-way pairing (see the header).
CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_stored_value_pairing()
RETURNS trigger AS $awcms_commerce_payment_allocations_stored_value_pairing$
BEGIN
  IF NEW.stored_value_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM awcms_commerce_stored_value_ledger
    WHERE tenant_id = NEW.tenant_id AND allocation_id = NEW.id
  ) THEN
    RAISE EXCEPTION
      'a stored-value payment-allocation row % has no mirror stored-value ledger entry',
      NEW.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$awcms_commerce_payment_allocations_stored_value_pairing$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS awcms_commerce_payment_allocations_stored_value_pairing
  ON awcms_commerce_payment_allocations;
CREATE CONSTRAINT TRIGGER awcms_commerce_payment_allocations_stored_value_pairing
  AFTER INSERT ON awcms_commerce_payment_allocations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_payment_allocations_stored_value_pairing();

-- The legacy summary hint (`sql/931` widened it for `cash`; a plain CHECK
-- cannot be altered in place). No data change: every row keeps its value.
ALTER TABLE awcms_commerce_orders
  DROP CONSTRAINT IF EXISTS awcms_commerce_orders_payment_method_check;

ALTER TABLE awcms_commerce_orders
  ADD CONSTRAINT awcms_commerce_orders_payment_method_check
  CHECK (payment_method IN (
    'manual_bank', 'manual_qris', 'dp', 'gateway', 'cash', 'gift_card', 'store_credit'
  ));

COMMENT ON COLUMN awcms_commerce_payment_allocations.stored_value_account_id IS
  'Issue #288 (ADR-0030) — the gift-card / store-credit account a gift_card|store_credit leg drew from (or, on a reversal, returns value to); NULL for every other tender. Frozen. The redeemable code is never stored on this table.';
