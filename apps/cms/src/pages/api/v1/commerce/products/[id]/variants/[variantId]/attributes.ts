import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../../../lib/security/request-body-limit";
import {
  AttributeTargetNotFoundError,
  setAttributesForTarget
} from "../../../../../../../../modules/commerce/application/attribute-value-directory";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/commerce-permissions";

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PutPrepared = { attributes: unknown };

/**
 * `PUT /api/v1/commerce/products/{id}/variants/{variantId}/attributes` — the
 * variant-level twin of `products/{id}/attributes`: same body, same typed
 * validation, restricted to definitions whose `appliesTo` covers variants. The
 * variant must belong to the product named in the path (the composite FK of
 * `sql/960` enforces it again at the database).
 */
export const PUT = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PutPrepared | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    if (bodyRead.malformed) {
      return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }
    const record = bodyRead.value as { attributes?: unknown } | null;
    if (!record || typeof record !== "object" || !("attributes" in record)) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body must be an object with an attributes field."
      );
    }
    return { attributes: record.attributes };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const productId = params.id;
    const variantId = params.variantId;
    if (
      !productId ||
      !variantId ||
      !UUID_PATTERN.test(productId) ||
      !UUID_PATTERN.test(variantId)
    ) {
      return fail(404, "RESOURCE_NOT_FOUND", "Variant not found.");
    }
    try {
      const result = await setAttributesForTarget(
        tx,
        tenantId,
        auth.context.tenantUserId,
        { productId, variantId },
        prepared.attributes,
        locals.correlationId
      );
      if (!result.ok) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "Attribute values are invalid.",
          {},
          result.errors
        );
      }
      return ok({ changedKeys: result.changedKeys });
    } catch (error) {
      if (error instanceof AttributeTargetNotFoundError) {
        return fail(404, "RESOURCE_NOT_FOUND", "Variant not found.");
      }
      throw error;
    }
  }
});
