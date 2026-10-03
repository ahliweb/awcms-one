/**
 * `GET|POST /api/v1/commerce/registers` — POS register definitions (Issue
 * #284, epic #281, ADR-0028). `GET` (`commerce.registers.read`) lists the
 * tenant's registers with each one's live (open/closing) session; `POST`
 * (`commerce.registers.create`) defines a register (`code` unique per tenant,
 * case-insensitively). Both are gated on the tenant's `register` feature
 * (`409 FEATURE_DISABLED` while it is off).
 */
import { created, fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  createRegister,
  listRegisters
} from "../../../../../modules/commerce/application/register-directory";
import {
  readValidatedBody,
  requireRegisterFeature
} from "../../../../../modules/commerce/application/register-http";
import {
  validateCreateRegisterInput,
  type CreateRegisterInput
} from "../../../../../modules/commerce/domain/register";
import { COMMERCE_REGISTERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
  action: "create"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, url }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    const includeInactive = url.searchParams.get("includeInactive") !== "false";
    return ok({
      items: await listRegisters(tx, tenantId, { includeInactive })
    });
  }
});

export const POST = defineTenantRoute<CreateRegisterInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCreateRegisterInput),
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireRegisterFeature(tx, tenantId);
    if (gate) return gate;
    const outcome = await createRegister(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "code_taken") {
      return fail(
        409,
        "REGISTER_CODE_TAKEN",
        "A register with this code already exists."
      );
    }
    return created(outcome.register);
  }
});
