import {
  fail,
  jsonResponse
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../../../../../modules/_shared/idempotency";
import { cancelCampaign } from "../../../../../../modules/commerce/application/campaign-directory";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";

const IDEMPOTENCY_SCOPE = "commerce_campaign_cancel";

const SEND_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "send"
} as const;

type Prepared = { idempotencyKey: string };

/**
 * `POST /api/v1/commerce/campaigns/{id}/cancel` (Issue #114, contract #106
 * D9) — stops further dispatch pages (`application/campaign-dispatch.ts`'s
 * loop re-checks `status` before every page); already-enqueued recipient
 * rows are not un-sent. Same idempotency discipline as `send.ts`.
 */
export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: ({ request }): Prepared | Response => {
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      return fail(
        400,
        "IDEMPOTENCY_REQUIRED",
        "Idempotency-Key header is required."
      );
    }
    return { idempotencyKey };
  },
  authorize: SEND_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "campaigns"
    );
    if (gate) return gate;

    const campaignId = params.id;
    if (!campaignId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const requestHash = computeRequestHash({ campaignId, action: "cancel" });

    const existing = await findIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey
    );
    if (existing) {
      if (existing.requestHash !== requestHash) {
        return fail(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Idempotency-Key was already used with a different request."
        );
      }
      return jsonResponse(existing.responseBody, {
        status: existing.responseStatus
      });
    }

    const outcome = await cancelCampaign(
      tx,
      tenantId,
      auth.context.tenantUserId,
      campaignId,
      locals.correlationId
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Campaign not found.");
    }
    if (outcome.kind === "already_final") {
      return fail(
        409,
        "CAMPAIGN_ALREADY_FINAL",
        "Campaign already sent or cancelled."
      );
    }

    const successResponse = jsonResponse(
      { success: true, data: outcome.campaign, meta: {} },
      { status: 200 }
    );
    const successBody = await successResponse.clone().json();
    await saveIdempotencyRecord(
      tx,
      tenantId,
      IDEMPOTENCY_SCOPE,
      prepared.idempotencyKey,
      requestHash,
      200,
      successBody
    );
    return successResponse;
  }
});
