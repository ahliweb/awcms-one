import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import {
  fetchCampaign,
  updateCampaign
} from "../../../../../../modules/commerce/application/campaign-directory";
import {
  validateUpdateCampaignInput,
  type UpdateCampaignInput
} from "../../../../../../modules/commerce/domain/campaign-validation";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import { attachSegmentToDraft } from "../../../../../../modules/commerce/application/campaign-segment-http";
import { fetchCampaignSegmentState } from "../../../../../../modules/commerce/application/campaign-segment-audience";

/** `GET /api/v1/commerce/campaigns/{id}` (Issue #114, contract #106 D9). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "read"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "campaigns"
    );
    if (gate) return gate;

    const campaignId = params.id;
    if (!campaignId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const campaign = await fetchCampaign(tx, tenantId, campaignId);
    if (!campaign)
      return fail(404, "RESOURCE_NOT_FOUND", "Campaign not found.");
    return ok(campaign);
  }
});

/** `PATCH /api/v1/commerce/campaigns/{id}` — editable only while `draft`. */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "update"
} as const;

export const PATCH = defineTenantRoute<UpdateCampaignInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateCampaignInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateUpdateCampaignInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Invalid campaign.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: UPDATE_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    params,
    prepared,
    locals,
    now,
    tokenHash
  }) => {
    const gate = await requireCommerceFeatureForOwnerRoute(
      tx,
      tenantId,
      "campaigns"
    );
    if (gate) return gate;

    const campaignId = params.id;
    if (!campaignId) return fail(400, "VALIDATION_ERROR", "id is required.");

    // Issue #362. `undefined` = the body did not mention a segment (the legacy
    // PATCH, unchanged); `null` = detach; a pin = (re)attach.
    let segmentPin: { segmentId: string; version: number } | null | undefined;
    if (prepared.segment === null) {
      const state = await fetchCampaignSegmentState(tx, tenantId, campaignId);
      if (state?.pin && prepared.audience === undefined) {
        // Dropping the segment without saying who the campaign is for would
        // silently widen it to every consented account.
        return fail(400, "VALIDATION_ERROR", "Invalid campaign.", {}, [
          {
            field: "audience",
            message:
              "Send the audience filters the campaign should use when detaching its segment."
          }
        ]);
      }
      segmentPin = null;
    } else if (prepared.segment) {
      const attached = await attachSegmentToDraft(
        tx,
        tenantId,
        tokenHash,
        now,
        prepared.segment
      );
      if (attached.kind === "refused") return attached.response;
      segmentPin = attached.pin;
    } else if (prepared.audience !== undefined) {
      const state = await fetchCampaignSegmentState(tx, tenantId, campaignId);
      const filters = prepared.audience;
      if (
        state?.pin &&
        (filters.levels.length > 0 ||
          filters.hasAccount !== null ||
          filters.lastOrderSince !== null)
      ) {
        return fail(400, "VALIDATION_ERROR", "Invalid campaign.", {}, [
          {
            field: "audience",
            message:
              "This campaign uses a segment as its whole audience: detach the segment (segmentId: null) before setting audience filters."
          }
        ]);
      }
    }

    const outcome = await updateCampaign(
      tx,
      tenantId,
      auth.context.tenantUserId,
      campaignId,
      prepared,
      locals.correlationId,
      segmentPin
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Campaign not found.");
    }
    if (outcome.kind === "not_editable") {
      return fail(
        409,
        "CAMPAIGN_NOT_EDITABLE",
        "Only a draft campaign may be edited."
      );
    }
    return ok(outcome.campaign);
  }
});
