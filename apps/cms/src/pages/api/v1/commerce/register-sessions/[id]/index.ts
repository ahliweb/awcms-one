/**
 * `GET /api/v1/commerce/register-sessions/{id}` — one session with its
 * cash-up report (Issue #284, ADR-0028): opening float, sales by tender,
 * movements, expected / counted / variance per tender (live while the session
 * is open, the stored close snapshot afterwards, corrections applied on top
 * with the original lines untouched). Gated on
 * `commerce.register_sessions.read` and the `register` feature. An unknown id
 * and another tenant's id are the same `404`.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { fetchRegisterCashUpReport } from "../../../../../../modules/commerce/application/register-cash-up";
import { requireRegisterFeature } from "../../../../../../modules/commerce/application/register-http";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    }
    const report = await fetchRegisterCashUpReport(tx, tenantId, params.id);
    if (!report) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register session not found.");
    }
    return ok(report);
  }
});
