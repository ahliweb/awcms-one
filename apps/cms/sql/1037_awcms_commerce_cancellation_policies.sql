-- Issue #378 (ADR-0045 D6, owner answer Q9) - versioned cancellation refund
-- policies and their windows. Data model: docs/booking-commerce-adapter-data-model.md
-- section 4.4.
--
-- A policy is per product with a tenant-wide default (`product_id IS NULL`); a
-- product's active policy overrides the default for that product. A policy is
-- IMMUTABLE once active: a change is a new version, so a refund decision can
-- always name the exact rules it applied. Resolution at decision time (done by
-- the application, a later issue): the product's active policy, else the tenant
-- default's, else NONE - refundable share 0 and `policy_source = 'none'` (D6).
--
-- ## Windows
--
-- A window says: a cancellation made at least `min_hours_before_start` whole
-- hours before the reservation's arrival instant may refund
-- `refundable_percent` of the amount paid. Windows are evaluated greatest hours
-- first and the first match applies; closer than the smallest window refunds 0.
-- The refundable share must not INCREASE as the notice shrinks: activation is
-- refused (trigger below) when a window with more notice refunds less than one
-- with less notice. Windows are insert-only while the policy is `draft`; once it
-- is `active` or `retired` the rows are frozen (and no window can be added).
-- `awcms_app` has no UPDATE or DELETE on the windows and no DELETE on the
-- policies: retired versions stay so every past decision stays explainable.
--
-- ## Lifecycle
--
-- `status` moves draft -> active -> retired only. `activated_at` is set exactly
-- when the status is active or retired, `retired_at` exactly when retired.
-- Version numbers are unique per product (or, for the default, per tenant) by two
-- partial unique indexes because NULLs are distinct in a plain one; one active
-- row per product and one active default per tenant likewise.
--
-- Every trigger function pins search_path (the #1046 gate).

CREATE TABLE IF NOT EXISTS awcms_commerce_cancellation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  product_id uuid,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  refund_basis text NOT NULL DEFAULT 'whole_stay',
  no_show_retention text NOT NULL DEFAULT 'retain_deposit',
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_cancellation_policies_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_cancellation_policies_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES awcms_commerce_products (tenant_id, id),
  CONSTRAINT awcms_commerce_cancellation_policies_version_check
    CHECK (version >= 1),
  CONSTRAINT awcms_commerce_cancellation_policies_status_check
    CHECK (status IN ('draft', 'active', 'retired')),
  CONSTRAINT awcms_commerce_cancellation_policies_basis_check
    CHECK (refund_basis IN ('whole_stay', 'per_night')),
  CONSTRAINT awcms_commerce_cancellation_policies_no_show_check
    CHECK (no_show_retention IN ('retain_deposit', 'retain_all', 'refund_per_windows')),
  CONSTRAINT awcms_commerce_cancellation_policies_activated_shape_check
    CHECK ((status IN ('active', 'retired')) = (activated_at IS NOT NULL)),
  CONSTRAINT awcms_commerce_cancellation_policies_retired_shape_check
    CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_product_version_key
  ON awcms_commerce_cancellation_policies (tenant_id, product_id, version)
  WHERE product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_default_version_key
  ON awcms_commerce_cancellation_policies (tenant_id, version)
  WHERE product_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_product_active_key
  ON awcms_commerce_cancellation_policies (tenant_id, product_id)
  WHERE status = 'active' AND product_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_default_active_key
  ON awcms_commerce_cancellation_policies (tenant_id)
  WHERE status = 'active' AND product_id IS NULL;

CREATE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_product_idx
  ON awcms_commerce_cancellation_policies (tenant_id, product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_tenant_deleted_idx
  ON awcms_commerce_cancellation_policies (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_cancellation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_cancellation_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_cancellation_policies_tenant_isolation
  ON awcms_commerce_cancellation_policies
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

REVOKE DELETE ON awcms_commerce_cancellation_policies FROM awcms_app;

CREATE TABLE IF NOT EXISTS awcms_commerce_cancellation_policy_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  policy_id uuid NOT NULL,
  min_hours_before_start integer NOT NULL,
  refundable_percent numeric(5, 2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT awcms_commerce_cancellation_policy_windows_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_cancellation_policy_windows_policy_fk
    FOREIGN KEY (tenant_id, policy_id)
    REFERENCES awcms_commerce_cancellation_policies (tenant_id, id),
  CONSTRAINT awcms_commerce_cancellation_policy_windows_hours_key
    UNIQUE (tenant_id, policy_id, min_hours_before_start),
  CONSTRAINT awcms_commerce_cancellation_policy_windows_hours_check
    CHECK (min_hours_before_start >= 0),
  CONSTRAINT awcms_commerce_cancellation_policy_windows_percent_check
    CHECK (refundable_percent BETWEEN 0 AND 100)
);

-- The FK column's own index is the leading part of the unique key above; the
-- purge cursor needs its own.
CREATE INDEX IF NOT EXISTS awcms_commerce_cancellation_policy_windows_tenant_deleted_idx
  ON awcms_commerce_cancellation_policy_windows (tenant_id, deleted_at);

ALTER TABLE awcms_commerce_cancellation_policy_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_cancellation_policy_windows FORCE ROW LEVEL SECURITY;

CREATE POLICY awcms_commerce_cancellation_policy_windows_tenant_isolation
  ON awcms_commerce_cancellation_policy_windows
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- Insert-only for the application role; the trigger below is the second line.
REVOKE UPDATE, DELETE ON awcms_commerce_cancellation_policy_windows FROM awcms_app;

-- Policies: created as drafts; identity and (once active) every rule column is
-- frozen; status only moves forward; activation requires non-increasing refund
-- shares. The BEGIN/END below are PL/pgSQL block delimiters in a dollar-quoted
-- body, not transaction control.
CREATE OR REPLACE FUNCTION awcms_commerce_cancellation_policies_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_cancellation_policies_guard$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION
        'awcms_commerce_cancellation_policies: a policy version is created as a draft'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row % is frozen: identity, product and version never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'draft' AND (
    NEW.refund_basis IS DISTINCT FROM OLD.refund_basis
    OR NEW.no_show_retention IS DISTINCT FROM OLD.no_show_retention
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row % is % and its rules are immutable: add a new version',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT (
    NEW.status = OLD.status
    OR (OLD.status = 'draft' AND NEW.status = 'active')
    OR (OLD.status = 'active' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row %: status moves draft -> active -> retired only (% -> %)',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'retired' AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row % is retired and stays retired',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'active' AND EXISTS (
    SELECT 1
    FROM awcms_commerce_cancellation_policy_windows more_notice
    JOIN awcms_commerce_cancellation_policy_windows less_notice
      ON less_notice.tenant_id = more_notice.tenant_id
     AND less_notice.policy_id = more_notice.policy_id
     AND less_notice.min_hours_before_start < more_notice.min_hours_before_start
    WHERE more_notice.tenant_id = NEW.tenant_id
      AND more_notice.policy_id = NEW.id
      AND more_notice.refundable_percent < less_notice.refundable_percent
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row %: refundable_percent must not increase as notice shrinks',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_cancellation_policies_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_cancellation_policies_guard
  ON awcms_commerce_cancellation_policies;
CREATE TRIGGER awcms_commerce_cancellation_policies_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_cancellation_policies
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_cancellation_policies_guard();

-- Windows: a row can be added only while its policy is a draft, and is never
-- updated.
CREATE OR REPLACE FUNCTION awcms_commerce_cancellation_policy_windows_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_cancellation_policy_windows_guard$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policy_windows is immutable: add a new policy version'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM awcms_commerce_cancellation_policies p
    WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.policy_id
      AND p.status = 'draft'
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policy_windows: policy % is not a draft; windows are frozen once it leaves draft',
      NEW.policy_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_cancellation_policy_windows_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_cancellation_policy_windows_guard
  ON awcms_commerce_cancellation_policy_windows;
CREATE TRIGGER awcms_commerce_cancellation_policy_windows_guard
  BEFORE INSERT OR UPDATE ON awcms_commerce_cancellation_policy_windows
  FOR EACH ROW
  EXECUTE FUNCTION awcms_commerce_cancellation_policy_windows_guard();

COMMENT ON TABLE awcms_commerce_cancellation_policies IS
  'Issue #378 (ADR-0045 D6, Q9) - a versioned cancellation refund policy; product_id NULL is the tenant default. Immutable once active; a change is a new version. No active policy means a refund of 0 (D6).';
COMMENT ON TABLE awcms_commerce_cancellation_policy_windows IS
  'Issue #378 (ADR-0045 D6) - one notice window of a cancellation policy: at least min_hours_before_start whole hours before arrival refunds refundable_percent of the amount paid. Insert-only while the policy is a draft; frozen afterwards.';
