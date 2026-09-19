import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import {
  createCampaign,
  listCampaigns
} from "../../../../../modules/commerce/application/campaign-directory";
import {
  validateCreateCampaignInput,
  type CreateCampaignInput
} from "../../../../../modules/commerce/domain/campaign-validation";
import { COMMERCE_CAMPAIGNS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/** `GET /api/v1/commerce/campaigns?cursor=` — staff list, newest-created first (Issue #114, contract #106 D9). */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "read"
} as const;

type ListPrepared = { cursor: KeysetCursor | null };

export const GET = defineTenantRoute<ListPrepared>({
  workClass: "interactive",
  prepare: ({ url }): ListPrepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      cursor = decodeKeysetCursor(cursorParam);
      if (!cursor) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }
    return { cursor };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok(await listCampaigns(tx, tenantId, prepared.cursor))
});

/** `POST /api/v1/commerce/campaigns` — creates a `draft` campaign. */
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  action: "update"
} as const;

export const POST = defineTenantRoute<CreateCampaignInput>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<CreateCampaignInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateCampaignInput(bodyRead.value);
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
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const campaign = await createCampaign(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    return created(campaign);
  }
});
