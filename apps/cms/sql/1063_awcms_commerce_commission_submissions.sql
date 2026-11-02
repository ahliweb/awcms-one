-- Issue #391 (ADR-0046 D12, ADR-0147) - the commerce-owned record of which order
-- lines were SUBMITTED to the hr_commission intake queue, so a refund or a
-- cancellation voids exactly what was submitted and nothing else.
--
-- ## Why
--
-- The adapter now reports through `CommissionIntakePort` (upstream ADR-0147), an
-- eventually consistent queue: `queued` means "recorded", never "accrued", and
-- commerce cannot read the ledger or the queue back (it may only keep its OWN
-- `awcms_commerce_commission_*` state; `tests/commerce-commission-boundary.test.ts`).
-- Every business refusal (no rule, closed period, source conflict, `not_found`)
-- is shown only in the tenant's intake exceptions list. A reverser that guessed
-- (a void for every employment a login was ever linked to, for every line) would
-- queue a void whose accrual never existed; each one is refused LATER as
-- `not_found` or `no_intake_origin` and lands in that exceptions list as noise a
-- person must read. This table is commerce's own answer to "was a commission
-- submitted for this line, and for which employment and source identity?".
--
-- ## Shape
--
-- One row per (tenant, source type, order line, employment), written by the
-- order-paid consumer in the SAME transaction as the intake submission (the
-- consumer's transaction commits or rolls back both). `employment_id` is OPAQUE
-- (no foreign key into `awcms_hr_*`, no join). Order and line ids ARE commerce's
-- own and are foreign keys. Insert-only for every role: a guard trigger refuses
-- UPDATE and DELETE (the row is evidence of what was reported; a void is a NEW
-- intake record, never an edit here). No amount, base, rate or rule outcome is
-- stored: nothing here can drift from the ledger or leak a person's earnings.
-- The rule key is stored because the source identity of the accrual is
-- `(source_type, order, line)` and the intake's duplicate key includes the
-- request digest, so a replay must re-send the SAME rule key.
--
-- Growth: one ~150-byte row per commissionable order line of a tenant that has
-- switched the adapter on. Retained for the life of the tenant (no purge runs);
-- see `domain/commission-lifecycle.ts`.

CREATE TABLE IF NOT EXISTS awcms_commerce_commission_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  -- An `hr_workforce` employment id. OPAQUE: no foreign key, no read, no join.
  employment_id uuid NOT NULL,
  source_type text NOT NULL,
  rule_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_commission_submissions_order_fk
    FOREIGN KEY (tenant_id, order_id)
    REFERENCES awcms_commerce_orders (tenant_id, id),
  CONSTRAINT awcms_commerce_commission_submissions_item_fk
    FOREIGN KEY (tenant_id, order_item_id)
    REFERENCES awcms_commerce_order_items (tenant_id, id),
  CONSTRAINT awcms_commerce_commission_submissions_source_type_check
    CHECK (source_type ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  CONSTRAINT awcms_commerce_commission_submissions_rule_key_check
    CHECK (rule_key ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  CONSTRAINT awcms_commerce_commission_submissions_line_key
    UNIQUE (tenant_id, source_type, order_item_id, employment_id)
);

-- A reversal reads every submission of ONE order.
CREATE INDEX IF NOT EXISTS awcms_commerce_commission_submissions_order_idx
  ON awcms_commerce_commission_submissions (tenant_id, order_id);

-- The settings screen reads the tenant's latest submission time.
CREATE INDEX IF NOT EXISTS awcms_commerce_commission_submissions_tenant_created_idx
  ON awcms_commerce_commission_submissions (tenant_id, created_at DESC);

ALTER TABLE awcms_commerce_commission_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_commission_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_commission_submissions_tenant_isolation
  ON awcms_commerce_commission_submissions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_commission_submissions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $awcms_commerce_commission_submissions_guard$
BEGIN
  RAISE EXCEPTION
    'awcms_commerce_commission_submissions: a row is evidence of what was submitted to the commission intake and is never changed or deleted (Issue #391)'
    USING ERRCODE = 'restrict_violation';
END;
$awcms_commerce_commission_submissions_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_commission_submissions_guard
  ON awcms_commerce_commission_submissions;
CREATE TRIGGER awcms_commerce_commission_submissions_guard
  BEFORE UPDATE OR DELETE ON awcms_commerce_commission_submissions
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_commission_submissions_guard();

REVOKE UPDATE, DELETE, TRUNCATE ON awcms_commerce_commission_submissions FROM awcms_app;

-- `awcms_worker` runs the three commission consumers in `domain-events:dispatch`:
-- the attributor writes a submission, the two reversers read them. SELECT and
-- INSERT only (the insert carries `ON CONFLICT (...) DO NOTHING`, whose arbiter
-- read needs SELECT: sql/127's lesson). `awcms_app` keeps SELECT (the settings
-- screen reads the latest time) and INSERT, because the consumer's handler also
-- runs in-process under the runtime role in the integration harness; it can
-- never update or delete a row.
GRANT SELECT, INSERT ON awcms_commerce_commission_submissions TO awcms_worker;

-- The reversers read the cancelling or refunding person from the delivered
-- event's own envelope (`awcms_domain_events.actor_tenant_user_id`): the runtime
-- has already granted the worker SELECT on it (sql/022).
