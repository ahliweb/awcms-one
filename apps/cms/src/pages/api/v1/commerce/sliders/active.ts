import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import { listActiveSlidersPublic } from "../../../../../modules/commerce/application/slider-directory";
import { COMMERCE_SLIDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
  action: "read"
} as const;

/** `GET /api/v1/commerce/sliders/active` — the storefront's home-page slider deck. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, now }) =>
    ok(
      await listActiveSlidersPublic(tx, tenantId, mediaLibraryPortAdapter, now)
    )
});
