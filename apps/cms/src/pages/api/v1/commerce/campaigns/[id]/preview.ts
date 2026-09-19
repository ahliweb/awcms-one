import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  countCampaignAudience,
  fetchCampaign
} from "../../../../../../modules/commerce/application/campaign-directory";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import { requireCommerceFeatureForOwnerRoute } from "../../../../../../modules/commerce/application/commerce-feature-gate";

/**
 * `POST /api/v1/commerce/campaigns/{id}/preview` (Issue #114, contract #106
 * D9) — resolves the campaign's OWN saved audience into a recipient COUNT
 * only, never a resolved list (`awcms-sensitive-data`'s anti-enumeration
 * posture). Gated on `read`, not `update`/`send` — previewing changes
 * nothing.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "read"
} as const;

export const POST = defineTenantRoute({
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

    const recipientCount = await countCampaignAudience(
      tx,
      tenantId,
      campaign.channel,
      campaign.audience
    );
    return ok({ recipientCount });
  }
});
