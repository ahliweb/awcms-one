-- Let the campaign dispatcher keep enqueueing its e-mail as `awcms_worker`, and
-- keep the worker's e-mail INSERT column-scoped
-- (Issue #377, the awcms#1044 worker-insert guard arriving with the v10.8.0
-- subtree sync; completes what sql/1013 granted).
--
-- ## What broke
--
-- sql/302 (upstream) added a BEFORE INSERT trigger on `awcms_email_messages`
-- that refuses a row from any member of `awcms_worker` unless its category is on
-- a short allow-list (three `hr.attendance_correction_*` categories). sql/1013
-- had given the worker INSERT on that table so that `commerce:campaigns:dispatch`
-- works as the real worker role in production; the guard now turned every
-- campaign e-mail into `EMAIL_WORKER_CATEGORY_NOT_ALLOWED`
-- (`tests/integration/commerce-campaigns.integration.test.ts`, "one dispatch
-- tick runs end to end as the real awcms_worker role").
--
-- ## What this does
--
-- Replaces the guard function with the SAME body plus exactly one category,
-- `derived.commerce_campaign` - the only commerce category a worker-run job
-- enqueues (the other commerce e-mails, customer OTP, conversation reply and
-- document delivery, are written by the request path as `awcms_app`, which the
-- guard never touches). The test is unchanged: MEMBERSHIP of `awcms_worker` for
-- `session_user` or `current_user`, superusers exempt, `search_path` pinned with
-- `pg_temp` last.
--
-- It also NARROWS the grant sql/1013 made: that file gave the worker a
-- TABLE-level `INSERT ON awcms_email_messages`, which silently undoes the
-- COLUMN-scoped grant of sql/302 (a table-level privilege covers every column,
-- so the worker could choose `status`, `provider_*`, `sent_at` or
-- `retry_count` on a row it creates; `hr-attendance-autosettle`'s "the worker
-- may queue the notice but not choose the state of the row it creates" caught
-- it). The campaign enqueue writes exactly the ten columns sql/302 lists, so the
-- table-level privilege is revoked (which also clears any column-level one) and
-- the same ten are granted again.
--
-- ## What this does not widen
--
-- A compromised worker could already queue this category before the guard
-- existed; the guard narrowed the worker to three HR categories and this puts
-- the campaign category back, deliberately and by name. The campaign's subject
-- and body are the tenant's own template with the tenant's own variables; the
-- recipient set comes from the campaign's audience, not from the worker.
--
-- ## The overwrite hazard
--
-- This file replaces an UPSTREAM function, and a commerce migration sorts after
-- every upstream one. If upstream later adds a category by replacing the
-- function again, a fresh database would apply that and then THIS file, and the
-- new upstream category would be lost. `tests/commerce-email-worker-guard.test.ts`
-- fails when any earlier definition names a category this one does not, so the
-- sync that brings such a change also forces this file to be re-issued.
--
-- Idempotent: CREATE OR REPLACE and DROP/CREATE TRIGGER are repeatable.

BEGIN;

REVOKE INSERT ON awcms_email_messages FROM awcms_worker;
GRANT INSERT (tenant_id, correlation_id, category, template_key, to_address,
              to_address_hash, to_address_masked, subject, variables, priority)
  ON awcms_email_messages TO awcms_worker;

CREATE OR REPLACE FUNCTION awcms_email_guard_worker_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.category NOT IN ('hr.attendance_correction_applied',
                          'hr.attendance_correction_rejected',
                          'hr.attendance_correction_cancelled',
                          'derived.commerce_campaign')
     AND NOT EXISTS (
       SELECT 1 FROM pg_roles r
        WHERE r.rolname IN (session_user, current_user) AND r.rolsuper
     )
     AND (pg_has_role(session_user, 'awcms_worker', 'MEMBER')
          OR pg_has_role(current_user, 'awcms_worker', 'MEMBER')) THEN
    RAISE EXCEPTION 'awcms_email: EMAIL_WORKER_CATEGORY_NOT_ALLOWED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS awcms_email_messages_worker_guard
  ON awcms_email_messages;
CREATE TRIGGER awcms_email_messages_worker_guard
  BEFORE INSERT ON awcms_email_messages
  FOR EACH ROW EXECUTE FUNCTION awcms_email_guard_worker_insert();

COMMIT;
