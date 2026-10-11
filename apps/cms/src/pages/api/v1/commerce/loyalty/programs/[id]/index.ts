import { fail, ok } from "../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../lib/security/request-body-limit";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../../modules/commerce/application/commerce-feature-gate";
import { resolveEligibilityRequest } from "../../../../../../../modules/commerce/application/loyalty-eligibility-http";
import { UUID_PATTERN } from "../../../../../../../modules/commerce/application/loyalty-route-support";
import {
  fetchLoyaltyProgram,
  updateLoyaltyProgram
} from "../../../../../../../modules/commerce/application/loyalty-program-directory";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateLoyaltyProgramPatch,
  type LoyaltyProgramPatch
} from "../../../../../../../modules/commerce/domain/loyalty-validation";

/**
 * `GET|PATCH /api/v1/commerce/loyalty/programs/{id}` (Issue #289). PATCH edits
 * a DRAFT version only — an active or retired version is immutable (a ledger
 * row says "earned under version N"; editing N would falsify it), so a change
 * of rules is a new version.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "read"
} as const;

const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
  action: "manage"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(400, "VALIDATION_ERROR", "id must be a valid uuid.");
    }
    const program = await fetchLoyaltyProgram(tx, tenantId, id);
    if (!program) {
      return fail(404, "RESOURCE_NOT_FOUND", "Loyalty program not found.");
    }
    return ok(program);
  }
});

export const PATCH = defineTenantRoute<LoyaltyProgramPatch>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<LoyaltyProgramPatch | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateLoyaltyProgramPatch(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Loyalty program update is invalid.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: MANAGE_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    locals,
    tokenHash,
    now
  }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(400, "VALIDATION_ERROR", "id must be a valid uuid.");
    }

    // Issue #361: see the create route.
    const eligibility = await resolveEligibilityRequest(
      tx,
      tenantId,
      tokenHash,
      now,
      prepared
    );
    if (eligibility.kind === "refused") return eligibility.response;
    const patch = { ...prepared };
    if (eligibility.reference === undefined) {
      delete patch.eligibilitySegmentId;
      delete patch.eligibilitySegmentVersion;
    } else {
      patch.eligibilitySegmentId = eligibility.reference?.segmentId ?? null;
      patch.eligibilitySegmentVersion = eligibility.reference?.version ?? null;
    }

    const result = await updateLoyaltyProgram(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      patch,
      locals.correlationId
    );
    if (result.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Loyalty program not found.");
    }
    if (result.kind === "not_draft") {
      return fail(
        409,
        "PROGRAM_NOT_EDITABLE",
        "Only a draft program version can be edited; create a new version instead."
      );
    }
    return ok(result.program);
  }
});
