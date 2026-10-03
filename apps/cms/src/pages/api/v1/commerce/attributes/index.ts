import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  AttributeDefinitionLimitError,
  createAttributeDefinition,
  DuplicateAttributeKeyError,
  listAttributeDefinitions
} from "../../../../../modules/commerce/application/attribute-definition-directory";
import {
  validateCreateAttributeDefinition,
  type AttributeDefinitionInput
} from "../../../../../modules/commerce/domain/attribute-definition";
import { COMMERCE_ATTRIBUTES_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  action: "read"
} as const;
const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  action: "manage"
} as const;

/**
 * `GET /api/v1/commerce/attributes` (Issue #291) — every live attribute
 * definition of the tenant, `sort_order` then `key`. Not paginated: a tenant is
 * capped at 100 definitions, so the whole schema is one bounded response.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const items = await listAttributeDefinitions(tx, tenantId);
    return ok({ items });
  }
});

/** `POST /api/v1/commerce/attributes` — create a definition. `key` and `valueType` are fixed for life. */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<AttributeDefinitionInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    if (bodyRead.malformed) {
      return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const validation = validateCreateAttributeDefinition(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Attribute definition input is invalid.",
        {},
        validation.errors
      );
    }
    return validation.value;
  },
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    try {
      const definition = await createAttributeDefinition(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      );
      return created(definition);
    } catch (error) {
      // Same reasoning as `products/index.ts`: both errors are raised before
      // anything is written (the limit check precedes the INSERT; the unique
      // violation aborted the statement), so the commit `defineTenantRoute`
      // performs on this normal return carries nothing.
      if (error instanceof DuplicateAttributeKeyError) {
        return fail(409, "ATTRIBUTE_KEY_ALREADY_EXISTS", error.message);
      }
      if (error instanceof AttributeDefinitionLimitError) {
        return fail(409, "ATTRIBUTE_DEFINITION_LIMIT_REACHED", error.message);
      }
      throw error;
    }
  }
});
