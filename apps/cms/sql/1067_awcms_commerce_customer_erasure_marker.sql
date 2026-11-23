-- Issue #529 (ADR-0055 D2) - the marker an erased customer carries, and the two
-- OTP purposes a data-subject request needs.
--
-- ## `erased_at`, deliberately not `deleted_at`
--
-- `commerce.customers` is purged by age through `deleted_at` (a hard DELETE
-- after 365 days), and `awcms_commerce_orders.customer_id` is a plain FK to the
-- customer with no ON DELETE action. Setting `deleted_at` on an erased customer
-- who has orders would make that purge fail on the FK, and would make the
-- bookkeeping rows lose their (anonymised) customer. An erased customer is
-- therefore a LIVE row whose name, phone and e-mail were replaced with
-- per-row-unique sentinels, flagged by `erased_at` so every eligibility
-- predicate (segments, push, login, lookup) can leave it out.
--
-- Both columns are NULL for every existing row and stay NULL until an erasure
-- runs; the added column needs no backfill and no rewrite.
ALTER TABLE awcms_commerce_customers
  ADD COLUMN IF NOT EXISTS erased_at timestamptz;
ALTER TABLE awcms_commerce_customer_accounts
  ADD COLUMN IF NOT EXISTS erased_at timestamptz;

-- The OTP table serves login and registration; a data-subject request needs a
-- code of its own (a fresh proof of control of the mailbox on top of the
-- bearer session), kept apart by purpose so a login code never authorises an
-- erasure and the reverse.
ALTER TABLE awcms_commerce_customer_otps
  DROP CONSTRAINT IF EXISTS awcms_commerce_customer_otps_purpose_check;
ALTER TABLE awcms_commerce_customer_otps
  ADD CONSTRAINT awcms_commerce_customer_otps_purpose_check
  CHECK (purpose IN ('login', 'register', 'subject_export', 'subject_erasure'));
