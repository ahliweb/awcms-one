import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../../lib/security/request-body-limit";
import { listAttributeDefinitions } from "../../../../../../modules/commerce/application/attribute-definition-directory";
import {
  AttributeTargetNotFoundError,
  loadAttributeSets,
  setAttributesForTarget
} from "../../../../../../modules/commerce/application/attribute-value-directory";
import { fetchProductById } from "../../../../../../modules/commerce/application/product-directory";
import {
  COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  COMMERCE_PRODUCTS_ACTIVITY_CODE
} from "../../../../../../modules/commerce/domain/commerce-permissions";

// Reading the FULL (admin) attribute set — including values flagged
// `visible_public = false` — is gated on `attributes.read`, NOT on
// `products.read`: the storefront's machine credential holds `products.read`
// for the catalog read model, and must not be able to read a back-office-only
// attribute through this route (Issue #291).
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "update"
} as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `GET /api/v1/commerce/products/{id}/attributes` — the product's admin
 * attribute set (every `visible_admin` definition's value, product-level and
 * per-variant) plus the applicable definitions the edit form renders inputs for.
 */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const productId = params.id;
    if (!productId || !UUID_PATTERN.test(productId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
    }
    const product = await fetchProductById(tx, tenantId, productId);
    if (!product) return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");

    const definitions = await listAttributeDefinitions(tx, tenantId, {
      audience: "admin"
    });
    const sets = await loadAttributeSets(tx, tenantId, [productId], "admin");
    const set = sets.get(productId) ?? { product: [], variants: {} };
    return ok({
      definitions,
      product: set.product,
      variants: set.variants
    });
  }
});

type PutPrepared = { attributes: unknown };

/**
 * `PUT /api/v1/commerce/products/{id}/attributes` — body `{ "attributes":
 * { "<key>": <value> | null } }`. A value sets the attribute, `null` clears it,
 * an absent key is untouched. Every value is parsed through the typed grammar
 * (`domain/attribute-value.ts`); ONE invalid entry rejects the whole request
 * (400, nothing written).
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
    if (!productId || !UUID_PATTERN.test(productId)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
    }
    try {
      const result = await setAttributesForTarget(
        tx,
        tenantId,
        auth.context.tenantUserId,
        { productId },
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
        return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
      }
      throw error;
    }
  }
});
