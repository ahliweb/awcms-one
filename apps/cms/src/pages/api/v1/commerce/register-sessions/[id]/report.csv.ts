/**
 * `GET /api/v1/commerce/register-sessions/{id}/report.csv` — the cash-up CSV
 * of one session (Issue #284, ADR-0028): summary, per-tender
 * expected/counted/variance, every movement and every correction.
 * Gated on `commerce.register_sessions.export` - the platform's high-risk
 * `export` verb, because the file leaves the system; a cashier who can open and
 * close a session gets no export from `commerce.pos.create` or from the other
 * register permissions. Every cell is spreadsheet-formula-neutralised
 * (`domain/register-cash-up-csv.ts`). Bounded by construction (one session's
 * rows), so `reporting` work class without pagination.
 */
import { fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { fetchRegisterCashUpReport } from "../../../../../../modules/commerce/application/register-cash-up";
import { requireRegisterFeature } from "../../../../../../modules/commerce/application/register-http";
import { serializeCashUpCsv } from "../../../../../../modules/commerce/domain/register-cash-up-csv";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  action: "export"
} as const;

export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: EXPORT_GUARD,
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
    return new Response(serializeCashUpCsv(report), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="cash-up-${report.register.code.replace(/[^A-Za-z0-9._-]/g, "_")}-${report.session.id.slice(0, 8)}.csv"`,
        "cache-control": "no-store"
      }
    });
  }
});
