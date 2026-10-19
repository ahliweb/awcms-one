-- Issue #381 (ADR-0045 D4, D8, D13, G5; access matrix section 6) - the additive
-- schema the booking cancellation, refund quote and refund override need on top
-- of the adapter tables of sql/1035-1038. Four small, independent changes.
--
-- ## 1. A returns kind for a booking cancellation (D4)
--
-- A cancellation refund rides a return (ADR-0033: every refund leg has a
-- return), but it is not "goods accepted back". The `kind` CHECK widens by the
-- one value `cancellation`; the return carries ONE line on the service order
-- item, `goods_gross` equal to the decision's `final_refund`, no shipping and no
-- separate tax share, and no restock path. The line's `reason` and
-- `disposition` CHECKs widen by `booking_cancelled` and `not_applicable` (a
-- service has no goods to put back). The generic returns route keeps its own
-- closed vocabulary in code (`domain/returns.ts`), so a client can still never
-- send `cancellation`. The returns daily projection (sql/945) widens by the
-- same two buckets, so a cancellation appears in the returns report under its
-- own kind (D13) instead of being refused by the projection's CHECK.
--
-- ## 2. The decision remembers who asked and what (G5)
--
-- `client_key` / `request_hash` mirror the reservation link's (sql/1035): the
-- caller's `Idempotency-Key`, namespaced by the acting party, and the keyed hash
-- of the request. The same key with the same request replays the decision; the
-- same key with another request is a conflict. Both are NULL only for a
-- decision that is not made by a request (a later system path); the pair is
-- all-or-nothing.
--
-- ## 3. Who wrote and who approved a policy version (UX 11.4)
--
-- History shows "approved by and on". The author is set at INSERT and frozen;
-- the approver is set exactly once, by the draft -> active transition, and
-- frozen afterwards. The guard function is re-issued with those two rules
-- (`CREATE OR REPLACE`, search_path pinned as in sql/1037); everything else in
-- it is unchanged.

-- ---------------------------------------------------------------------------
-- 1. returns / return lines / the returns report
-- ---------------------------------------------------------------------------

ALTER TABLE awcms_commerce_returns
  DROP CONSTRAINT IF EXISTS awcms_commerce_returns_kind_check;
ALTER TABLE awcms_commerce_returns
  ADD CONSTRAINT awcms_commerce_returns_kind_check
  CHECK (kind IN ('return', 'exchange', 'cancellation'));

ALTER TABLE awcms_commerce_return_lines
  DROP CONSTRAINT IF EXISTS awcms_commerce_return_lines_reason_check;
ALTER TABLE awcms_commerce_return_lines
  ADD CONSTRAINT awcms_commerce_return_lines_reason_check
  CHECK (reason IN (
    'defective', 'wrong_item', 'not_as_described', 'damaged_in_transit',
    'changed_mind', 'size_fit', 'duplicate_order', 'other',
    'booking_cancelled'
  ));

ALTER TABLE awcms_commerce_return_lines
  DROP CONSTRAINT IF EXISTS awcms_commerce_return_lines_disposition_check;
ALTER TABLE awcms_commerce_return_lines
  ADD CONSTRAINT awcms_commerce_return_lines_disposition_check
  CHECK (disposition IN ('restock', 'damaged', 'quarantine', 'not_applicable'));

ALTER TABLE awcms_commerce_report_returns_daily
  DROP CONSTRAINT IF EXISTS awcms_commerce_report_returns_daily_bucket_check;
ALTER TABLE awcms_commerce_report_returns_daily
  ADD CONSTRAINT awcms_commerce_report_returns_daily_bucket_check
  CHECK (
    (section = 'return'
      AND bucket IN ('return', 'exchange', 'cancellation') AND detail = '')
    OR (section = 'disposition'
        AND bucket IN ('restock', 'damaged', 'quarantine', 'not_applicable')
        AND detail = '')
    OR (section = 'refund' AND length(bucket) > 0
        AND detail IN ('original_tender', 'store_credit'))
  );

-- ---------------------------------------------------------------------------
-- 2. refund decisions: the idempotency pair
-- ---------------------------------------------------------------------------

ALTER TABLE awcms_commerce_booking_refund_decisions
  ADD COLUMN IF NOT EXISTS client_key text,
  ADD COLUMN IF NOT EXISTS request_hash text;

ALTER TABLE awcms_commerce_booking_refund_decisions
  ADD CONSTRAINT awcms_commerce_booking_refund_decisions_client_key_check
  CHECK (
    (client_key IS NULL) = (request_hash IS NULL)
    AND (client_key IS NULL OR char_length(client_key) BETWEEN 1 AND 300)
    AND (request_hash IS NULL OR char_length(request_hash) BETWEEN 1 AND 128)
  );

CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_booking_refund_decisions_client_key_key
  ON awcms_commerce_booking_refund_decisions (tenant_id, client_key)
  WHERE client_key IS NOT NULL;

COMMENT ON COLUMN awcms_commerce_booking_refund_decisions.client_key IS
  'Issue #381 (ADR-0045 G5) - the caller''s Idempotency-Key namespaced by the acting party (bc1:<actor>:<digest>); a replay with the same request returns this decision, a different request is a conflict.';
COMMENT ON COLUMN awcms_commerce_booking_refund_decisions.request_hash IS
  'Issue #381 (ADR-0045 G5) - keyed hash of the cancel request that produced the decision; never a copy of a field of the request.';

-- ---------------------------------------------------------------------------
-- 3. cancellation policy versions: author and approver
-- ---------------------------------------------------------------------------

-- One statement per column: scripts/subject-data-registry-check.ts reads the
-- first column of an ALTER TABLE ... ADD COLUMN list only.
ALTER TABLE awcms_commerce_cancellation_policies
  ADD COLUMN IF NOT EXISTS created_by_tenant_user_id uuid;
ALTER TABLE awcms_commerce_cancellation_policies
  ADD COLUMN IF NOT EXISTS approved_by_tenant_user_id uuid;

ALTER TABLE awcms_commerce_cancellation_policies
  ADD CONSTRAINT awcms_commerce_cancellation_policies_created_by_fk
    FOREIGN KEY (tenant_id, created_by_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id),
  ADD CONSTRAINT awcms_commerce_cancellation_policies_approved_by_fk
    FOREIGN KEY (tenant_id, approved_by_tenant_user_id)
    REFERENCES awcms_tenant_users (tenant_id, id);

CREATE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_created_by_idx
  ON awcms_commerce_cancellation_policies (tenant_id, created_by_tenant_user_id)
  WHERE created_by_tenant_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS awcms_commerce_cancellation_policies_approved_by_idx
  ON awcms_commerce_cancellation_policies (tenant_id, approved_by_tenant_user_id)
  WHERE approved_by_tenant_user_id IS NOT NULL;

-- The sql/1037 guard plus: the author is part of the frozen identity, and the
-- approver is set only by the draft -> active transition. The BEGIN/END below
-- are PL/pgSQL block delimiters in a dollar-quoted body, not transaction
-- control.
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
    IF NEW.approved_by_tenant_user_id IS NOT NULL THEN
      RAISE EXCEPTION
        'awcms_commerce_cancellation_policies: a draft has no approver yet'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.created_by_tenant_user_id IS DISTINCT FROM OLD.created_by_tenant_user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row % is frozen: identity, product, version and author never change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status <> 'draft' AND (
    NEW.refund_basis IS DISTINCT FROM OLD.refund_basis
    OR NEW.no_show_retention IS DISTINCT FROM OLD.no_show_retention
    OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
    OR NEW.approved_by_tenant_user_id IS DISTINCT FROM OLD.approved_by_tenant_user_id
  ) THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row % is % and its rules are immutable: add a new version',
      OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'draft'
    AND NEW.approved_by_tenant_user_id IS DISTINCT FROM OLD.approved_by_tenant_user_id
  THEN
    RAISE EXCEPTION
      'awcms_commerce_cancellation_policies row %: the approver is recorded when the draft is activated',
      OLD.id
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

COMMENT ON COLUMN awcms_commerce_cancellation_policies.created_by_tenant_user_id IS
  'Issue #381 - who authored this version (set at INSERT, frozen).';
COMMENT ON COLUMN awcms_commerce_cancellation_policies.approved_by_tenant_user_id IS
  'Issue #381 - who activated this version (set once, by the draft -> active transition, then frozen). Separation of authoring and approving is a tenant SoD rule over the two permissions, not a hard-coded one (access matrix section 8).';
