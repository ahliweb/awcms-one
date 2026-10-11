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
import { sendCampaign } from "../../../../../../modules/commerce/application/campaign-directory";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  countCampaignSegmentAudience,
  fetchCampaignSegmentState,
  requireCampaignSegmentAudienceFeature
} from "../../../../../../modules/commerce/application/campaign-segment-audience";
import { audienceRefusalResponse } from "../../../../../../modules/commerce/application/campaign-segment-http";

const IDEMPOTENCY_SCOPE = "commerce_campaign_send";

const SEND_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "send"
} as const;

type Prepared = { idempotencyKey: string };

/**
 * `POST /api/v1/commerce/campaigns/{id}/send` (Issue #114, contract #106
 * D9) — high-risk mutation (it eventually reaches real inboxes/phones via
 * `commerce:campaigns:dispatch`): requires `Idempotency-Key`, hash bound to
 * `campaignId` + the literal `action` string, per `awcms-idempotency`'s
 * "recurring 4x" rule — this is an EMPTY-body endpoint, exactly the shape
 * that bug class targets.
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
  handler: async ({ tx, tenantId, auth, params, prepared, locals, now }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "campaigns"
    );
    if (gate) return gate;

    const campaignId = params.id;
    if (!campaignId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const requestHash = computeRequestHash({ campaignId, action: "send" });

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

    // Issue #362: a segment campaign is checked when it is ENQUEUED, not only
    // when it is dispatched. The feature may have been switched off since the
    // draft was written, and the audience must be evaluable inside the bounds
    // (ADR-0042 D5) - a `busy` / `too expensive` answer surfaces here as the
    // stable 429 / 422 instead of as a campaign that silently never sends.
    // Consent is part of that evaluation; it is checked again, per page, when
    // the dispatcher fans the campaign out. A legacy campaign skips all of it.
    const state = await fetchCampaignSegmentState(tx, tenantId, campaignId);
    if (
      state?.pin &&
      (state.status === "draft" || state.status === "scheduled")
    ) {
      const featureGate = await requireCampaignSegmentAudienceFeature(
        tx,
        tenantId
      );
      if (featureGate) return featureGate;
      const counted = await countCampaignSegmentAudience(
        tx,
        { tenantId, actorTenantUserId: auth.context.tenantUserId, now },
        state.pin,
        state.channel
      );
      if (counted.kind !== "ok") {
        return (
          audienceRefusalResponse(counted) ??
          fail(500, "INTERNAL_ERROR", "Segment evaluation failed.")
        );
      }
    }

    const outcome = await sendCampaign(
      tx,
      tenantId,
      auth.context.tenantUserId,
      campaignId,
      null,
      locals.correlationId
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Campaign not found.");
    }
    if (outcome.kind === "not_sendable") {
      return fail(
        409,
        "CAMPAIGN_NOT_SENDABLE",
        "Only a draft or scheduled campaign may be sent."
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
