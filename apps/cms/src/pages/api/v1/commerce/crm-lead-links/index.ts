import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  composedCrmLeadPort,
  crmLeadsMutationRefusal
} from "../../../../../lib/composition/crm-lead-port";
import { readValidatedBody } from "../../../../../modules/commerce/application/register-http";
import {
  linkLeadToCustomer,
  listCrmLeadLinks
} from "../../../../../modules/commerce/application/crm-lead-link-directory";
import {
  authorizeCrmConversion,
  linkRefusalResponse
} from "../../../../../modules/commerce/application/crm-lead-link-http";
import {
  CRM_LEAD_LINK_STATES,
  isCrmLeadLinkUuid,
  validateCreateCrmLeadLinkInput,
  type CreateCrmLeadLinkInput,
  type CrmLeadLinkState
} from "../../../../../modules/commerce/domain/crm-lead-link";

/**
 * `GET|POST /api/v1/commerce/crm-lead-links` (Issue #463, ADR-0056) - which CRM
 * leads were confirmed as commerce customers.
 *
 * `GET` (`commerce.crm_lead_links.read`) lists the tenant's links, newest first,
 * optionally filtered by `leadId`, `customerId` or `state`; it returns opaque ids,
 * the evidence kind and the state, never a name or contact. `POST`
 * (`commerce.crm_lead_links.create` AND `crm_leads.conversions.approve`, audited
 * at warning) confirms that a lead became a customer, on a commerce fact the
 * SERVER verifies (a confirmed registration or a paid order of that customer).
 * Nothing is matched on a phone, e-mail or handle: the person names both ids.
 * A replay with the same evidence answers `200` with the existing link and
 * publishes nothing.
 */
const CRM_LEAD_LINKS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: "crm_lead_links",
  action: "read"
} as const;

const CRM_LEAD_LINKS_CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: "crm_lead_links",
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: CRM_LEAD_LINKS_READ_GUARD,
  prepare: ({ url }) => {
    const leadId = url.searchParams.get("leadId");
    const customerId = url.searchParams.get("customerId");
    const state = url.searchParams.get("state");
    if (leadId !== null && !isCrmLeadLinkUuid(leadId)) {
      return fail(400, "VALIDATION_ERROR", "leadId must be a UUID.");
    }
    if (customerId !== null && !isCrmLeadLinkUuid(customerId)) {
      return fail(400, "VALIDATION_ERROR", "customerId must be a UUID.");
    }
    if (
      state !== null &&
      !(CRM_LEAD_LINK_STATES as readonly string[]).includes(state)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `state must be ${CRM_LEAD_LINK_STATES.join(", ")}.`
      );
    }
    return {
      ...(leadId ? { leadId: leadId.toLowerCase() } : {}),
      ...(customerId ? { customerId: customerId.toLowerCase() } : {}),
      ...(state ? { state: state as CrmLeadLinkState } : {})
    };
  },
  handler: async ({ tx, tenantId, prepared }) =>
    ok({ items: await listCrmLeadLinks(tx, tenantId, prepared) })
});

export const POST = defineTenantRoute<CreateCrmLeadLinkInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCreateCrmLeadLinkInput),
  authorize: CRM_LEAD_LINKS_CREATE_GUARD,
  handler: async (context) => {
    const { tx, tenantId, auth, prepared, locals } = context;

    // `CrmLeadPort` checks nothing: the route asks the same chokepoint for the
    // CRM permission too, so a commerce key alone never confirms a conversion.
    const second = await authorizeCrmConversion(tx, context);
    if (!second.allowed) return second.denied;

    // The deployment flag, the machine-credential refusal and the tenant switch
    // of `crm_leads`, as its own conversion route answers them.
    const off = await crmLeadsMutationRefusal(tx, tenantId, auth);
    if (off) return off;

    const outcome = await linkLeadToCustomer(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      await composedCrmLeadPort(),
      locals.correlationId
    );
    const refusal = linkRefusalResponse(outcome);
    if (refusal) return refusal;
    if (outcome.kind === "replayed")
      return ok({ ...outcome.link, replayed: true });
    if (outcome.kind === "linked")
      return created({ ...outcome.link, replayed: false });
    return fail(500, "INTERNAL_ERROR", "Unexpected outcome.");
  }
});
