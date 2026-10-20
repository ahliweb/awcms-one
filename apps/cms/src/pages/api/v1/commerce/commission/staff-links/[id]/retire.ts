import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import { retireStaffLink } from "../../../../../../../modules/commerce/application/commission-attribution-directory";
import { COMMERCE_COMMISSION_STAFF_LINKS_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import { isCommissionUuid } from "../../../../../../../modules/commerce/domain/commission-attribution";

/**
 * `POST /api/v1/commerce/commission/staff-links/{id}/retire` (Issue #391,
 * ADR-0046) - ends a staff link: sales paid afterwards are no longer attributed
 * to that employment. A link is retired, never deleted (the row stays as the
 * record of who was entitled to commission at the time), and a retired link is
 * final - correcting a mistake is a new link. Gated on
 * `commerce.commission_staff_links.manage` (high-risk, audited). Retiring a
 * link that is already retired is `409`, so a retry can never be mistaken for
 * a second effect. A sale already reported keeps the accrual it produced.
 */
const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_COMMISSION_STAFF_LINKS_ACTIVITY_CODE,
  action: "manage"
} as const;

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    if (!isCommissionUuid(params.id)) {
      return fail(
        404,
        "RESOURCE_NOT_FOUND",
        "Commission staff link not found."
      );
    }
    const outcome = await retireStaffLink(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      locals.correlationId
    );
    switch (outcome.kind) {
      case "retired":
        return ok(outcome.link);
      case "not_found":
        return fail(
          404,
          "RESOURCE_NOT_FOUND",
          "Commission staff link not found."
        );
      case "already_retired":
        return fail(
          409,
          "COMMISSION_LINK_ALREADY_RETIRED",
          "This commission staff link is already retired."
        );
    }
  }
});
