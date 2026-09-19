-- Issue #91 (C3, contract #86/ADR-0016) — exactly one default address per
-- customer, enforced by the DATABASE rather than merely trusted to
-- `application/customer-account-resources.ts`'s own care (the same "the
-- schema is the actual authority" posture every other partial-unique
-- constraint in this module already takes, e.g. `sql/917`'s
-- `awcms_commerce_customer_accounts_email_key`).
--
-- ## Why the guest-era rows are cleaned up FIRST
--
-- `application/customer-directory.ts`'s `saveCustomerAddress` (Issue #29,
-- guest checkout) has always marked the FIRST address a customer ever
-- accumulates `is_default = true` and never touches that flag again on any
-- LATER address for the same customer — so a guest with only one address
-- per checkout never produces a duplicate, but nothing in that code path
-- actually GUARANTEES it: two concurrent guest checkouts for a brand-new
-- phone number could both read "no address yet" and both insert
-- `is_default = true` before either commits. A partial unique index on
-- `(tenant_id, customer_id) WHERE is_default AND deleted_at IS NULL` would
-- fail outright to CREATE against a deployed database carrying such a
-- duplicate, so this migration demotes every default but the most recently
-- created live one per (tenant, customer) before creating the index —
-- idempotent (a database with no duplicate updates zero rows) and safe to
-- re-run.
UPDATE awcms_commerce_customer_addresses AS a
SET is_default = false, updated_at = now()
WHERE a.is_default
  AND a.deleted_at IS NULL
  AND a.id <> (
    SELECT b.id
    FROM awcms_commerce_customer_addresses AS b
    WHERE b.tenant_id = a.tenant_id
      AND b.customer_id = a.customer_id
      AND b.is_default
      AND b.deleted_at IS NULL
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customer_addresses_default_key
  ON awcms_commerce_customer_addresses (tenant_id, customer_id)
  WHERE is_default AND deleted_at IS NULL;
