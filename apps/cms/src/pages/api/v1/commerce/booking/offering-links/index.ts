/**
 * `GET|POST /api/v1/commerce/booking/offering-links` - the links between Booking
 * offerings and service products (Issue #378, ADR-0045 D1).
 *
 * `GET` (`commerce.booking_offering_links.read`) is the keyset list, newest
 * first (`?status=active|unlinked`, `?cursor=`). `POST`
 * (`commerce.booking_offering_links.create`, requires `Idempotency-Key`) links
 * one offering to one service product: one active product per offering and one
 * active offering per product (`409 OFFERING_ALREADY_LINKED` /
 * `PRODUCT_ALREADY_LINKED`), a service product only (`PRODUCT_NOT_SERVICE`), a
 * `quantityBasis` that agrees with the offering's granularity
 * (`QUANTITY_BASIS_MISMATCH`), an offering that is not `immediate`
 * (`OFFERING_NOT_LINKABLE`, G9), and a configured service-account user
 * (`BOOKING_SERVICE_ACTOR_NOT_CONFIGURED`, G3). A body naming a price, amount
 * or customer is a `400`. Both methods are gated on the tenant's `booking`
 * feature (`409 FEATURE_DISABLED` while off).
 */
import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { decodeKeysetCursor } from "../../../../../../modules/_shared/keyset-pagination";
import {
  idempotencyErrorResponse,
  offeringLinkRefusalResponse,
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import {
  createOfferingLink,
  listOfferingLinks
} from "../../../../../../modules/commerce/application/booking-offering-links";
import {
  BOOKING_OFFERING_LINK_STATUSES,
  validateCreateOfferingLinkInput,
  type BookingOfferingLinkStatus,
  type CreateOfferingLinkInput
} from "../../../../../../modules/commerce/domain/booking-adapter";
import { COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

const CREATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
  action: "create"
} as const;

type PreparedList = {
  status: BookingOfferingLinkStatus | null;
  cursor: ReturnType<typeof decodeKeysetCursor>;
};

export const GET = defineTenantRoute<PreparedList>({
  workClass: "interactive",
  prepare: ({ url }): PreparedList | Response => {
    const statusParam = url.searchParams.get("status");
    if (
      statusParam !== null &&
      !(BOOKING_OFFERING_LINK_STATUSES as readonly string[]).includes(
        statusParam
      )
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "status must be active or unlinked."
      );
    }
    const cursorParam = url.searchParams.get("cursor");
    const cursor =
      cursorParam === null ? null : decodeKeysetCursor(cursorParam);
    if (cursorParam !== null && cursor === null) {
      return fail(400, "VALIDATION_ERROR", "cursor is malformed.");
    }
    return { status: statusParam as BookingOfferingLinkStatus | null, cursor };
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    return ok(await listOfferingLinks(tx, tenantId, prepared));
  }
});

type PreparedCreate = {
  input: CreateOfferingLinkInput;
  idempotencyKey: string;
};

export const POST = defineTenantRoute<PreparedCreate>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedCreate | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    const input = await readValidatedBody(
      request,
      validateCreateOfferingLinkInput
    );
    if (input instanceof Response) return input;
    return { input, idempotencyKey: key.key };
  },
  authorize: CREATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    try {
      const outcome = await createOfferingLink(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared.input,
        prepared.idempotencyKey,
        locals.correlationId
      );
      if (outcome.kind === "refused") {
        return offeringLinkRefusalResponse(outcome.refusal);
      }
      // `created` and `replayed` answer the SAME 201 body: a replay is a client
      // retry, not a second link.
      return created(outcome.link);
    } catch (error) {
      // tx-swallow-ok: IdempotencyRaceLostError and
      // IdempotencyPayloadMismatchError are raised by application code after
      // statements that succeeded (ON CONFLICT DO NOTHING plus a replay
      // lookup), so the transaction is healthy.
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
