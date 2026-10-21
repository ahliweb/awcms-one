/**
 * `POST /api/v1/commerce/pos/booking/lookup` - find one booking reservation at
 * the till (Issue #383, ADR-0045 D19, `docs/booking-ux-flows.md` section 5.1;
 * threat control C-34).
 *
 * The body is the reservation's CODE (Booking's `reservationNo`, G13) together
 * with the customer's phone OR e-mail - both, exactly, and nothing else. There is
 * no name search, no prefix, no date; a code alone or an identifier alone is a
 * `400`, so the route cannot list a tenant's guests or walk the code space. An
 * unknown code, a code whose customer is somebody else and another tenant's code
 * are ONE neutral `404` (byte for byte). It is a `POST` so the identifier never
 * lands in a URL, a server log or the browser history, and every response is
 * `Cache-Control: no-store`.
 *
 * Gated on `commerce.booking_reservation_links.read`, the tenant's `booking` and
 * `pos` features, a per-actor lookup rate (`429`) and a per-actor budget of wrong
 * guesses. Every lookup - hit, miss, throttled - is audited with a keyed digest of
 * the identifier, never the identifier. The answer shows the status, the dates,
 * the ledger's balance and the contact MASKED; it carries no customer id.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  noStore,
  posLookupMissResponse,
  readValidatedBody,
  requireBookingFeature,
  requirePosFeatures
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import { lookupBookingForPos } from "../../../../../../modules/commerce/application/booking-pos";
import { COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";
import {
  validatePosLookupRequest,
  type PosLookupRequest
} from "../../../../../../modules/commerce/domain/booking-pos";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

export const POST = defineTenantRoute<PosLookupRequest>({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PosLookupRequest | Response> => {
    const body = await readValidatedBody(request, validatePosLookupRequest);
    return body instanceof Response ? noStore(body) : body;
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return noStore(gate);
    const pos = await requirePosFeatures(tx, tenantId, { register: false });
    if (pos) return pos;

    // The audit row of a miss or a throttled attempt must COMMIT with the
    // refusal: this handler returns the 404 / 429 after writing it, on purpose.
    const result = await lookupBookingForPos(
      tx,
      {
        tenantId,
        actorTenantUserId: auth.context.tenantUserId,
        correlationId: locals.correlationId ?? crypto.randomUUID()
      },
      prepared
    );
    if (result.kind === "miss") return posLookupMissResponse();
    if (result.kind === "throttled") {
      return noStore(
        fail(
          429,
          "RATE_LIMITED",
          "Too many lookups. Try again later.",
          {},
          undefined,
          { "retry-after": String(result.retryAfterSec) }
        )
      );
    }
    return noStore(ok(result.card));
  }
});
