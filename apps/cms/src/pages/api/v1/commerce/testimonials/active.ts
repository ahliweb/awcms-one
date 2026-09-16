import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import { listActiveTestimonialsPublic } from "../../../../../modules/commerce/application/testimonial-directory";
import { COMMERCE_TESTIMONIALS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
  action: "read"
} as const;

/** `GET /api/v1/commerce/testimonials/active` — the storefront's testimonial wall. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) =>
    ok(
      await listActiveTestimonialsPublic(tx, tenantId, mediaLibraryPortAdapter)
    )
});
