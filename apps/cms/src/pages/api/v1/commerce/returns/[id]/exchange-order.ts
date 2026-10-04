/**
 * `POST /api/v1/commerce/returns/{id}/exchange-order` - link the replacement
 * order of an exchange to its return, once (Issue #287, ADR-0033). An
 * exchange is a return plus a SEPARATE new order, created through the normal
 * order / POS path; the original order's lines are never edited. Requires
 * `Idempotency-Key`; `commerce.returns.create` and the `returns` feature.
 */
import { fail } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/register-http";
import { linkExchangeOrder } from "../../../../../../modules/commerce/application/return-directory";
import {
  linkExchangeResponse,
  requireReturnsFeature
} from "../../../../../../modules/commerce/application/return-http";
import { COMMERCE_RETURNS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateLinkExchangeOrderInput,
  type LinkExchangeOrderInput
} from "../../../../../../modules/commerce/domain/returns";
import { isUuid } from "../../../../../../modules/commerce/domain/stored-value";

export const POST = defineTenantRoute<LinkExchangeOrderInput>({
  workClass: "interactive",
  prepare: async ({ request }) => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    return readValidatedBody(request, (body) =>
      validateLinkExchangeOrderInput(body, key.key)
    );
  },
  authorize: {
    moduleKey: "commerce",
    activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
    action: "create"
  },
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireReturnsFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) {
      return fail(404, "RESOURCE_NOT_FOUND", "Return not found.");
    }
    try {
      return linkExchangeResponse(
        await linkExchangeOrder(
          tx,
          tenantId,
          auth.context.tenantUserId,
          params.id,
          prepared.orderId,
          prepared.idempotencyKey,
          locals.correlationId
        )
      );
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
