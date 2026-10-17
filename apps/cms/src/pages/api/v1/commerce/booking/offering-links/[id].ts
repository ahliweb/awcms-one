/**
 * `GET|PATCH /api/v1/commerce/booking/offering-links/{id}` - one offering link
 * (Issue #378, ADR-0045 D1). `GET` (`commerce.booking_offering_links.read`)
 * returns it. `PATCH` (`commerce.booking_offering_links.update`, requires
 * `Idempotency-Key`) unlinks it - the body is `{ "status": "unlinked" }`, the
 * only transition; there is no delete - so past orders and reservation links
 * keep their history. Unlinking an already unlinked link answers `200` with the
 * stored row and writes nothing. An unknown id and another tenant's id are the
 * same `404`. Both methods are gated on the tenant's `booking` feature.
 */
import { fail, ok } from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import {
  idempotencyErrorResponse,
  readValidatedBody,
  requireBookingFeature,
  requireIdempotencyKey
} from "../../../../../../modules/commerce/application/booking-adapter-http";
import {
  fetchOfferingLink,
  unlinkOfferingLink
} from "../../../../../../modules/commerce/application/booking-offering-links";
import { validateUpdateOfferingLinkInput } from "../../../../../../modules/commerce/domain/booking-adapter";
import { isUuid } from "../../../../../../modules/commerce/domain/register";
import { COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/booking-adapter-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
  action: "update"
} as const;

const notFound = (): Response =>
  fail(404, "RESOURCE_NOT_FOUND", "Offering link not found.");

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, params }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return notFound();
    const link = await fetchOfferingLink(tx, tenantId, params.id);
    return link ? ok(link) : notFound();
  }
});

export const PATCH = defineTenantRoute<{ idempotencyKey: string }>({
  workClass: "interactive",
  prepare: async ({
    request
  }): Promise<{ idempotencyKey: string } | Response> => {
    const key = requireIdempotencyKey(request);
    if ("response" in key) return key.response;
    const body = await readValidatedBody(
      request,
      validateUpdateOfferingLinkInput
    );
    if (body instanceof Response) return body;
    return { idempotencyKey: key.key };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, params, prepared, locals }) => {
    const gate = await requireBookingFeature(tx, tenantId);
    if (gate) return gate;
    if (!isUuid(params.id)) return notFound();
    try {
      const outcome = await unlinkOfferingLink(
        tx,
        tenantId,
        auth.context.tenantUserId,
        params.id,
        prepared.idempotencyKey,
        locals.correlationId
      );
      if (outcome.kind === "not_found") return notFound();
      return ok(outcome.link);
    } catch (error) {
      const mapped = idempotencyErrorResponse(error);
      if (mapped) return mapped;
      throw error;
    }
  }
});
