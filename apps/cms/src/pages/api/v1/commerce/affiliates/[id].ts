import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  patchAffiliate,
  type PatchAffiliateInput
} from "../../../../../modules/commerce/application/affiliate-directory";
import { validateCommissionRateInput } from "../../../../../modules/commerce/domain/affiliate-commission";
import { COMMERCE_AFFILIATES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `PATCH /api/v1/commerce/affiliates/{id}` — staff edit of status/commission rate (Issue #92). */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_AFFILIATES_ACTIVITY_CODE,
  action: "update"
} as const;

export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PatchAffiliateInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};

    const input: PatchAffiliateInput = {};

    if (record.status !== undefined) {
      if (record.status !== "active" && record.status !== "suspended") {
        return fail(
          400,
          "VALIDATION_ERROR",
          "status must be one of: active, suspended."
        );
      }
      input.status = record.status;
    }

    if (record.commissionRate !== undefined) {
      const rateValidation = validateCommissionRateInput(record.commissionRate);
      if (!rateValidation.valid || rateValidation.value === null) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "commissionRate must be a decimal between 0 and 100.",
          {},
          rateValidation.valid ? undefined : rateValidation.errors
        );
      }
      input.commissionRate = rateValidation.value;
    }

    return input;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const affiliateId = params.id;
    if (!affiliateId) {
      return fail(400, "VALIDATION_ERROR", "id is required.");
    }

    const updated = await patchAffiliate(
      tx,
      tenantId,
      auth.context.tenantUserId,
      affiliateId,
      prepared,
      locals.correlationId
    );
    if (!updated) {
      return fail(404, "RESOURCE_NOT_FOUND", "Affiliate not found.");
    }
    return ok(updated);
  }
});
