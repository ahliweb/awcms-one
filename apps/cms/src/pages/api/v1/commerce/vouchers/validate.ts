import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import { validateVoucherCode } from "../../../../../modules/commerce/application/voucher-directory";
import { COMMERCE_VOUCHERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
  action: "read"
} as const;

const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

type ValidatePrepared = {
  code: string;
  subtotal: string;
  shippingCost: string;
};

/**
 * `POST /api/v1/commerce/vouchers/validate` — pure, non-mutating check
 * (contract: `commerce-public-read-models.md`). `code` is a plain lookup key
 * (never a permission target itself), so this stays gated on `vouchers.read`
 * — reading whether a code works is a read, not a mutation (Issue #29's
 * checkout redemption is what actually consumes a voucher).
 */
export const POST = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<ValidatePrepared | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const body = (bodyRead.value ?? {}) as Record<string, unknown>;
    const errors: { field: string; message: string }[] = [];

    if (typeof body.code !== "string" || !CODE_PATTERN.test(body.code)) {
      errors.push({
        field: "code",
        message:
          "code is required and must be 1-40 characters of A-Z, a-z, 0-9, - or _."
      });
    }
    if (
      typeof body.subtotal !== "string" ||
      !PRICE_PATTERN.test(body.subtotal)
    ) {
      errors.push({
        field: "subtotal",
        message:
          "subtotal is required and must be a non-negative decimal string with at most 2 fractional digits."
      });
    }
    let shippingCost = "0.00";
    if (body.shippingCost !== undefined) {
      if (
        typeof body.shippingCost !== "string" ||
        !PRICE_PATTERN.test(body.shippingCost)
      ) {
        errors.push({
          field: "shippingCost",
          message:
            "shippingCost must be a non-negative decimal string with at most 2 fractional digits."
        });
      } else {
        shippingCost = body.shippingCost;
      }
    }

    if (errors.length > 0) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Voucher validation input is invalid.",
        {},
        errors
      );
    }

    return {
      code: body.code as string,
      subtotal: body.subtotal as string,
      shippingCost
    };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared, now }) => {
    const outcome = await validateVoucherCode(
      tx,
      tenantId,
      prepared.code,
      prepared.subtotal,
      prepared.shippingCost,
      now
    );

    if (!outcome.valid) {
      return ok({
        valid: false,
        voucher: null,
        discount: "0.00",
        freeShipping: false,
        reason: outcome.reason
      });
    }

    return ok({
      valid: true,
      voucher: outcome.voucher,
      discount: outcome.discount,
      freeShipping: outcome.freeShipping,
      reason: null
    });
  }
});
