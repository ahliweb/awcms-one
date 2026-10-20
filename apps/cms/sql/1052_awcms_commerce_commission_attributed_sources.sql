-- Issue #413 review (ADR-0046) - the durable record that a commission source
-- identity has been used, so the commission settings can refuse to change it.
--
-- ## Why
--
-- The accrual source identity is `(settings.source_type, order id, order-line
-- id)` and the ledger keys a replay on it (and treats the same identity with a
-- different rule key as a conflict). A later void is addressed by the same
-- identity. If an administrator changed `source_type` or `rule_key` after
-- accruals exist, a void would silently miss and a redelivered event could
-- accrue a second time under the new identity.
--
-- Commerce never reads the commission ledger (ADR-0046, enforced by
-- `tests/commerce-commission-boundary.test.ts`), and the audit trail is subject
-- to purge, so neither can answer "has an accrual been made for this pair?".
-- This table is commerce's own answer: the consumer inserts one row per
-- `(source_type, rule_key)` pair in the SAME transaction as the first accrual
-- reported under it, and the settings update reads it under the same advisory
-- lock the consumer takes shared.
--
-- ## Shape
--
-- At most one row per (tenant, source_type, rule_key), so the ceiling is the
-- number of times a tenant has ever changed those two settings: human-authored
-- and tiny. Insert-only for every role (a guard trigger refuses UPDATE and
-- DELETE); the row is evidence and is never purged. No personal data: two
-- codes and a timestamp.

CREATE TABLE IF NOT EXISTS awcms_commerce_commission_attributed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  source_type text NOT NULL,
  rule_key text NOT NULL,
  first_attributed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_commission_attributed_sources_source_type_check
    CHECK (source_type ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  CONSTRAINT awcms_commerce_commission_attributed_sources_rule_key_check
    CHECK (rule_key ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  CONSTRAINT awcms_commerce_commission_attributed_sources_pair_key
    UNIQUE (tenant_id, source_type, rule_key)
);

-- The unique key above leads with `tenant_id` and so also serves the tenant FK
-- and the "does this tenant have any row" lookup.

ALTER TABLE awcms_commerce_commission_attributed_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_commission_attributed_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_commission_attributed_sources_tenant_isolation
  ON awcms_commerce_commission_attributed_sources
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_commission_attributed_sources_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $awcms_commerce_commission_attributed_sources_guard$
BEGIN
  RAISE EXCEPTION
    'awcms_commerce_commission_attributed_sources: a row is evidence that a source identity was used and is never changed or deleted (Issue #413)'
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_commission_attributed_sources_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_commission_attributed_sources_guard
  ON awcms_commerce_commission_attributed_sources;
CREATE TRIGGER awcms_commerce_commission_attributed_sources_guard
  BEFORE UPDATE OR DELETE ON awcms_commerce_commission_attributed_sources
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_commission_attributed_sources_guard();

REVOKE UPDATE, DELETE, TRUNCATE ON awcms_commerce_commission_attributed_sources FROM awcms_app;

-- `awcms_worker` runs the `commerce.order_paid_commission_attributor` consumer:
-- it reads the marker and writes the first one. SELECT and INSERT only.
-- `awcms_app` keeps SELECT (the settings update reads it) and INSERT, because
-- the consumer's handler also runs in-process under the runtime role in the
-- integration harness; it can never update or delete a row.
GRANT SELECT, INSERT ON awcms_commerce_commission_attributed_sources TO awcms_worker;
