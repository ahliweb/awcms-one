-- Commerce's worker e-mail category as DATA, and the table-driven guard restored
-- (upstream ADR-0164 / Issue #1277; owner decision 2026-11-18, ahliweb, the
-- awcms-one subtree sync to awcms f476fdbb: "Option A").
--
-- ## What this repairs
--
-- sql/1033 (this repo) replaced `awcms_email_guard_worker_insert` with a
-- hard-coded body that adds `derived.commerce_campaign` to the three
-- `hr.attendance_correction_*` categories. Upstream then made the worker
-- allow-list rows of `awcms_email_worker_categories` (sql/410), after
-- sql/371 had added the three `crm.follow_up_*` categories to the body, and its
-- gate (`bun run extension-points:check`) refuses any later migration that
-- re-issues the function. Two orders exist, and both ended wrong:
--
--   * FRESH database: ... 371, 410 (table-driven), then 1033 (hard-coded,
--     older body) -> the data-driven guard is overwritten, and the
--     `crm.follow_up_*` categories and their recipient and variable checks are
--     gone.
--   * EXISTING database that applied 1033 before 371/410: 371 and 410 apply on
--     top of it -> the guard is table-driven, but `derived.commerce_campaign`
--     is not a row, so `commerce:campaigns:dispatch` fails with
--     EMAIL_WORKER_CATEGORY_NOT_ALLOWED.
--
-- ## What this does
--
-- Re-issues the function with EXACTLY the body of sql/410 (a downstream
-- migration that sorts after 1033, so a fresh database ends table-driven again)
-- and seeds the commerce campaign category as a row. The body is a copy:
-- `tests/commerce-worker-email-guard-order.test.ts` fails when it drifts from
-- sql/410's or when the migration order stops ending table-driven. sql/1033
-- stays byte-identical (an applied migration cannot be edited: checksum).
--
-- Both this file and sql/1033 re-issue the guard on purpose, and are named in
-- `GUARD_REISSUE_EXCEPTIONS` of `scripts/extension-points-check.ts` (a recorded
-- local divergence, root AGENTS.md). No further migration may join them: a new
-- worker category is an INSERT into `awcms_email_worker_categories` with a
-- descriptor `workerInsert: true`, as `commerce` now does.
--
-- Only the campaign category is enqueued from an `awcms_worker` transaction;
-- the other commerce e-mails (customer OTP, conversation reply, document
-- delivery) are written by the request path as `awcms_app`, which the guard
-- never touches. The column-scoped INSERT grant of sql/1033 is unchanged.
--
-- Idempotent: CREATE OR REPLACE and INSERT ... ON CONFLICT DO NOTHING.

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

  IF NOT EXISTS (
       SELECT 1 FROM awcms_email_worker_categories c
        WHERE c.category = NEW.category
     ) THEN
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

INSERT INTO awcms_email_worker_categories (category) VALUES
  ('derived.commerce_campaign')
ON CONFLICT (category) DO NOTHING;

COMMIT;
