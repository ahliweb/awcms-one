import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  composedCrmLeadPort,
  crmLeadsMutationRefusal
} from "../../../../../../lib/composition/crm-lead-port";
import { reverseCrmLeadLink } from "../../../../../../modules/commerce/application/crm-lead-link-directory";
import {
  authorizeCrmConversion,
  reverseRefusalResponse
} from "../../../../../../modules/commerce/application/crm-lead-link-http";
import { isCrmLeadLinkUuid } from "../../../../../../modules/commerce/domain/crm-lead-link";

/**
 * `POST /api/v1/commerce/crm-lead-links/{id}/reverse` (Issue #463, ADR-0056) -
 * applies the reversal of a confirmed lead-to-customer link: `crm_leads`' own
 * conversion is reversed through the port (a stamped reversal and a new stage
 * transition, never an edit of history) and the link becomes `reversed`, which is
 * final. Gated on `commerce.crm_lead_links.approve` (high-risk) AND
 * `crm_leads.conversions.approve`. Meant for a link a consumer flagged
 * `reversal_pending` (the evidence order was cancelled or fully refunded), but a
 * person may also reverse a `linked` one (cause `manual`). Reversing a reversed
 * link is `409`.
 */
const CRM_LEAD_LINK_REVERSE_GUARD = {
  moduleKey: "commerce",
  activityCode: "crm_lead_links",
  action: "approve"
} as const;

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: CRM_LEAD_LINK_REVERSE_GUARD,
  handler: async (context) => {
    const { tx, tenantId, auth, params, locals } = context;
    if (!isCrmLeadLinkUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Link not found.");
    }

    const second = await authorizeCrmConversion(tx, context);
    if (!second.allowed) return second.denied;

    // The deployment flag, the machine-credential refusal and the tenant switch
    // of `crm_leads`, as its own conversion route answers them.
    const off = await crmLeadsMutationRefusal(tx, tenantId, auth);
    if (off) return off;

    const outcome = await reverseCrmLeadLink(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id.toLowerCase(),
      await composedCrmLeadPort(),
      locals.correlationId
    );
    const refusal = reverseRefusalResponse(outcome);
    if (refusal) return refusal;
    return outcome.kind === "reversed"
      ? ok(outcome.link)
      : fail(500, "INTERNAL_ERROR", "Unexpected outcome.");
  }
});
