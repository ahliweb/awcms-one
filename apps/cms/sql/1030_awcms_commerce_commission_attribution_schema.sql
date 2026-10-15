-- Issue #391 (ADR-0046) - the commerce side of the employee-commission
-- sale-attribution adapter: when a POS sale is paid, report each of its lines
-- to the `hr_commission` accrual ledger through the neutral
-- `CommissionAccrualPort` (`_shared/ports/commission-accrual-port.ts`).
--
-- This issue owns migrations 1030-1031 (ADR-0037): 1030 is this file (schema),
-- 1031 seeds the permissions and the worker grants. Same conventions as
-- `sql/1010` (not repeated in full): ENABLE + FORCE ROW LEVEL SECURITY with one
-- tenant-isolation policy, composite `(tenant_id, ...)` foreign keys, an index
-- for every FK column, `text` + CHECK for every enumerated column.
--
-- ## What lives here, and what deliberately does not
--
-- Two small tables, both written only by an authenticated administrator:
--
--   * `awcms_commerce_commission_settings` - one row per tenant: whether the
--     adapter is on (DEFAULT OFF - paying commission is a money decision a
--     tenant must make), which `hr_commission` rule key to apply, and the
--     source type that rule declares (a rule says which kind of event it applies
--     to; the port refuses a mismatch). There is NO default rule key: until a
--     tenant names one, nothing is reported.
--   * `awcms_commerce_commission_staff_links` - which employment earns the
--     commission of a sale rung up by which tenant user. The employment id is an
--     OPAQUE uuid with NO foreign key: commerce never reads, joins or constrains
--     against `hr_workforce` or `hr_commission` tables (ADR-0011; a test scans
--     commerce's sources for those table names). The accrual port validates the
--     employment (it exists in the tenant, is live and employed on the sale
--     date) under lock when the accrual is written.
--
-- There is no commission amount, rate, base or accrual state in this module: the
-- ledger owns the arithmetic and the lifecycle. The only per-sale fact commerce
-- keeps is the order itself, and the exactly-once guarantee is the ledger's own
-- unique key `(source type, order id, order-line id, employment)` - a redelivered
-- event is one accrual, never two.
--
-- ## The beneficiary is never client-supplied (threat model F5)
--
-- No order, cart or checkout field names the employee. The seller of a POS sale
-- is `awcms_commerce_orders.pos_cashier_tenant_user_id`, stamped from the
-- authenticated session when the sale is rung up (`sql/931`); this table maps
-- that login to an employment. A storefront order has no such stamp and is never
-- attributed.
--
-- ## Retention
--
-- Neither table is purged: a link is the evidence of who was entitled to be paid
-- commission for a sale at the time, and a retired link is kept (it is retired,
-- never deleted - `awcms_app` is REVOKEd DELETE and a trigger refuses it for
-- every role). Both are small and human-authored.

-- 1. settings ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_commission_settings (
  tenant_id uuid PRIMARY KEY REFERENCES awcms_tenants (id),
  -- DEFAULT OFF. A tenant that never opens the screen/API sees no change at all.
  enabled boolean NOT NULL DEFAULT false,
  -- The `hr_commission` rule key applied to every attributed line. No default.
  rule_key text,
  -- Must equal that rule's `sourceType` (the port refuses a mismatch). The
  -- neutral default names what the adapter reports: one order line.
  source_type text NOT NULL DEFAULT 'commerce_order_line',
  updated_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_commission_settings_rule_key_check
    CHECK (rule_key IS NULL OR rule_key ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  CONSTRAINT awcms_commerce_commission_settings_source_type_check
    CHECK (source_type ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  -- The adapter cannot be switched on without saying what to apply.
  CONSTRAINT awcms_commerce_commission_settings_enabled_check
    CHECK (NOT enabled OR rule_key IS NOT NULL)
);

ALTER TABLE awcms_commerce_commission_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_commission_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_commission_settings_tenant_isolation
  ON awcms_commerce_commission_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- 2. staff links ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS awcms_commerce_commission_staff_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  -- The login that rings up sales (`awcms_commerce_orders.pos_cashier_tenant_user_id`).
  tenant_user_id uuid NOT NULL,
  -- An `hr_workforce` employment id. OPAQUE: no foreign key, no read, no join.
  employment_id uuid NOT NULL,
  -- Plain uuid stamps, not FKs (`sql/931`'s reasoning): the record of who
  -- decided this must outlive the staff account that did.
  created_by_tenant_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_by_tenant_user_id uuid,
  retired_at timestamptz,
  CONSTRAINT awcms_commerce_commission_staff_links_tenant_user_fk
    FOREIGN KEY (tenant_id, tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id),
  CONSTRAINT awcms_commerce_commission_staff_links_retired_check
    CHECK ((retired_at IS NULL) = (retired_by_tenant_user_id IS NULL))
);

-- One LIVE link per login, and one per employment: a sale has exactly one
-- seller, and an employment is exactly one person's commission. A retired link
-- frees both (re-linking after a correction is a new row).
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_commission_staff_links_live_user_key
  ON awcms_commerce_commission_staff_links (tenant_id, tenant_user_id)
  WHERE retired_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_commission_staff_links_live_employment_key
  ON awcms_commerce_commission_staff_links (tenant_id, employment_id)
  WHERE retired_at IS NULL;

-- Tenant-leading index for the FK and the list ("newest first").
CREATE INDEX IF NOT EXISTS awcms_commerce_commission_staff_links_tenant_created_idx
  ON awcms_commerce_commission_staff_links (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS awcms_commerce_commission_staff_links_user_idx
  ON awcms_commerce_commission_staff_links (tenant_id, tenant_user_id);

ALTER TABLE awcms_commerce_commission_staff_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_commission_staff_links FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_commission_staff_links_tenant_isolation
  ON awcms_commerce_commission_staff_links
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- A link changes in exactly one way: it is retired, once. Who it links never
-- changes (a correction is a retire plus a new link, so the history shows both),
-- and a row is never deleted - by anyone.
CREATE OR REPLACE FUNCTION awcms_commerce_commission_staff_links_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $awcms_commerce_commission_staff_links_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'awcms_commerce_commission_staff_links: a link is retired, never deleted (Issue #391)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.tenant_user_id IS DISTINCT FROM OLD.tenant_user_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'awcms_commerce_commission_staff_links: who a link joins never changes; retire it and add a new one (Issue #391)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.retired_at IS NOT NULL
     AND (NEW.retired_at IS DISTINCT FROM OLD.retired_at
          OR NEW.retired_by_tenant_user_id IS DISTINCT FROM OLD.retired_by_tenant_user_id) THEN
    RAISE EXCEPTION
      'awcms_commerce_commission_staff_links: a retired link is final (Issue #391)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_commission_staff_links_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_commission_staff_links_guard
  ON awcms_commerce_commission_staff_links;
CREATE TRIGGER awcms_commerce_commission_staff_links_guard
  BEFORE UPDATE OR DELETE ON awcms_commerce_commission_staff_links
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_commission_staff_links_guard();

REVOKE DELETE, TRUNCATE ON awcms_commerce_commission_staff_links FROM awcms_app;
