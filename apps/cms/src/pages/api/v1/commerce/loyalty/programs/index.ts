import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  createLoyaltyProgram,
  listLoyaltyPrograms
} from "../../../../../../modules/commerce/application/loyalty-program-directory";
import { COMMERCE_LOYALTY_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateCreateLoyaltyProgram,
  type LoyaltyProgramInput
} from "../../../../../../modules/commerce/domain/loyalty-validation";

/**
 * `GET|POST /api/v1/commerce/loyalty/programs` (Issue #289) — list every rule
 * version (newest first) / create a new DRAFT version. Both are gated by the
 * tenant's `loyalty` feature flag (`409 FEATURE_DISABLED` when off).
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
  handler: async ({ tx, tenantId }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return ok({ items: await listLoyaltyPrograms(tx, tenantId) });
  }
});

export const POST = defineTenantRoute<LoyaltyProgramInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<LoyaltyProgramInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateLoyaltyProgram(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Loyalty program input is invalid.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "loyalty"
    );
    if (gate) return gate;

    return created(
      await createLoyaltyProgram(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      )
    );
  }
});
