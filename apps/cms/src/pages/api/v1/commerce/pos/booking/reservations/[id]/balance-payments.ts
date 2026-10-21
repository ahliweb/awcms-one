/**
 * `POST /api/v1/commerce/pos/booking/reservations/{id}/balance-payments` - take
 * the outstanding balance of a booking reservation's order at the till (Issue
 * #383, ADR-0045 D19; threat controls C-35 and C-36). `id` is BOOKING's
 * reservation id.
 *
 * Its own permission, `commerce.booking_balance_payments.create`: checking in and
 * out are other keys. The register named in the body must have an OPEN session
 * whose current cashier is the caller (ADR-0028); the legs are stamped with it, so
 * the money is in that shift's cash-up and per-register tender report. The
 * tenant's `booking`, `pos` and `register` features must be on; an
 * `Idempotency-Key` is required.
 *
 * NO new money mechanism: the body is the register and explicit `tenders` (cash
 * with change, QRIS, bank transfer, gift card, store credit; split tenders; the
 * amount is what the customer HANDED OVER for cash and the applied amount for the
 * rest), planned by the POS tender planner and recorded by the ordinary payment
 * ledger - order row locked, `409 OVERPAYMENT` above the balance, stored-value
 * legs drawn in the same transaction, the order released and `order.settled`
 * published by the ledger. The balance is READ from that ledger and the service
 * line was priced by the product: a body naming a `price`, a `balance` or an
 * `orderId` is a `400`. `409 NO_BALANCE_DUE` when nothing is owed. Points
 * redemption and a refundable deposit are not offered here (Q8, Q3).
 */
import { fail, ok } from "../../../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../../../lib/composition/booking-port";
import {
  idempotencyErrorResponse,
  noStore,
  posRefusalResponse,
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey,
  requirePosFeatures
} from "../../../../../../../../modules/commerce/application/booking-adapter-http";
import { collectBalanceAtPos } from "../../../../../../../../modules/commerce/application/booking-pos";
import { AllocationSourceKeyConflictError } from "../../../../../../../../modules/commerce/application/payment-allocation-directory";
import { storedValueTenderErrorResponse } from "../../../../../../../../modules/commerce/application/stored-value-http";
import { COMMERCE_BOOKING_BALANCE_PAYMENTS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validatePosBalancePaymentRequest,
  type PosBalancePaymentRequest
} from "../../../../../../../../modules/commerce/domain/booking-pos";
import { FeatureDisabledError } from "../../../../../../../../modules/commerce/domain/commerce-features";
import {
  InvalidTenderPlanError,
  OverpaymentError
} from "../../../../../../../../modules/commerce/domain/payment-allocation";
import { isUuid } from "../../../../../../../../modules/commerce/domain/register";

const BALANCE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_BALANCE_PAYMENTS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = { body: PosBalancePaymentRequest; idempotencyKey: string };

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return noStore(key.response);
    if (key.key.length > 200) {
      return noStore(
        fail(
          400,
          "VALIDATION_ERROR",
          "Idempotency-Key must be at most 200 characters."
        )
      );
    }
    const body = await readValidatedBody(
      request,
      validatePosBalancePaymentRequest
    );
    if (body instanceof Response) return noStore(body);
    return { body, idempotencyKey: key.key.trim() };
  },
  authorize: BALANCE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals, params }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return noStore(gate);
    const pos = await requirePosFeatures(tx, tenantId, { register: true });
    if (pos) return pos;

    const id = params.id;
    if (!isUuid(id)) {
      return posRefusalResponse({ code: "RESERVATION_NOT_FOUND" });
    }

    try {
      const result = await collectBalanceAtPos(
        tx,
        {
          tenantId,
          actorTenantUserId: auth.context.tenantUserId,
          correlationId: locals.correlationId ?? crypto.randomUUID(),
          port: await composedBookingPort()
        },
        {
          reservationId: id,
          registerId: prepared.body.registerId,
          tenders: prepared.body.tenders,
          idempotencyKey: prepared.idempotencyKey
        }
      );
      if (result.kind === "refused") return posRefusalResponse(result.refusal);
      return noStore(ok(result.body));
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError, AllocationSourceKeyConflictError,
      // OverpaymentError, InvalidTenderPlanError, FeatureDisabledError and the
      // stored-value tender errors are raised by application code before the
      // first leg is written, or after the payment savepoint rolled the legs
      // back, so the transaction is healthy.
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return noStore(mapped);
      if (error instanceof AllocationSourceKeyConflictError) {
        return noStore(
          fail(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Idempotency-Key was already used with a different request."
          )
        );
      }
      if (error instanceof OverpaymentError) {
        return noStore(
          fail(
            409,
            "OVERPAYMENT",
            "The non-cash tenders exceed the balance owed; only a cash tender may exceed it, as change.",
            {},
            { outstanding: error.outstanding, attempted: error.attempted }
          )
        );
      }
      if (error instanceof InvalidTenderPlanError) {
        return noStore(
          fail(400, "VALIDATION_ERROR", error.message, {}, [
            { field: error.field, message: error.message }
          ])
        );
      }
      if (error instanceof FeatureDisabledError) {
        return noStore(
          fail(
            409,
            "FEATURE_DISABLED",
            `The "${error.feature}" feature is disabled for this tenant.`
          )
        );
      }
      const storedValue = storedValueTenderErrorResponse(error);
      if (storedValue) return noStore(storedValue);
      throw error;
    }
  }
});
