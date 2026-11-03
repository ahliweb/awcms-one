-- Issue #430 (ADR-0048 section 3.5) - least-privilege worker grants for the
-- customer-push tables, and the guard that keeps a device's identity columns
-- immutable.
--
-- ## awcms_app
--
-- Needs nothing explicit: sql/019's default privileges give the runtime role
-- DML on every new table, and FORCE RLS (sql/1056, sql/1057) scopes each
-- statement to its tenant. What the application does with it is narrower than
-- the grant (register, revoke, preferences, cancel queued messages), enforced in
-- code and covered by the integration tests.
--
-- ## awcms_worker (`commerce:customer-push:maintenance`, the re-key command and,
-- ## in #432, the dispatch job)
--
--   awcms_commerce_push_devices        SELECT, DELETE (table level: the purge
--                                      of tombstones) and a COLUMN-ONLY UPDATE
--                                      on the status and credential columns.
--   awcms_commerce_push_preferences    SELECT (the send-time consent check).
--   awcms_commerce_push_messages       SELECT, UPDATE, DELETE (claim and
--                                      finalize in #432; the purge).
--   awcms_commerce_push_delivery_attempts  SELECT, INSERT, DELETE (the SELECT
--                                      the ON CONFLICT DO NOTHING arbiter read
--                                      needs, sql/127's lesson).
--
-- The worker CANNOT insert a device and CANNOT update `endpoint_hash`,
-- `account_id`, `session_id` or `storefront_origin` (none is in the column
-- list): a worker able to rewrite those could redirect a delivery to another
-- account or origin, which is the lesson upstream's sql/314 recorded for
-- `awcms_push_subscriptions`. It may set the credential columns because
-- destroying them is part of revoking a device and re-encrypting them is the
-- key-rotation job; the guard below bounds what it may write there.
--
-- The worker has no INSERT on messages here: the consumers that enqueue run in
-- the domain-event runtime and are mapped by #432.
--
-- ## The device guard (BEFORE UPDATE)
--
-- For every role: `id`, `tenant_id`, `endpoint_hash`, `created_at` never change.
-- For the worker additionally: `p256dh_key` may only be cleared (never replaced
-- by another value), and the two ciphertext columns may only be cleared or
-- re-written while the row stays active (the re-key job) - so a compromised job
-- cannot turn a tombstone back into a live subscription or swap the public key.

GRANT SELECT, DELETE ON awcms_commerce_push_devices TO awcms_worker;
GRANT UPDATE (status, status_reason, revoked_at, last_success_at, failure_count,
              updated_at, endpoint_ciphertext, p256dh_key, auth_secret_ciphertext)
  ON awcms_commerce_push_devices TO awcms_worker;

GRANT SELECT ON awcms_commerce_push_preferences TO awcms_worker;

GRANT SELECT, UPDATE, DELETE ON awcms_commerce_push_messages TO awcms_worker;

GRANT SELECT, INSERT, DELETE ON awcms_commerce_push_delivery_attempts TO awcms_worker;

CREATE OR REPLACE FUNCTION awcms_commerce_push_devices_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $awcms_commerce_push_devices_guard$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.endpoint_hash IS DISTINCT FROM OLD.endpoint_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'awcms_commerce_push_devices: id, tenant_id, endpoint_hash and created_at are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF current_user = 'awcms_worker' THEN
    IF NEW.p256dh_key IS NOT NULL
      AND NEW.p256dh_key IS DISTINCT FROM OLD.p256dh_key THEN
      RAISE EXCEPTION
        'awcms_commerce_push_devices: the worker may clear p256dh_key but not replace it'
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF (NEW.endpoint_ciphertext IS NOT NULL
        AND NEW.endpoint_ciphertext IS DISTINCT FROM OLD.endpoint_ciphertext)
      OR (NEW.auth_secret_ciphertext IS NOT NULL
        AND NEW.auth_secret_ciphertext IS DISTINCT FROM OLD.auth_secret_ciphertext) THEN
      IF OLD.status <> 'active' OR NEW.status <> 'active' THEN
        RAISE EXCEPTION
          'awcms_commerce_push_devices: the worker may re-encrypt a credential only on an active device'
          USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$awcms_commerce_push_devices_guard$;

CREATE TRIGGER awcms_commerce_push_devices_guard
  BEFORE UPDATE ON awcms_commerce_push_devices
  FOR EACH ROW EXECUTE FUNCTION awcms_commerce_push_devices_guard();
