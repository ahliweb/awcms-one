import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";
import {
  attachProductRelations,
  fetchProductBySlug
} from "../../../../../../modules/commerce/application/product-directory";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "read"
} as const;

/**
 * `GET /api/v1/commerce/products/by-slug/{slug}` (Issue #23) — the
 * storefront's detail fetch by URL key, since a product page's URL carries
 * the slug, not the id. Same guard and response shape as
 * `GET .../products/{id}`; a slug match is scoped to `deleted_at IS NULL`
 * the same way an id lookup is, so a soft-deleted product's old URL 404s
 * rather than resurrecting stale content.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const slug = params.slug;
    if (!slug) {
      return fail(400, "VALIDATION_ERROR", "Product slug is required.");
    }

    const product = await fetchProductBySlug(tx, tenantId, slug);
    if (!product) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
    }

    const [withRelations] = await attachProductRelations(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      [product]
    );

    return ok(withRelations);
  }
});
