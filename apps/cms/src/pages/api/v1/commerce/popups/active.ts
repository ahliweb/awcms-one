import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import { fetchActivePopupPublic } from "../../../../../modules/commerce/application/popup-directory";
import { COMMERCE_POPUPS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
  action: "read"
} as const;

/** `GET /api/v1/commerce/popups/active` — `null` when none. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, now }) =>
    ok(await fetchActivePopupPublic(tx, tenantId, mediaLibraryPortAdapter, now))
});
