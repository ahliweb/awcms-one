import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  AttributeAppliesToInUseError,
  AttributeOptionInUseError,
  deleteAttributeDefinition,
  fetchAttributeDefinitionById,
  updateAttributeDefinition
} from "../../../../../modules/commerce/application/attribute-definition-directory";
import { validateUpdateAttributeDefinition } from "../../../../../modules/commerce/domain/attribute-definition";
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `GET /api/v1/commerce/attributes/{id}` (Issue #291). */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }
    const definition = await fetchAttributeDefinitionById(tx, tenantId, id);
    if (!definition) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }
    return ok(definition);
  }
});

type PatchPrepared = { body: unknown };

/**
 * `PATCH /api/v1/commerce/attributes/{id}` — label/labels/constraints/flags/
 * appliesTo/sortOrder. `key` and `valueType` are rejected (400): a different
 * type or key is a different attribute. Removing an enum option a stored value
 * still uses, or narrowing `appliesTo` under stored values, is a 409.
 */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PatchPrepared | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);
    if (bodyRead.malformed) {
      return fail(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }
    return { body: bodyRead.value };
  },
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }

    // The patch's constraint keys depend on the definition's (immutable) type,
    // so the validation needs the stored definition first.
    const existing = await fetchAttributeDefinitionById(tx, tenantId, id);
    if (!existing) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }

    const validation = validateUpdateAttributeDefinition(
      prepared.body,
      existing.valueType
    );
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Attribute definition input is invalid.",
        {},
        validation.errors
      );
    }

    try {
      const updated = await updateAttributeDefinition(
        tx,
        tenantId,
        auth.context.tenantUserId,
        id,
        validation.value,
        locals.correlationId
      );
      if (!updated) {
        return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
      }
      return ok(updated);
    } catch (error) {
      if (error instanceof AttributeOptionInUseError) {
        return fail(409, "ATTRIBUTE_OPTION_IN_USE", error.message);
      }
      if (error instanceof AttributeAppliesToInUseError) {
        return fail(409, "ATTRIBUTE_APPLIES_TO_IN_USE", error.message);
      }
      throw error;
    }
  }
});

/** `DELETE /api/v1/commerce/attributes/{id}` — soft delete (audited); the key is freed, stored values become unreachable. */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, params, locals }) => {
    const id = params.id;
    if (!id || !UUID_PATTERN.test(id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }
    const deleted = await deleteAttributeDefinition(
      tx,
      tenantId,
      auth.context.tenantUserId,
      id,
      locals.correlationId
    );
    if (!deleted) {
      return fail(404, "RESOURCE_NOT_FOUND", "Attribute not found.");
    }
    return ok({ deleted: true });
  }
});
