/**
 * `GET|POST /api/v1/commerce/booking/cancellation-policies` - the versioned
 * cancellation refund policies (Issue #381, ADR-0045 D6, owner answer Q9; UX
 * flows 11.4).
 *
 * `GET` (`commerce.booking_cancellation_policies.read`) lists the versions of a
 * scope: `?productId=<uuid>` for a product, `?productId=default` for the tenant
 * default, none for every scope; `?status=draft|active|retired` narrows. Active
 * first, then drafts, then the history, newest version first; each carries its
 * windows. `POST` (`commerce.booking_cancellation_policies.create`, requires
 * `Idempotency-Key`) authors a DRAFT version with its windows - a window with
 * more notice must not refund less than one with less notice. A version is
 * immutable once approved: a change is a new version. Both are gated on the
 * tenant's `booking` feature.
 */
import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import {
  createPolicyDraft,
  listPolicies,
  type PolicyScope,
  type PolicyStatus
} from "../../../../../../modules/commerce/application/booking-cancellation-policies";
import { COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validatePolicyDraftInput,
  type PolicyDraftInput
} from "../../../../../../modules/commerce/domain/booking-cancellation";
import { isUuid } from "../../../../../../modules/commerce/domain/register";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = { scope: PolicyScope; status: PolicyStatus | null };

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const productParam = url.searchParams.get("productId");
    let scope: PolicyScope = { kind: "all" };
    if (productParam === "default") scope = { kind: "default" };
    else if (productParam !== null) {
      if (!isUuid(productParam)) {
        return fail(
          400,
          "VALIDATION_ERROR",
          "productId must be a uuid, or default for the tenant default."
        );
      }
      scope = { kind: "product", productId: productParam };
    }
    const statusParam = url.searchParams.get("status");
    if (
      statusParam !== null &&
      statusParam !== "draft" &&
      statusParam !== "active" &&
      statusParam !== "retired"
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "status must be draft, active or retired."
      );
    }
    return { scope, status: statusParam as PolicyStatus | null };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    return ok({
      items: await listPolicies(tx, tenantId, prepared.scope, prepared.status)
    });
  }
});

type PreparedCreate = { input: PolicyDraftInput; idempotencyKey: string };

export const POST = defineTenantRoute<PreparedCreate>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedCreate | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    const input = await readValidatedBody(request, validatePolicyDraftInput);
    if (input instanceof Response) return input;
    return { input, idempotencyKey: key.key };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await createPolicyDraft(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared.input,
        prepared.idempotencyKey,
        locals.correlationId
      );
      if (outcome.kind === "refused") {
        return fail(404, "RESOURCE_NOT_FOUND", "Product not found.");
      }
      return created(outcome.policy);
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError and
      // IdempotencyPayloadMismatchError are raised by application code after
      // statements that succeeded (a replay lookup), so the transaction is
      // healthy.
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
