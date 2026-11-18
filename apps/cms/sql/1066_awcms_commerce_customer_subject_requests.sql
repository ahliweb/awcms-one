-- Issue #529 (ADR-0055) - the commerce-owned record of a shopper's data-subject
-- request: an export (right of access) or an erasure (right to erasure) under
-- UU PDP 27/2022, keyed by the commerce customer rather than by a tenant user.
--
-- ## Why this table exists
--
-- The upstream subject-data engine finds rows by a tenant-user, identity or
-- profile id, and a commerce customer carries none of them (ADR-0016 D1), so
-- `commerce` owns the flow (ADR-0055 D1). This is the flow's own evidence: who
-- asked, through which surface, what was decided, why a request was refused,
-- and what the erasure left in place. It holds COUNTS and CODES only - never an
-- export bundle (D4: the bundle is returned once and not stored, so it creates
-- no retention duty of its own), a name, an address, a code or a token.
--
-- ## Shape
--
-- One row per request.
--   - `request_type` `export` | `erasure`; `channel` `storefront` (the shopper,
--     bearer session plus a fresh OTP) | `admin` (staff, step-up).
--   - `status`: `disclosed` (an export that was served), `pending_approval` (an
--     admin erasure waiting for a second person), `refused` (the precondition
--     check answered with `refusal_code`), `rejected` (a checker said no),
--     `completed` (the erasure ran; `retained_summary` says what stayed).
--   - maker/checker: `requested_by_tenant_user_id` is NULL for a shopper's own
--     request; `decided_by_tenant_user_id` must differ from it (CHECK) - the
--     separation of duties the app also enforces before it writes.
--   - `idempotency_key` (client key, unique per tenant): a replay of the same
--     key finds the stored answer instead of running a second erasure.
--
-- ## Immutability
--
-- A row in a terminal status is evidence and never changes; only a
-- `pending_approval` row may be updated (once, into a terminal status), and no
-- row is ever deleted. Retention is for the life of the tenant (no purge runs).
-- `customer_id` is a composite FK to the (anonymised, never deleted) customer.

CREATE TABLE IF NOT EXISTS awcms_commerce_customer_subject_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES awcms_tenants (id),
  customer_id uuid NOT NULL,
  account_id uuid,
  request_type text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  refusal_code text,
  reason text,
  idempotency_key text,
  requested_by_tenant_user_id uuid,
  decided_by_tenant_user_id uuid,
  decided_at timestamptz,
  completed_at timestamptz,
  rows_affected integer,
  retained_summary jsonb,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awcms_commerce_customer_subject_requests_tenant_id_id_key
    UNIQUE (tenant_id, id),
  CONSTRAINT awcms_commerce_customer_subject_requests_customer_fk
    FOREIGN KEY (tenant_id, customer_id)
    REFERENCES awcms_commerce_customers (tenant_id, id),
  CONSTRAINT awcms_commerce_customer_subject_requests_type_check
    CHECK (request_type IN ('export', 'erasure')),
  CONSTRAINT awcms_commerce_customer_subject_requests_channel_check
    CHECK (channel IN ('storefront', 'admin')),
  CONSTRAINT awcms_commerce_customer_subject_requests_status_check
    CHECK (status IN ('disclosed', 'pending_approval', 'refused', 'rejected', 'completed')),
  CONSTRAINT awcms_commerce_customer_subject_requests_refusal_code_check
    CHECK (refusal_code IS NULL OR refusal_code ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  CONSTRAINT awcms_commerce_customer_subject_requests_reason_check
    CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
  CONSTRAINT awcms_commerce_customer_subject_requests_key_check
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT awcms_commerce_customer_subject_requests_rows_check
    CHECK (rows_affected IS NULL OR rows_affected >= 0),
  -- An export is never approved; only an erasure waits for a checker.
  CONSTRAINT awcms_commerce_customer_subject_requests_pending_erasure_check
    CHECK (status <> 'pending_approval' OR request_type = 'erasure'),
  -- A refusal names its code; nothing else carries one.
  CONSTRAINT awcms_commerce_customer_subject_requests_refusal_shape_check
    CHECK ((status = 'refused') = (refusal_code IS NOT NULL)),
  -- An admin request is made by a staff member; a storefront one by nobody on staff.
  CONSTRAINT awcms_commerce_customer_subject_requests_channel_actor_check
    CHECK ((channel = 'admin') = (requested_by_tenant_user_id IS NOT NULL)),
  -- A decision is recorded as a pair, and a checker is never the maker.
  CONSTRAINT awcms_commerce_customer_subject_requests_decision_shape_check
    CHECK ((decided_by_tenant_user_id IS NULL) = (decided_at IS NULL)),
  CONSTRAINT awcms_commerce_customer_subject_requests_maker_checker_check
    CHECK (
      decided_by_tenant_user_id IS NULL
      OR requested_by_tenant_user_id IS NULL
      OR decided_by_tenant_user_id <> requested_by_tenant_user_id
    ),
  CONSTRAINT awcms_commerce_customer_subject_requests_completed_check
    CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);

-- The FK's own index and the admin list's per-customer read.
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_subject_requests_customer_idx
  ON awcms_commerce_customer_subject_requests (tenant_id, customer_id, created_at DESC);

-- The admin list (newest first, optionally one status).
CREATE INDEX IF NOT EXISTS awcms_commerce_customer_subject_requests_tenant_created_idx
  ON awcms_commerce_customer_subject_requests (tenant_id, created_at DESC, id DESC);

-- A replayed key finds the first request; a second row for it cannot exist.
CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_customer_subject_requests_key_key
  ON awcms_commerce_customer_subject_requests (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE awcms_commerce_customer_subject_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE awcms_commerce_customer_subject_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY awcms_commerce_customer_subject_requests_tenant_isolation
  ON awcms_commerce_customer_subject_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE OR REPLACE FUNCTION awcms_commerce_customer_subject_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_customer_subject_requests_guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'awcms_commerce_customer_subject_requests: a data-subject request is evidence and is never deleted (Issue #529)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'pending_approval' THEN
    RAISE EXCEPTION
      'awcms_commerce_customer_subject_requests: a request in status % is final and is never changed (Issue #529)', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The identity of the request never moves; only its outcome is written.
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.request_type IS DISTINCT FROM OLD.request_type
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.requested_by_tenant_user_id IS DISTINCT FROM OLD.requested_by_tenant_user_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'awcms_commerce_customer_subject_requests: only the outcome of a pending request may be written (Issue #529)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$awcms_commerce_customer_subject_requests_guard$;

DROP TRIGGER IF EXISTS awcms_commerce_customer_subject_requests_guard
  ON awcms_commerce_customer_subject_requests;
CREATE TRIGGER awcms_commerce_customer_subject_requests_guard
  BEFORE UPDATE OR DELETE ON awcms_commerce_customer_subject_requests
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_customer_subject_requests_guard();

REVOKE DELETE, TRUNCATE ON awcms_commerce_customer_subject_requests FROM awcms_app;

-- `awcms_worker` reads the table only for the data-lifecycle engine's dry-run
-- snapshot of its `delegated` descriptor (`data-lifecycle:worker-grants:check`):
-- SELECT and nothing else. It holds counts, codes and actor ids, no bundle.
GRANT SELECT ON awcms_commerce_customer_subject_requests TO awcms_worker;
