/**
 * HTTP helpers shared by the CRM lead link routes (Issue #463, ADR-0056): the
 * SECOND authorization the port's contract requires of its composition root, and
 * the mapping of the directory's outcomes to responses.
 *
 * `CrmLeadPort` performs no access check, so a commerce permission alone must
 * never be enough to confirm or reverse a CRM conversion: the route also asks the
 * single access chokepoint for `crm_leads.conversions.approve`
 * (`authorizeInTransaction`: RBAC, ABAC, SoD and the decision log all apply, and
 * ADR-0092 wants the client address passed explicitly by a hand-written call). A
 * denial is the chokepoint's own response.
 */
import { fail } from "../../_shared/api-response";
import { resolveClientIp } from "../../../lib/security/rate-limit";
import { authorizeInTransaction } from "../../identity-access/application/access-guard";
import type {
  LinkLeadOutcome,
  ReverseLinkOutcome
} from "./crm-lead-link-directory";

export const CRM_CONVERSIONS_APPROVE_GUARD = {
  moduleKey: "crm_leads",
  activityCode: "conversions",
  action: "approve"
} as const;

export async function authorizeCrmConversion(
  tx: Bun.SQL,
  context: {
    tenantId: string;
    tokenHash: string;
    now: Date;
    request: Request;
    clientAddress: string | undefined;
  }
): Promise<{ allowed: true } | { allowed: false; denied: Response }> {
  const decision = await authorizeInTransaction(
    tx,
    context.tenantId,
    context.tokenHash,
    context.now,
    CRM_CONVERSIONS_APPROVE_GUARD,
    { clientIp: resolveClientIp(context.request, context.clientAddress) }
  );
  return decision.allowed
    ? { allowed: true }
    : { allowed: false, denied: decision.denied };
}

/** The refusal of a link attempt as a response; `null` for `linked` and `replayed`. */
export function linkRefusalResponse(outcome: LinkLeadOutcome): Response | null {
  switch (outcome.kind) {
    case "linked":
    case "replayed":
      return null;
    case "crm_leads_unavailable":
      return fail(
        409,
        "CRM_LEADS_UNAVAILABLE",
        "The CRM lead module is not enabled for this tenant."
      );
    case "lead_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Lead not found.");
    case "customer_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
    case "order_not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Order not found.");
    case "evidence_not_verified":
      return fail(
        409,
        "CRM_EVIDENCE_NOT_VERIFIED",
        "The commerce evidence does not confirm a conversion.",
        {},
        { reason: outcome.reason }
      );
    case "lead_already_linked":
      return fail(
        409,
        "CRM_LEAD_ALREADY_LINKED",
        "This lead already has a live link to a customer; reverse it first."
      );
    case "evidence_reused":
      return fail(
        409,
        "CRM_EVIDENCE_REUSED",
        "This evidence already confirmed a different conversion."
      );
    case "conversion_refused":
      return fail(
        409,
        "CRM_CONVERSION_REFUSED",
        "The lead cannot be converted in its current state.",
        {},
        { reason: outcome.outcome }
      );
  }
}

export function reverseRefusalResponse(
  outcome: ReverseLinkOutcome
): Response | null {
  switch (outcome.kind) {
    case "reversed":
      return null;
    case "not_found":
      return fail(404, "RESOURCE_NOT_FOUND", "Link not found.");
    case "already_reversed":
      return fail(
        409,
        "CRM_LEAD_LINK_ALREADY_REVERSED",
        "The link is already reversed."
      );
    case "crm_leads_unavailable":
      return fail(
        409,
        "CRM_LEADS_UNAVAILABLE",
        "The CRM lead module is not enabled for this tenant."
      );
    case "conversion_not_found":
      return fail(
        409,
        "CRM_CONVERSION_NOT_FOUND",
        "CRM holds no conversion for this link."
      );
    case "evidence_reused":
      return fail(
        409,
        "CRM_EVIDENCE_REUSED",
        "The reversal evidence reference was already used."
      );
    case "input_invalid":
      return fail(422, "VALIDATION_ERROR", "The reversal request was invalid.");
  }
}
