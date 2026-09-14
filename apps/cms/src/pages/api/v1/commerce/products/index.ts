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
  createProduct,
  DuplicateProductSkuError,
  DuplicateProductSlugError,
  listProducts,
  ProductCategoryNotFoundError
} from "../../../../../modules/commerce/application/product-directory";
import {
  validateCreateProductInput,
  type CreateProductInput
} from "../../../../../modules/commerce/domain/product-validation";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "create"
} as const;

/** `GET /api/v1/commerce/products` — keyset-paginated, newest first, limit 100. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  // A malformed cursor is rejected rather than treated as "no cursor": silently
  // serving page 1 for a corrupt cursor is how paging bugs hide.
  prepare: ({ url }): KeysetCursor | null | Response => {
    const cursorParam = url.searchParams.get("cursor");
    if (!cursorParam) return null;

    const cursor = decodeKeysetCursor(cursorParam);
    if (!cursor) return fail(400, "VALIDATION_ERROR", "cursor is malformed.");

    return cursor;
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const page = await listProducts(tx, tenantId, prepared);
    return ok({ items: page.items, nextCursor: page.nextCursor });
  }
});

/** `POST /api/v1/commerce/products` — create a product. Always starts `status: draft`. */
export const POST = defineTenantRoute({
  workClass: "interactive",
  // Body parsing belongs in `prepare`: `await request.json()` waits on the
  // CLIENT, so reading it inside the transaction would hold a reserved pool
  // connection for as long as the caller chooses to take.
  prepare: async ({ request }): Promise<CreateProductInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateProductInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Product creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const product = await createProduct(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(product);
    } catch (error) {
      // All three branches are caught INSIDE the transaction: none of these is
      // a `Bun.SQL.PostgresError`, and each is safe to turn into a 4xx here
      // only because of what has NOT been written — `ProductCategoryNotFoundError`
      // is raised before `createProduct` touches anything, and the two
      // duplicate errors follow a unique violation that already aborted the
      // transaction, so the commit `defineTenantRoute` performs on this normal
      // return degrades to a rollback.
      if (error instanceof ProductCategoryNotFoundError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Product creation input is invalid.",
          {},
          [{ field: "categoryId", message: error.message }]
        );
      }

      if (error instanceof DuplicateProductSlugError) {
        return fail(409, "PRODUCT_SLUG_ALREADY_EXISTS", error.message);
      }

      if (error instanceof DuplicateProductSkuError) {
        return fail(409, "PRODUCT_SKU_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});
