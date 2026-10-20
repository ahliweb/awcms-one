/**
 * `POST /api/v1/commerce/booking/reservations` - hold a Booking slot or stay for
 * a guest and create the commerce order from it, in ONE idempotent call (Issue
 * #380, ADR-0045 G2; contracts section 3.2). The staff variant of the
 * storefront call: gated on `commerce.booking_reservation_links.create`, the
 * guest's contact comes in the body (`guest.name`, `guest.phone`), Booking sees
 * the STAFF member as the acting user, and the idempotency namespace is that
 * staff member (so a colleague cannot claim or replay the key).
 *
 * The price is the linked product's (never the body's: `amount`, `price`,
 * `deposit`, `customerId` and friends are a `400`), the deposit is the product's
 * policy snapshotted as `dp_amount` when `payment.method = "dp"`, and the order
 * expires with the hold. Requires `Idempotency-Key`; a replay answers `200`
 * with `replayed: true` and creates neither a second reservation nor a second
 * order. A Booking refusal keeps Booking's code under `409` (`429` for
 * `HOLD_LIMIT_EXCEEDED`); the whole write is one `withTenant` transaction and a
 * refusal leaves nothing behind. Gated on the tenant's `booking` feature.
 */
import { created, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { composedBookingPort } from "../../../../../../lib/composition/booking-port";
import {
  createdReservationBody,
  holdRefusalResponse,
  idempotencyErrorResponse,
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import { createBookingReservation } from "../../../../../../modules/commerce/application/booking-hold-to-order";
import {
  validateBookingReservationRequest,
  type BookingReservationRequest
} from "../../../../../../modules/commerce/domain/booking-hold-to-order";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";
import { normalizePhoneNumber } from "../../../../../../modules/commerce/domain/phone-normalisation";
import { fail } from "../../../../../../modules/_shared/api-response";
import { mediaLibraryPortAdapter } from "../../../../../../modules/media-library/application/media-library-port-adapter";

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "create"
} as const;

type Prepared = {
  request: BookingReservationRequest;
  idempotencyKey: string;
};

export const POST = defineTenantRoute<Prepared>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<Prepared | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    if (key.key.length > 255) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Idempotency-Key must be at most 255 characters."
      );
    }
    const body = await readValidatedBody(
      request,
      validateBookingReservationRequest
    );
    if (body instanceof Response) return body;
    // Staff book on behalf of a guest: the contact is required and must be a phone.
    if (!body.guest) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body failed validation.",
        {},
        [{ field: "guest", message: "guest is required for a staff booking." }]
      );
    }
    if (!normalizePhoneNumber(body.guest.phone).valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Request body failed validation.",
        {},
        [
          {
            field: "guest.phone",
            message: "guest.phone is not a valid Indonesian phone number."
          }
        ]
      );
    }
    return { request: body, idempotencyKey: key.key };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const result = await createBookingReservation(
        tx,
        {
          tenantId,
          actor: { kind: "staff", tenantUserId: auth.context.tenantUserId },
          correlationId: locals.correlationId ?? crypto.randomUUID(),
          port: await composedBookingPort(),
          mediaPort: mediaLibraryPortAdapter
        },
        prepared.request,
        prepared.idempotencyKey
      );
      if (result.kind === "refused") return holdRefusalResponse(result.refusal);
      const body = createdReservationBody(
        result.view,
        result.kind === "replayed"
      );
      return result.kind === "replayed" ? ok(body) : created(body);
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
