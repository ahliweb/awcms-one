/**
 * `POST /api/v1/commerce/pos/booking/reservations/{id}/check-in` - check a
 * confirmed guest in at the till (Issue #383, ADR-0045 D19; threat controls C-35
 * and C-36). `id` is BOOKING's reservation id (the lookup returns it).
 *
 * Its own permission, `commerce.booking_check_ins.create`: taking payment and
 * checking out are different keys, so one grant cannot start a stay, end it and
 * take the money. The register named in the body must have an OPEN session whose
 * current cashier is the caller (ADR-0028), the tenant's `booking`, `pos` and
 * `register` features must be on, and an `Idempotency-Key` is required.
 *
 * The POS writes no reservation state: the transition is `BookingPort.checkIn`
 * (idempotent; asking for a guest already checked in is a harmless replay).
 * `409 CHECK_IN_TOO_EARLY` before the check-in date. Tenant policy (D19): with
 * `checkinRequiresSettlement` ON (the default) a balance owed on the order's
 * ledger is `409 BALANCE_NOT_SETTLED`, nothing written; OFF, the check-in
 * proceeds and the audit row records that the balance was waived. The body is the
 * register only - the status and the balance are the server's.
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
import { checkInAtPos } from "../../../../../../../../modules/commerce/application/booking-pos";
import { COMMERCE_BOOKING_CHECK_INS_ACTIVITY_CODE } from "../../../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validatePosRegisterRequest,
  type PosRegisterRequest
} from "../../../../../../../../modules/commerce/domain/booking-pos";
import { isUuid } from "../../../../../../../../modules/commerce/domain/register";

const CHECK_IN_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_CHECK_INS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = { body: PosRegisterRequest; idempotencyKey: string };

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
    const body = await readValidatedBody(request, validatePosRegisterRequest);
    if (body instanceof Response) return noStore(body);
    return { body, idempotencyKey: key.key.trim() };
  },
  authorize: CHECK_IN_GUARD,
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
      const result = await checkInAtPos(
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
          idempotencyKey: prepared.idempotencyKey
        }
      );
      if (result.kind === "refused") return posRefusalResponse(result.refusal);
      return noStore(ok(result.body));
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError is raised by the idempotency
      // store's own savepointed insert after the work, so the transaction is
      // healthy; a Booking refusal is a returned value, never thrown.
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return noStore(mapped);
      throw error;
    }
  }
});
