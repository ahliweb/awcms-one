/**
 * Hold-to-order: hold a Booking slot or stay and create the commerce order from
 * it in ONE idempotent call (Issue #380, ADR-0045 G2/G4/G5/G10/D3/D17; contracts
 * section 3.2; threat controls C-05, C-08, C-32, C-38).
 *
 * ## One transaction, refusals as values (G2)
 *
 * The hold (through `BookingPort`, in-process, on the CALLER's transaction), the
 * order and the reservation link are written by the one `withTenant`
 * transaction of the route. The order is the generic order writer
 * (`order-directory.ts`), so tax, vouchers' absence, the customer, the audit row
 * and the `order.created` event are exactly an order's; this file supplies the
 * two seams it needs (`BookingOrderExtras`): the hold, placed after the cart
 * re-quote validated and before the first order row, and the link, written after
 * the lines. Every refusal - Booking's (`SLOT_UNAVAILABLE`, ...), the
 * adapter's (`OFFERING_NOT_LINKED`, ...) or the order's (`CART_CHANGED`) - is a
 * RETURNED value and happens before the first write, so the route maps it to its
 * HTTP code with nothing half-built. The one write that precedes a refusal is
 * the compensation of an offering that turned out to confirm without payment
 * (hold, then cancel through the port: a consistent pair).
 *
 * ## Price, deposit and expiry come from the server (Q1, G10, D17)
 *
 * The line is the linked product at its own price, quantity = nights for a stay
 * (`quantity_basis = 'nights'`) or 1 for a slot; the cart quote prices it
 * (`bookingSale`: capacity is Booking's, the product's stock counter is not
 * consulted and not moved). `dp_amount` is the deposit policy's (policy row
 * first, the legacy store-wide rule only when the product has none), snapshotted
 * on the order when the shopper chose `payment.method = 'dp'`. The order's
 * `expires_at` IS the hold's expiry, so the payment window and the claim end
 * together.
 *
 * ## Identity and idempotency (G4, G5, C-32)
 *
 * The `Idempotency-Key` becomes the link's `client_key` under a NAMESPACE of the
 * acting party - the staff tenant user, the signed-in customer, or an anonymous
 * guest's phone - so another party cannot claim or replay a key, and the
 * request's keyed hash is stored beside it: the same key with another request is
 * `IDEMPOTENCY_CONFLICT`, with the same one the ORIGINAL result comes back
 * (`replayed: true`). The order id and the link id are derived from the
 * namespaced key (keyed hash), so Booking's `externalRef` can name the order
 * before it exists and Booking's own idempotency key is derived from the LINK
 * id, never from client input. The customer is the bearer session's own
 * customer, or the guest's phone-keyed customer; it is never an input id and is
 * stored nowhere in the adapter (X7).
 *
 * ## Who Booking sees (G3)
 *
 * A staff call passes the staff user as `actorTenantUserId`; a customer or guest
 * call passes the tenant's SERVICE-ACCOUNT user (`booking-adapter-settings.ts`),
 * refusing with `BOOKING_SERVICE_ACTOR_NOT_CONFIGURED` when none is named.
 */
import { computeRequestHash } from "../../_shared/idempotency";
import type {
  BookingHoldInput,
  BookingPort
} from "../../_shared/ports/booking-port";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  actorNamespace,
  nightsBetween,
  requestFingerprint,
  type BookingRequestActor,
  type BookingReservationRequest,
  type HoldRefusal
} from "../domain/booking-hold-to-order";
import type { CreateOrderInput } from "../domain/order-request-validation";
import { fetchBookingServiceActor } from "./booking-adapter-settings";
import {
  readBookingReservation,
  type BookingReservationFacts
} from "./booking-reservation-reads";
import { fetchCustomerById } from "./customer-directory";
import { createBookingOrderFromCart } from "./order-directory";
import {
  fetchOrderPaymentSummary,
  type OrderPaymentSummary
} from "./payment-allocation-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";
const EXTERNAL_REF_TYPE = "commerce_order";

export type BookingReservationView = {
  /** Booking's reservation id. */
  reservationId: string;
  reservationNo: string;
  /** Booking's status: held, confirmed, ... */
  status: string;
  holdExpiresAt: string | null;
  startsAt: string;
  endsAt: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  linkId: string;
  linkStatus: string;
  settlement: OrderPaymentSummary["settlement"];
};

export type HoldToOrderResult =
  | { kind: "created" | "replayed"; view: BookingReservationView }
  | { kind: "refused"; refusal: HoldRefusal };

export type HoldToOrderContext = {
  tenantId: string;
  actor: BookingRequestActor;
  /** The customer id of a verified bearer session; set exactly when `actor.kind === 'customer'`. */
  accountCustomerId?: string;
  correlationId: string;
  port: BookingPort;
  mediaPort: MediaLibraryPort;
  now?: Date;
};

/** UUID-shaped id derived (keyed) from a label; stable for one deployment secret, never a secret itself. */
export function derivedUuid(label: string): string {
  const hex = computeRequestHash({ derive: label }).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "89ab"[Number.parseInt(hex[16]!, 16) % 4]!;
  const flat = hex.join("");
  return `${flat.slice(0, 8)}-${flat.slice(8, 12)}-${flat.slice(12, 16)}-${flat.slice(16, 20)}-${flat.slice(20, 32)}`;
}

/** `bk1:<actor tag>:<keyed hash of the key>` - at most 300 characters (the column bound) whatever the client sent. */
export function buildClientKey(
  actor: BookingRequestActor,
  idempotencyKey: string
): string {
  const keyDigest = computeRequestHash({ key: idempotencyKey }).slice(0, 40);
  return `bk1:${actorNamespace(actor)}:${keyDigest}`;
}

type LinkRow = {
  id: string;
  order_id: string;
  reservation_id: string;
  status: string;
  request_hash: string;
  attention_reason?: string | null;
};

async function lockClientKey(
  tx: Bun.SQL,
  tenantId: string,
  clientKey: string
): Promise<void> {
  // Two concurrent calls with one key queue here, so the second one finds the
  // first one's committed link and replays it instead of colliding on the
  // unique index.
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:booking-hold:${clientKey}`}, 0))
  `;
}

/** Builds the response/read view of a link: Booking's facts, the order's code and status, the ledger's settlement. */
export async function buildReservationView(
  tx: Bun.SQL,
  tenantId: string,
  link: { id: string; orderId: string; reservationId: string; status: string }
): Promise<BookingReservationView | null> {
  const facts: BookingReservationFacts | null = await readBookingReservation(
    tx,
    tenantId,
    link.reservationId
  );
  const summary = await fetchOrderPaymentSummary(tx, tenantId, link.orderId);
  if (!facts || !summary) return null;
  return {
    reservationId: facts.id,
    reservationNo: facts.reservationNo,
    status: facts.status,
    holdExpiresAt: facts.holdExpiresAt,
    startsAt: facts.startsAt,
    endsAt: facts.endsAt,
    orderId: summary.orderId,
    orderCode: summary.orderCode,
    orderStatus: summary.orderStatus,
    linkId: link.id,
    linkStatus: link.status,
    settlement: summary.settlement
  };
}

export async function createBookingReservation(
  tx: Bun.SQL,
  ctx: HoldToOrderContext,
  request: BookingReservationRequest,
  idempotencyKey: string
): Promise<HoldToOrderResult> {
  const { tenantId, actor } = ctx;
  const refuse = (refusal: HoldRefusal): HoldToOrderResult => ({
    kind: "refused",
    refusal
  });

  const clientKey = buildClientKey(actor, idempotencyKey);
  const requestHash = computeRequestHash(
    requestFingerprint(actorNamespace(actor), request)
  );

  await lockClientKey(tx, tenantId, clientKey);

  // -- Replay (G5) -----------------------------------------------------------
  const existing = (await tx`
    SELECT id, order_id, reservation_id, status, request_hash
    FROM awcms_commerce_booking_reservation_links
    WHERE tenant_id = ${tenantId} AND client_key = ${clientKey}
  `) as LinkRow[];
  if (existing[0]) {
    if (existing[0].request_hash !== requestHash) {
      return refuse({ code: "IDEMPOTENCY_CONFLICT" });
    }
    const view = await buildReservationView(tx, tenantId, {
      id: existing[0].id,
      orderId: existing[0].order_id,
      reservationId: existing[0].reservation_id,
      status: existing[0].status
    });
    if (!view)
      throw new Error("A reservation link lost its order or reservation.");
    return { kind: "replayed", view };
  }

  // -- Who books (G3) ----------------------------------------------------------
  const bookingActor =
    actor.kind === "staff"
      ? actor.tenantUserId
      : await fetchBookingServiceActor(tx, tenantId);
  if (!bookingActor) return refuse({ code: "SERVICE_ACTOR_NOT_CONFIGURED" });

  // -- The offering's product -------------------------------------------------
  const links = (await tx`
    SELECT id, product_id, quantity_basis
    FROM awcms_commerce_booking_offering_links
    WHERE tenant_id = ${tenantId} AND offering_id = ${request.offeringId}
      AND status = 'active'
  `) as { id: string; product_id: string; quantity_basis: string }[];
  const offeringLink = links[0];
  if (!offeringLink) return refuse({ code: "OFFERING_NOT_LINKED" });

  const nights = request.stay
    ? nightsBetween(request.stay.checkInDate, request.stay.checkOutDate)
    : null;
  const basisAgrees =
    offeringLink.quantity_basis === "nights"
      ? request.stay !== null && nights !== null
      : request.startsAt !== null;
  if (!basisAgrees) return refuse({ code: "QUANTITY_BASIS_MISMATCH" });
  const quantity = offeringLink.quantity_basis === "nights" ? nights! : 1;

  // -- The customer ------------------------------------------------------------
  let customer: CreateOrderInput["customer"];
  if (ctx.accountCustomerId) {
    const account = await fetchCustomerById(
      tx,
      tenantId,
      ctx.accountCustomerId
    );
    if (!account) return refuse({ code: "ACCOUNT_BLOCKED" });
    customer = {
      name: account.name,
      phone: account.phone,
      email: account.email
    };
  } else if (request.guest) {
    customer = request.guest;
  } else {
    return refuse({ code: "INVALID_PHONE" });
  }

  const orderId = derivedUuid(`booking-order:${tenantId}:${clientKey}`);
  const linkId = derivedUuid(`booking-link:${tenantId}:${clientKey}`);

  const input: CreateOrderInput = {
    // Unused by the booking path (the link's client key is the idempotency);
    // present because the generic order shape requires one.
    idempotencyKey: clientKey,
    customer,
    address: null,
    lines: [
      {
        productId: offeringLink.product_id,
        variantId: null,
        quantity,
        serviceFormValues: null
      }
    ],
    shipping: null,
    payment: { method: request.paymentMethod },
    voucherCode: null,
    insurance: false,
    notes: request.notes,
    affiliateCode: null
  };

  let reservationId: string | null = null;
  const holdInput = (): BookingHoldInput => ({
    tenantId,
    offeringId: request.offeringId,
    resourceId: request.resourceId,
    ...(request.stay
      ? { stay: request.stay }
      : { startsAt: request.startsAt! }),
    partySize: request.partySize,
    quantity: 1,
    externalRef: { type: EXTERNAL_REF_TYPE, id: orderId },
    // Derived from the LINK id, never from client input (G5).
    idempotencyKey: `commerce-booking-hold:${linkId}`,
    correlationId: ctx.correlationId,
    actorTenantUserId: bookingActor
  });

  const outcome = await createBookingOrderFromCart(
    tx,
    tenantId,
    ctx.mediaPort,
    input,
    {
      orderId,
      hold: async () => {
        const held = await ctx.port.hold(tx, holdInput());
        if (!held.ok) {
          return {
            ok: false,
            refusal: { code: "BOOKING", reason: held.reason }
          };
        }
        reservationId = held.reservationId;
        if (held.status !== "held" || held.holdExpiresAt === null) {
          // An offering edited to confirm without payment after it was linked:
          // never leave a confirmed claim behind an unpaid order.
          await ctx.port.cancel(tx, {
            tenantId,
            reservationId: held.reservationId,
            idempotencyKey: `commerce-booking-hold-cancel:${linkId}`,
            correlationId: ctx.correlationId,
            actorTenantUserId: bookingActor,
            reasonCode: "offering_not_holdable"
          });
          return { ok: false, refusal: { code: "OFFERING_NOT_LINKABLE" } };
        }
        return { ok: true, expiresAt: new Date(held.holdExpiresAt) };
      },
      onItemsWritten: async (order, itemIds) => {
        await tx`
          INSERT INTO awcms_commerce_booking_reservation_links (
            id, tenant_id, order_id, order_item_id, reservation_id,
            offering_link_id, client_key, request_hash
          )
          VALUES (
            ${linkId}, ${tenantId}, ${order.id}, ${itemIds[0]!},
            ${reservationId!}, ${offeringLink.id}, ${clientKey}, ${requestHash}
          )
        `;
        await recordAuditEvent(tx, {
          tenantId,
          actorTenantUserId:
            actor.kind === "staff" ? actor.tenantUserId : undefined,
          moduleKey: AUDIT_MODULE_KEY,
          action: "create",
          resourceType: AUDIT_RESOURCE_TYPE,
          resourceId: linkId,
          message: `Booking reservation held and order ${order.orderCode} created.`,
          attributes: {
            orderId: order.id,
            orderCode: order.orderCode,
            reservationId: reservationId!,
            offeringLinkId: offeringLink.id,
            channel: actor.kind
          },
          correlationId: ctx.correlationId
        });
      }
    },
    ctx.now ?? new Date(),
    ctx.correlationId,
    ctx.accountCustomerId
  );

  switch (outcome.kind) {
    case "booking_refused":
      return refuse(outcome.refusal);
    case "invalid_phone":
      return refuse({ code: "INVALID_PHONE" });
    case "cart_changed": {
      const methodMissing =
        outcome.quote.canCheckout &&
        !outcome.quote.paymentMethods.some(
          (method) =>
            method.method === request.paymentMethod && method.available
        );
      return refuse(
        methodMissing
          ? { code: "PAYMENT_METHOD_UNAVAILABLE" }
          : { code: "CART_CHANGED", quote: outcome.quote }
      );
    }
    case "created": {
      const view = await buildReservationView(tx, tenantId, {
        id: linkId,
        orderId,
        reservationId: reservationId!,
        status: "active"
      });
      if (!view)
        throw new Error("A created reservation could not be read back.");
      return { kind: "created", view };
    }
    case "replayed":
    case "loyalty_refused":
      // Unreachable: the booking path never reads the shared idempotency record
      // and takes no points redemption.
      throw new Error(`Unexpected order outcome ${outcome.kind}.`);
  }
}
