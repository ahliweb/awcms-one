-- The worker's read of the module-enablement row becomes COLUMN-only again
-- (the awcms f476fdbb subtree sync; upstream sql/330, L-5 of the #1145 re-audit).
--
-- ## What collided
--
-- Upstream's `sql/330` grants `awcms_worker` SELECT on exactly
-- `awcms_tenant_modules (tenant_id, module_key, enabled)`: the module-enablement
-- flag, never `disable_reason` (free text) or the actor stamps. Its readiness
-- check (`security:readiness`, `checkWorkerSetupRoleGrants`) and its integration
-- test pin that list exactly. This repo's `sql/1031` had already given the
-- worker a TABLE-level `SELECT ON awcms_tenant_modules`, which covers every
-- column, so on a migrated database the worker could read `disable_reason`
-- and the readiness check reported the pinned column grant as not held.
--
-- ## What this does
--
-- Revokes the table-level privilege (which also clears any column-level one on
-- the same role) and grants the three columns again. Nothing in this repo needs
-- more of that row as the worker: the commission consumers read only `enabled`
-- (`resolveModuleEnabled`), and the customer-push dispatcher's module gate now
-- uses the same function (it used `fetchTenantModuleEntry`, which also selected
-- `disable_reason`; that read was never used). `awcms_app` is untouched.
--
-- Idempotent: REVOKE and GRANT are repeatable.

BEGIN;

REVOKE SELECT ON awcms_tenant_modules FROM awcms_worker;
GRANT SELECT (tenant_id, module_key, enabled)
  ON awcms_tenant_modules TO awcms_worker;

COMMIT;
