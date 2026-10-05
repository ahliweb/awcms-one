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
import { mediaLibraryPortAdapter } from "../../../../../modules/media-library/application/media-library-port-adapter";
import {
  attachProductRelations,
  createProduct,
  DuplicateProductSkuError,
  DuplicateProductSlugError,
  listProducts,
  ProductCategoryNotFoundError,
  type ProductListFilters
} from "../../../../../modules/commerce/application/product-directory";
import {
  validateCreateProductInput,
  type CreateProductInput
} from "../../../../../modules/commerce/domain/product-validation";
import { attachPublicAttributes } from "../../../../../modules/commerce/application/attribute-value-directory";
import { resolveAttributeFilterRequest } from "../../../../../modules/commerce/application/attribute-filter-sql";
import { parseAttributeFilterParams } from "../../../../../modules/commerce/domain/attribute-filter";
import { isProductStatus } from "../../../../../modules/commerce/domain/product-status";
import { isProductSort } from "../../../../../modules/commerce/domain/product-sort";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";
import { inventoryErrorResponse } from "../../../../../modules/commerce/application/commerce-inventory-http";

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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LENGTH = 200;

function parseBooleanParam(
  value: string | null
): boolean | undefined | "invalid" {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return "invalid";
}

type ListPrepared = {
  cursor: KeysetCursor | null;
  filters: ProductListFilters;
  /** Raw `attr=<key>:<op>:<value>` params — shape-checked here, resolved against the tenant's definitions in the handler. */
  attributeParams: string[];
};

/**
 * `GET /api/v1/commerce/products` — keyset-paginated, newest first, limit 100
 * (Issue #4), now filterable by `?categoryId=&status=&q=&sort=&featured=&
 * recommended=` (Issue #23). Every filter value is validated; an unknown
 * value is a 400, never silently ignored (same rule the cursor already
 * followed). `cursor` is only meaningful for the DEFAULT `sort=newest` — see
 * `domain/product-sort.ts`'s header — so the two together are rejected.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  prepare: ({ url }): ListPrepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const sortParam = url.searchParams.get("sort");
    if (sortParam !== null && !isProductSort(sortParam)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        'sort must be one of: "newest", "price_asc", "price_desc", "name".'
      );
    }
    const sort = sortParam ?? "newest";

    if (cursor && sort !== "newest") {
      return fail(
        400,
        "VALIDATION_ERROR",
        "cursor is only supported with the default sort=newest; other sort values return a single page."
      );
    }

    const categoryIdParam = url.searchParams.get("categoryId");
    if (categoryIdParam !== null && !UUID_PATTERN.test(categoryIdParam)) {
      return fail(400, "VALIDATION_ERROR", "categoryId must be a valid UUID.");
    }

    const statusParam = url.searchParams.get("status");
    if (statusParam !== null && !isProductStatus(statusParam)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "status must be one of: draft, active, inactive, archived."
      );
    }

    const featuredParam = parseBooleanParam(url.searchParams.get("featured"));
    if (featuredParam === "invalid") {
      return fail(
        400,
        "VALIDATION_ERROR",
        'featured must be "true" or "false".'
      );
    }

    const recommendedParam = parseBooleanParam(
      url.searchParams.get("recommended")
    );
    if (recommendedParam === "invalid") {
      return fail(
        400,
        "VALIDATION_ERROR",
        'recommended must be "true" or "false".'
      );
    }

    const qParam = url.searchParams.get("q");
    if (qParam !== null && qParam.length > MAX_QUERY_LENGTH) {
      return fail(
        400,
        "VALIDATION_ERROR",
        `q must be at most ${MAX_QUERY_LENGTH} characters.`
      );
    }

    // Issue #291 — `attr=<key>:<operator>:<value>`, repeatable. The shape is
    // checked here (closed operator set, slug key, bounded count/length); the
    // key is resolved against the tenant's definitions inside the handler.
    const attributeParams = url.searchParams.getAll("attr");
    const attributeShape = parseAttributeFilterParams(attributeParams);
    if (!attributeShape.valid) {
      return fail(400, "VALIDATION_ERROR", attributeShape.message);
    }

    return {
      cursor,
      attributeParams,
      filters: {
        categoryId: categoryIdParam ?? undefined,
        status: statusParam ?? undefined,
        q: qParam ?? undefined,
        sort,
        featured: featuredParam,
        recommended: recommendedParam
      }
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    // This API is the catalog read model a storefront consumes with a machine
    // credential, so it always speaks to the PUBLIC audience: only
    // `filterable && visible_public` attributes may be filtered on and only
    // `visible_public` values are returned (Issue #291).
    const attributeFilters = await resolveAttributeFilterRequest(
      tx,
      tenantId,
      prepared.attributeParams,
      "public"
    );
    if (!attributeFilters.valid) {
      return fail(400, "VALIDATION_ERROR", attributeFilters.message);
    }

    const page = await listProducts(tx, tenantId, prepared.cursor, {
      ...prepared.filters,
      attributeFilters: attributeFilters.filters,
      attributeAudience: "public"
    });
    const withRelations = await attachProductRelations(
      tx,
      tenantId,
      mediaLibraryPortAdapter,
      page.items
    );
    const items = await attachPublicAttributes(tx, tenantId, withRelations);
    return ok({ items, nextCursor: page.nextCursor });
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
      // All branches are caught INSIDE the transaction: none of these is a
      // `Bun.SQL.PostgresError`, and each is safe to turn into a 4xx here
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

      const inventoryFailure = inventoryErrorResponse(error);
      if (inventoryFailure) return inventoryFailure;
      throw error;
    }
  }
});
