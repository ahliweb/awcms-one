import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  countCampaignAudience,
  fetchCampaign
} from "../../../../../../modules/commerce/application/campaign-directory";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";
import {
  countCampaignSegmentAudience,
  fetchCampaignSegmentState,
  requireCampaignSegmentAudienceFeature
} from "../../../../../../modules/commerce/application/campaign-segment-audience";
import {
  audienceRefusalResponse,
  requireSegmentPreviewsRead
} from "../../../../../../modules/commerce/application/campaign-segment-http";
import { throttlePreview } from "../../../../../../modules/commerce/application/segment-http";

/**
 * `POST /api/v1/commerce/campaigns/{id}/preview` (Issue #114, contract #106
 * D9) — resolves the campaign's OWN saved audience into a recipient COUNT
 * only, never a resolved list (`awcms-sensitive-data`'s anti-enumeration
 * posture). Gated on `read`, not `update`/`send` — previewing changes
 * nothing.
 *
 * Issue #362 (ADR-0042 Amendment): for a campaign whose audience is a SEGMENT
 * the answer is the segment's members the campaign may message (consent,
 * active account, channel address), bounded like any segment evaluation, with
 * a count under five withheld. It additionally needs
 * `commerce.segment_previews.read` and the segment-audience feature. A campaign
 * using the legacy filters answers exactly as before.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "read"
} as const;

export const POST = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params, auth, now, tokenHash }) => {
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

    const state = await fetchCampaignSegmentState(tx, tenantId, campaignId);
    if (state?.pin) {
      const featureGate = await requireCampaignSegmentAudienceFeature(
        tx,
        tenantId
      );
      if (featureGate) return featureGate;
      const denied = await requireSegmentPreviewsRead(
        tx,
        tenantId,
        tokenHash,
        now
      );
      if (denied) return denied;
      const throttled = throttlePreview(
        tenantId,
        auth.context.tenantUserId,
        now.getTime()
      );
      if (throttled) return throttled;

      const counted = await countCampaignSegmentAudience(
        tx,
        { tenantId, actorTenantUserId: auth.context.tenantUserId, now },
        state.pin,
        campaign.channel
      );
      if (counted.kind !== "ok") {
        return (
          audienceRefusalResponse(counted) ??
          fail(500, "INTERNAL_ERROR", "Segment evaluation failed.")
        );
      }
      return ok({
        recipientCount: counted.count.suppressed ? null : counted.count.count,
        suppressed: counted.count.suppressed,
        ...(counted.count.suppressed ? { label: counted.count.label } : {}),
        segment: {
          id: state.pin.segmentId,
          version: state.pin.version
        },
        asOf: counted.asOf
      });
    }

    const recipientCount = await countCampaignAudience(
      tx,
      tenantId,
      campaign.channel,
      campaign.audience
    );
    return ok({ recipientCount });
  }
});
