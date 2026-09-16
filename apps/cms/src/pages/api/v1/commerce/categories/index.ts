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
  createCategory,
  DuplicateCategorySlugError,
  listCategories,
  ParentCategoryNotFoundError,
  type CategoryListFilters
} from "../../../../../modules/commerce/application/category-directory";
import {
  validateCreateCategoryInput,
  type CreateCategoryInput
} from "../../../../../modules/commerce/domain/category-validation";
import { COMMERCE_CATEGORIES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "read"
} as const;
const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
  action: "create"
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ListPrepared = {
  cursor: KeysetCursor | null;
  filters: CategoryListFilters;
};

/**
 * `GET /api/v1/commerce/categories` — keyset-paginated, newest first, limit
 * 100; each row carries a computed `productCount` (Issue #23). `?parentId=`
 * filters to a category's direct children.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  // A malformed cursor is rejected rather than treated as "no cursor": silently
  // serving page 1 for a corrupt cursor is how paging bugs hide.
  prepare: ({ url }): ListPrepared | Response => {
    const cursorParam = url.searchParams.get("cursor");
    let cursor: KeysetCursor | null = null;
    if (cursorParam) {
      const decoded = decodeKeysetCursor(cursorParam);
      if (!decoded)
        return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
      cursor = decoded;
    }

    const parentIdParam = url.searchParams.get("parentId");
    if (parentIdParam !== null && !UUID_PATTERN.test(parentIdParam)) {
      return fail(400, "VALIDATION_ERROR", "parentId must be a valid UUID.");
    }

    return { cursor, filters: { parentId: parentIdParam ?? undefined } };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const page = await listCategories(
      tx,
      tenantId,
      prepared.cursor,
      prepared.filters
    );
    return ok({ items: page.items, nextCursor: page.nextCursor });
  }
});

/** `POST /api/v1/commerce/categories` — create a category. */
export const POST = defineTenantRoute({
  workClass: "interactive",
  // Body parsing belongs in `prepare`: `await request.json()` waits on the
  // CLIENT, so reading it inside the transaction would hold a reserved pool
  // connection for as long as the caller chooses to take.
  prepare: async ({ request }): Promise<CreateCategoryInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateCreateCategoryInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Category creation input is invalid.",
        {},
        validation.errors
      );
    }

    return validation.value;
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const category = await createCategory(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(category);
    } catch (error) {
      // Both branches are caught INSIDE the transaction: neither error is a
      // `Bun.SQL.PostgresError`, and each is safe to turn into a 4xx here only
      // because of what has NOT been written — `ParentCategoryNotFoundError`
      // precedes the INSERT, and `DuplicateCategorySlugError` follows a unique
      // violation that already aborted the transaction, so the commit
      // `defineTenantRoute` performs on this normal return degrades to a
      // rollback.
      if (error instanceof ParentCategoryNotFoundError) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Category creation input is invalid.",
          {},
          [{ field: "parentId", message: error.message }]
        );
      }

      if (error instanceof DuplicateCategorySlugError) {
        return fail(409, "CATEGORY_SLUG_ALREADY_EXISTS", error.message);
      }

      throw error;
    }
  }
});
