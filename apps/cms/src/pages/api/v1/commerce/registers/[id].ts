/**
 * `GET|PATCH /api/v1/commerce/registers/{id}` — one POS register (Issue #284,
 * ADR-0028). `GET` is `commerce.registers.read`; `PATCH`
 * (`commerce.registers.update`) renames, relabels or (de)activates it - a
 * register with an open/closing session cannot be deactivated
 * (`409 REGISTER_HAS_ACTIVE_SESSION`). The `code` never changes. An unknown id
 * and another tenant's id are the same `404`.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  fetchRegister,
  updateRegister
} from "../../../../../modules/commerce/application/register-directory";
import {
  readValidatedBody,
  requireRegisterFeature
} from "../../../../../modules/commerce/application/register-http";
import {
  isUuid,
  validateUpdateRegisterInput,
  type UpdateRegisterInput
} from "../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
  action: "update"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
    }
    const register = await fetchRegister(tx, tenantId, params.id);
    if (!register)
      return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
    return ok(register);
  }
});

export const PATCH = defineTenantRoute<UpdateRegisterInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateUpdateRegisterInput),
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
    }
    const outcome = await updateRegister(
      tx,
      tenantId,
      auth.context.tenantUserId,
      params.id,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "not_found") {
      return fail(404, "RESOURCE_NOT_FOUND", "Register not found.");
    }
    if (outcome.kind === "has_active_session") {
      return fail(
        409,
        "REGISTER_HAS_ACTIVE_SESSION",
        "Close the register's open session before deactivating it."
      );
    }
    return ok(outcome.register);
  }
});
