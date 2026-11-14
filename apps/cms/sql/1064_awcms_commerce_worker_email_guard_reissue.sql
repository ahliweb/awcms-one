-- Re-issue the worker e-mail guard as the UNION of upstream's latest definition
-- and commerce's one category (found by the 14 November 2026 subtree sync;
-- supersedes the function body of sql/1033, which stays as applied).
--
-- ## What broke
--
-- sql/1033 replaced `awcms_email_guard_worker_insert()` with sql/302's three
-- `hr.attendance_correction_*` categories plus `derived.commerce_campaign`.
-- Upstream then replaced the function again in sql/371 (ahliweb/awcms #1165,
-- ADR-0159): three `crm.follow_up_*` categories, and for those the guard also
-- refuses a recipient that is not an active staff user of the row's own tenant
-- and any variable key outside the category's allow-list. A commerce migration
-- sorts after every upstream one, so on a fresh database sql/371 was applied and
-- then sql/1033 overwrote it: `crm-follow-up:dispatch` would have been refused
-- as `EMAIL_WORKER_CATEGORY_NOT_ALLOWED` and the staff-only recipient check
-- would have vanished. `tests/commerce-email-worker-guard.test.ts` caught it
-- (it fails when an earlier definition names a category the last one lacks), as
-- sql/1033's own header predicted.
--
-- ## What this does
--
-- The body of sql/371 verbatim, with exactly one more category on the allow-list,
-- `derived.commerce_campaign`. That category has no recipient or variable rule
-- here, as in sql/1033: the campaign dispatcher's recipients come from the
-- campaign audience and its variables from the tenant's own template. Everything
-- else (membership of `awcms_worker` for `session_user` or `current_user`,
-- superusers exempt, `search_path` pinned with `pg_temp` last) is sql/371's.
-- The trigger and the column-scoped INSERT grant are untouched (sql/302,
-- sql/1033).
--
-- ## The overwrite hazard, still
--
-- This file replaces an upstream function and sorts after every upstream
-- migration. The test above fails when any earlier definition names a category
-- the last one lacks, so the next sync that re-issues the function must re-issue
-- THIS file again as a new, higher-numbered commerce migration (never edit an
-- applied one). It retires when upstream gains a descriptor-declared worker
-- e-mail category (ahliweb/awcms#1277).
--
-- Idempotent: CREATE OR REPLACE is repeatable.

BEGIN;

CREATE OR REPLACE FUNCTION awcms_email_guard_worker_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  by_worker boolean;
BEGIN
  by_worker :=
    NOT EXISTS (
      SELECT 1 FROM pg_roles r
       WHERE r.rolname IN (session_user, current_user) AND r.rolsuper
    )
    AND (pg_has_role(session_user, 'awcms_worker', 'MEMBER')
         OR pg_has_role(current_user, 'awcms_worker', 'MEMBER'));

  IF NOT by_worker THEN
    RETURN NEW;
  END IF;

  IF NEW.category NOT IN ('hr.attendance_correction_applied',
                          'hr.attendance_correction_rejected',
                          'hr.attendance_correction_cancelled',
                          'crm.follow_up_assigned',
                          'crm.follow_up_due',
                          'crm.follow_up_escalated',
                          'derived.commerce_campaign') THEN
    RAISE EXCEPTION 'awcms_email: EMAIL_WORKER_CATEGORY_NOT_ALLOWED'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.category IN ('crm.follow_up_assigned',
                      'crm.follow_up_due',
                      'crm.follow_up_escalated') THEN
    IF NOT EXISTS (
      SELECT 1
        FROM awcms_tenant_users tu
        JOIN awcms_identities i
          ON i.tenant_id = tu.tenant_id AND i.id = tu.identity_id
       WHERE tu.tenant_id = NEW.tenant_id
         AND tu.status = 'active'
         AND lower(btrim(i.login_identifier)) = NEW.to_address
    ) THEN
      RAISE EXCEPTION 'awcms_email: EMAIL_WORKER_RECIPIENT_NOT_STAFF'
        USING ERRCODE = '42501';
    END IF;

    IF NEW.variables IS NOT NULL
       AND (jsonb_typeof(NEW.variables) <> 'object'
            OR EXISTS (
              SELECT 1 FROM jsonb_object_keys(NEW.variables) AS k(key)
               WHERE k.key NOT IN ('userName', 'taskTitle', 'dueAt',
                                   'taskReference')
            )) THEN
      RAISE EXCEPTION 'awcms_email: EMAIL_WORKER_VARIABLE_NOT_ALLOWED'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;
