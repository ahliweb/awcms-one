import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  fetchCustomerById,
  updateCustomer,
  type UpdateCustomerInput
} from "../../../../../modules/commerce/application/customer-directory";
import { COMMERCE_CUSTOMERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  action: "update"
} as const;

/** `GET /api/v1/commerce/customers/{id}` — admin detail (Issue #29). */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const customerId = params.id;
    if (!customerId) return fail(400, "VALIDATION_ERROR", "id is required.");
    const customer = await fetchCustomerById(tx, tenantId, customerId);
    if (!customer)
      return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
    return ok(customer);
  }
});

/** `PATCH /api/v1/commerce/customers/{id}` — level/status only (Issue #29). */
export const PATCH = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<UpdateCustomerInput | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};

    const input: UpdateCustomerInput = {};
    if (record.level !== undefined) {
      if (
        typeof record.level !== "number" ||
        !Number.isInteger(record.level) ||
        record.level < 1 ||
        record.level > 4
      ) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "level must be an integer between 1 and 4."
        );
      }
      input.level = record.level;
    }
    if (record.status !== undefined) {
      if (record.status !== "active" && record.status !== "blocked") {
        return fail(
          400,
          "VALIDATION_ERROR",
          'status must be "active" or "blocked".'
        );
      }
      input.status = record.status;
    }
    return input;
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared }) => {
    const customerId = params.id;
    if (!customerId) return fail(400, "VALIDATION_ERROR", "id is required.");

    const updated = await updateCustomer(
      tx,
      tenantId,
      auth.context.tenantUserId,
      customerId,
      prepared
    );
    if (!updated) return fail(404, "RESOURCE_NOT_FOUND", "Customer not found.");
    return ok(updated);
  }
});
