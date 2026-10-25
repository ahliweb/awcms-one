/**
 * The anonymous booking reads behind the `toko` storefront's `/booking`,
 * `/booking/pesan` and `/akun/reservasi` pages (Issue #386, ADR-0045
 * implementation notes): the bookable offerings, a stay's availability, the
 * server quote, and a signed-in shopper's own reservation list.
 *
 * ## What is a "bookable" offering
 *
 * One with an ACTIVE offering link (ADR-0045 D1), whose product is an active,
 * undeleted service, and whose Booking offering is `active` and
 * `hold_then_confirm` (G9: an `immediate` offering confirms without payment and
 * cannot be sold). Everything else - unknown, another tenant's, unlinked,
 * inactive - is ONE answer to a caller: not found. The offering facts come from
 * the PORT (`getOffering`, contract 1.1.0), never a table read.
 *
 * ## Which resource sells an offering
 *
 * A Booking offering does not fix a resource. The public page needs a
 * `resourceId` for the availability read and the hold, by id only - never a
 * name, a unit label or the capacity, in two cases (Issue #437):
 *
 * - The link NAMES its resource(s) (`awcms_commerce_booking_offering_link_
 *   resources`, sql/1050): only those, in the order the admin gave and only the
 *   ones that are still active and of the right mode, are offered, and
 *   availability and the hold refuse any other id. A bound link whose resources
 *   are all inactive is NOT sold; it never falls back to the whole pool, or it
 *   would offer another room type.
 * - The link names none (every link made before #437; M9): the tenant's ACTIVE,
 *   undeleted resources whose booking mode matches the offering's granularity
 *   (`stay` / `slot`) in `sort_order, code` order, and the page probes them in
 *   turn - correct for one resource, or several interchangeable ones, per mode.
 *
 * This file is one of three commerce files that name a Booking table (with
 * `booking-offering-links.ts` and `booking-reservation-reads.ts`), always in a
 * `SELECT` (a static test pins the set).
 *
 * ## Money
 *
 * Nights, unit price, tax, total and the deposit come from the same
 * `buildCartQuote` the hold-to-order path re-quotes with (`bookingSale: true`),
 * priced at the signed-in customer's level when a live bearer is presented. The
 * storefront never computes a night or a total.
 */
import type {
  BookingOfferingRecord,
  BookingPort
} from "../../_shared/ports/booking-port";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { nightsBetween } from "../domain/booking-hold-to-order";
import {
  MAX_BOOKABLE_OFFERINGS,
  MAX_RESOURCES_PER_OFFERING,
  type AvailabilityQuery,
  type PublicAvailability,
  availabilityBody,
  publicAvailabilityRefusal,
  type QuoteQuery
} from "../domain/booking-storefront-reads";
import type { CustomerLevel } from "../domain/cart-quote";
import { fromCents, toCents } from "../domain/price-calculation";
import {
  buildReservationView,
  type BookingReservationView
} from "./booking-hold-to-order";
import { reservationViewBody } from "./booking-adapter-http";
import { buildCartQuote } from "./cart-quote-service";

type LinkedOffering = {
  offeringLinkId: string;
  offeringId: string;
  productId: string;
  quantityBasis: "nights" | "booking";
};

/**
 * The ACTIVE link of `offeringId` whose product is a sellable service, or
 * `null`. One query, tenant-named, under RLS.
 */
async function readSellableLink(
  tx: Bun.SQL,
  tenantId: string,
  offeringId: string
): Promise<LinkedOffering | null> {
  const rows = (await tx`
    SELECT l.id, l.offering_id, l.product_id, l.quantity_basis
    FROM awcms_commerce_booking_offering_links l
    JOIN awcms_commerce_products p
      ON p.tenant_id = l.tenant_id AND p.id = l.product_id
    WHERE l.tenant_id = ${tenantId}
      AND l.offering_id = ${offeringId}
      AND l.status = 'active'
      AND l.deleted_at IS NULL
      AND p.status = 'active'
      AND p.deleted_at IS NULL
  `) as {
    id: string;
    offering_id: string;
    product_id: string;
    quantity_basis: "nights" | "booking";
  }[];
  const row = rows[0];
  return row
    ? {
        offeringLinkId: row.id,
        offeringId: row.offering_id,
        productId: row.product_id,
        quantityBasis: row.quantity_basis
      }
    : null;
}

type BoundResource = {
  resourceId: string;
  bookingMode: "stay" | "slot";
  /** Active and not deleted NOW. */
  live: boolean;
};

/**
 * The resources each of `linkIds` names (Issue #437), in the order the admin
 * gave. A link absent from the map names none: the fallback. Read-only `SELECT`
 * of a Booking table (see the header).
 */
async function readBoundResources(
  tx: Bun.SQL,
  tenantId: string,
  linkIds: string[]
): Promise<Map<string, BoundResource[]>> {
  const bound = new Map<string, BoundResource[]>();
  if (linkIds.length === 0) return bound;
  const rows = (await tx`
    SELECT lr.offering_link_id, lr.resource_id, r.booking_mode,
           (r.status = 'active' AND r.deleted_at IS NULL) AS live
    FROM awcms_commerce_booking_offering_link_resources lr
    JOIN awcms_booking_resources r
      ON r.tenant_id = lr.tenant_id AND r.id = lr.resource_id
    WHERE lr.tenant_id = ${tenantId}
      AND lr.offering_link_id = ANY(${tx.array(linkIds, "uuid")}::uuid[])
    ORDER BY lr.offering_link_id, lr.sort_order, lr.created_at, lr.resource_id
  `) as {
    offering_link_id: string;
    resource_id: string;
    booking_mode: "stay" | "slot";
    live: boolean;
  }[];
  for (const row of rows) {
    const list = bound.get(row.offering_link_id) ?? [];
    list.push({
      resourceId: row.resource_id,
      bookingMode: row.booking_mode,
      live: row.live
    });
    bound.set(row.offering_link_id, list);
  }
  return bound;
}

function isSellableOffering(offering: BookingOfferingRecord): boolean {
  return (
    offering.status === "active" &&
    offering.confirmationMode === "hold_then_confirm"
  );
}

/** Resource ids by booking mode, id only. Read-only `SELECT` of a Booking table (see the header). */
async function readResourceIds(
  tx: Bun.SQL,
  tenantId: string,
  bookingMode: "stay" | "slot"
): Promise<string[]> {
  const rows = (await tx`
    SELECT id
    FROM awcms_booking_resources
    WHERE tenant_id = ${tenantId}
      AND booking_mode = ${bookingMode}
      AND status = 'active'
      AND deleted_at IS NULL
    ORDER BY sort_order, code, id
    LIMIT ${MAX_RESOURCES_PER_OFFERING}
  `) as { id: string }[];
  return rows.map((row) => row.id);
}

/**
 * Whether `resourceId` is one of this tenant's active, undeleted resources of
 * `bookingMode` (Issue #448). Tenant-scoped under RLS like every read here, so
 * another tenant's id is simply absent. Read-only `SELECT` of a Booking table
 * (see the header).
 */
async function isLiveResourceOfMode(
  tx: Bun.SQL,
  tenantId: string,
  resourceId: string,
  bookingMode: "stay" | "slot"
): Promise<boolean> {
  const rows = (await tx`
    SELECT 1 AS ok
    FROM awcms_booking_resources
    WHERE tenant_id = ${tenantId}
      AND id = ${resourceId}
      AND booking_mode = ${bookingMode}
      AND status = 'active'
      AND deleted_at IS NULL
  `) as { ok: number }[];
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Offerings
// ---------------------------------------------------------------------------

export type BookableOffering = {
  offeringId: string;
  granularity: "stay" | "time";
  quantityBasis: "nights" | "booking";
  name: string;
  slug: string | null;
  image: { url: string; alt: string } | null;
  /** Per night for a stay, per booking for a slot; the live unit price at the caller's level. */
  unitPrice: string;
  minNights: number | null;
  maxNights: number | null;
  minParty: number;
  maxParty: number;
  durationSeconds: number | null;
  resourceIds: string[];
};

export async function listBookableOfferings(
  tx: Bun.SQL,
  tenantId: string,
  port: BookingPort,
  mediaPort: MediaLibraryPort,
  customerLevel: CustomerLevel | null,
  now: Date
): Promise<BookableOffering[]> {
  const links = (await tx`
    SELECT l.id, l.offering_id, l.product_id, l.quantity_basis
    FROM awcms_commerce_booking_offering_links l
    JOIN awcms_commerce_products p
      ON p.tenant_id = l.tenant_id AND p.id = l.product_id
    WHERE l.tenant_id = ${tenantId}
      AND l.status = 'active'
      AND l.deleted_at IS NULL
      AND p.status = 'active'
      AND p.deleted_at IS NULL
    ORDER BY l.created_at, l.id
    LIMIT ${MAX_BOOKABLE_OFFERINGS}
  `) as {
    id: string;
    offering_id: string;
    product_id: string;
    quantity_basis: "nights" | "booking";
  }[];
  if (links.length === 0) return [];

  const offerings = new Map<string, BookingOfferingRecord>();
  for (const link of links) {
    const found = await port.getOffering(tx, {
      tenantId,
      offeringId: link.offering_id
    });
    if (found.ok && isSellableOffering(found.offering)) {
      offerings.set(link.offering_id, found.offering);
    }
  }
  const sellable = links.filter((link) => offerings.has(link.offering_id));
  if (sellable.length === 0) return [];

  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: sellable.map((link) => ({
        productId: link.product_id,
        variantId: null,
        quantity: 1,
        serviceFormValues: null
      })),
      shipping: null,
      voucherCode: null,
      insurance: false,
      customerLevel,
      bookingSale: true
    },
    now
  );

  const boundByLink = await readBoundResources(
    tx,
    tenantId,
    sellable.map((link) => link.id)
  );
  const resourcesByMode = new Map<string, string[]>();
  const items: BookableOffering[] = [];
  for (const link of sellable) {
    const offering = offerings.get(link.offering_id)!;
    const line = quote.lines.find(
      (entry) => entry.productId === link.product_id
    );
    if (!line || line.status === "unavailable") continue;

    const mode = offering.granularity === "stay" ? "stay" : "slot";
    const named = boundByLink.get(link.id);
    let resourceIds: string[];
    if (named) {
      // The link names its resources: only the live ones of the right mode,
      // and an empty answer is "not sold", never the whole pool.
      resourceIds = named
        .filter((entry) => entry.live && entry.bookingMode === mode)
        .map((entry) => entry.resourceId);
    } else {
      const pool = resourcesByMode.get(mode);
      resourceIds = pool ?? (await readResourceIds(tx, tenantId, mode));
      if (!pool) resourcesByMode.set(mode, resourceIds);
    }
    if (resourceIds.length === 0) continue;

    items.push({
      offeringId: offering.offeringId,
      granularity: offering.granularity,
      quantityBasis: link.quantity_basis,
      name: line.name ?? offering.name,
      slug: line.slug,
      image: line.image,
      unitPrice: line.unitPrice,
      minNights: offering.minNights,
      maxNights: offering.maxNights,
      minParty: offering.minParty,
      maxParty: offering.maxParty,
      durationSeconds: offering.durationSeconds,
      resourceIds
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type StorefrontAvailabilityOutcome =
  | { kind: "ok"; body: PublicAvailability }
  | { kind: "refused"; status: number; code: string; message: string };

const NOT_FOUND = {
  kind: "refused",
  status: 404,
  code: "NOT_FOUND",
  message: "Not found."
} as const satisfies StorefrontAvailabilityOutcome;

/**
 * The anonymous availability read for a LINKED offering. The caller has already
 * validated the query ({@link validateAvailabilityQuery}); this refuses an
 * offering that is not sold, or a resource its link does not name, as one
 * neutral `not found`, calls the port (which
 * takes no actor and returns counts and slots only) and passes the answer
 * through the allow-listed body.
 */
export async function answerStorefrontAvailability(
  tx: Bun.SQL,
  tenantId: string,
  port: BookingPort,
  query: AvailabilityQuery
): Promise<StorefrontAvailabilityOutcome> {
  const link = await readSellableLink(tx, tenantId, query.offeringId);
  if (!link) return NOT_FOUND;
  const offering = await port.getOffering(tx, {
    tenantId,
    offeringId: query.offeringId
  });
  if (!offering.ok || !isSellableOffering(offering.offering)) return NOT_FOUND;
  // A link that names its resources answers for those only (Issue #437): any
  // other id - another room type's, another tenant's, unknown - is the same
  // neutral 404, so the route does not reveal which ids exist. Issue #448: a
  // link that names none no longer forwards an arbitrary id to Booking either;
  // the resource must be one the tenant sells for the offering's mode (the same
  // set the offerings list would have shown), and a bound resource must still be
  // live and of the right mode - a retired or other-mode room is the same 404.
  const mode = offering.offering.granularity === "stay" ? "stay" : "slot";
  const named = (
    await readBoundResources(tx, tenantId, [link.offeringLinkId])
  ).get(link.offeringLinkId);
  if (named) {
    const entry = named.find((item) => item.resourceId === query.resourceId);
    if (!entry || !entry.live || entry.bookingMode !== mode) return NOT_FOUND;
  } else if (
    !(await isLiveResourceOfMode(tx, tenantId, query.resourceId, mode))
  ) {
    return NOT_FOUND;
  }

  const result = await port.availability(
    tx,
    query.kind === "stay"
      ? {
          tenantId,
          offeringId: query.offeringId,
          resourceId: query.resourceId,
          stay: {
            checkInDate: query.checkInDate,
            checkOutDate: query.checkOutDate
          }
        }
      : {
          tenantId,
          offeringId: query.offeringId,
          resourceId: query.resourceId,
          from: query.from,
          to: query.to
        }
  );
  if (!result.ok) {
    return { kind: "refused", ...publicAvailabilityRefusal(result.reason) };
  }
  return { kind: "ok", body: availabilityBody(result) };
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export type BookingQuoteBody = {
  offeringId: string;
  granularity: "stay" | "time";
  /** Server-computed; `null` for a slot. */
  nights: number | null;
  quantity: number;
  product: {
    name: string;
    slug: string | null;
    image: { url: string; alt: string } | null;
  };
  unitPrice: string;
  subtotal: string;
  tax: { active: boolean; percent: number; amount: string };
  total: string;
  /** The deposit when the shopper chooses `dp`: `available` per the product's policy (or the legacy rule). */
  deposit: { available: boolean; amount: string; balanceDue: string };
  paymentMethods: { method: string; available: boolean }[];
  canCheckout: boolean;
  quotedAt: string;
};

export type StorefrontQuoteOutcome =
  | { kind: "ok"; body: BookingQuoteBody }
  | { kind: "not_found" }
  | { kind: "invalid"; errors: { field: string; message: string }[] };

export async function quoteStorefrontBooking(
  tx: Bun.SQL,
  tenantId: string,
  port: BookingPort,
  mediaPort: MediaLibraryPort,
  query: QuoteQuery,
  customerLevel: CustomerLevel | null,
  now: Date
): Promise<StorefrontQuoteOutcome> {
  const link = await readSellableLink(tx, tenantId, query.offeringId);
  if (!link) return { kind: "not_found" };
  const found = await port.getOffering(tx, {
    tenantId,
    offeringId: query.offeringId
  });
  if (!found.ok || !isSellableOffering(found.offering)) {
    return { kind: "not_found" };
  }
  const offering = found.offering;

  let nights: number | null = null;
  let quantity = 1;
  if (link.quantityBasis === "nights") {
    if (!query.stay) {
      return {
        kind: "invalid",
        errors: [
          {
            field: "checkInDate",
            message: "checkInDate and checkOutDate are required for a stay."
          }
        ]
      };
    }
    nights = nightsBetween(query.stay.checkInDate, query.stay.checkOutDate);
    if (nights === null) {
      return {
        kind: "invalid",
        errors: [
          { field: "checkOutDate", message: "The night count is not valid." }
        ]
      };
    }
    if (offering.minNights !== null && nights < offering.minNights) {
      return {
        kind: "invalid",
        errors: [
          {
            field: "checkOutDate",
            message: `The minimum stay is ${offering.minNights} nights.`
          }
        ]
      };
    }
    if (offering.maxNights !== null && nights > offering.maxNights) {
      return {
        kind: "invalid",
        errors: [
          {
            field: "checkOutDate",
            message: `The maximum stay is ${offering.maxNights} nights.`
          }
        ]
      };
    }
    quantity = nights;
  } else if (query.stay) {
    return {
      kind: "invalid",
      errors: [
        {
          field: "checkInDate",
          message: "This offering is booked by time slot, not by nights."
        }
      ]
    };
  }

  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: [
        {
          productId: link.productId,
          variantId: null,
          quantity,
          serviceFormValues: null
        }
      ],
      shipping: null,
      voucherCode: null,
      insurance: false,
      customerLevel,
      bookingSale: true
    },
    now
  );
  const line = quote.lines[0];
  if (!line || line.status === "unavailable") return { kind: "not_found" };

  const depositCents = quote.downPayment.available
    ? toCents(quote.downPayment.amount)
    : 0n;
  const totalCents = toCents(quote.total);
  return {
    kind: "ok",
    body: {
      offeringId: offering.offeringId,
      granularity: offering.granularity,
      nights,
      quantity,
      product: {
        name: line.name ?? offering.name,
        slug: line.slug,
        image: line.image
      },
      unitPrice: line.unitPrice,
      subtotal: quote.subtotal,
      tax: {
        active: quote.tax.active,
        percent: quote.tax.percent,
        amount: quote.tax.amount
      },
      total: quote.total,
      deposit: {
        available: quote.downPayment.available,
        amount: quote.downPayment.amount,
        balanceDue: fromCents(
          totalCents > depositCents ? totalCents - depositCents : 0n
        )
      },
      paymentMethods: quote.paymentMethods.map((method) => ({
        method: method.method,
        available: method.available
      })),
      canCheckout: quote.canCheckout,
      quotedAt: quote.quotedAt
    }
  };
}

// ---------------------------------------------------------------------------
// The shopper's own reservations
// ---------------------------------------------------------------------------

export const OWN_RESERVATIONS_DEFAULT_LIMIT = 20;
export const OWN_RESERVATIONS_MAX_LIMIT = 50;

export type OwnReservationItem = ReturnType<typeof reservationViewBody> & {
  productName: string;
  /** Nights of a stay (the order line's quantity), `null` for a slot. */
  nights: number | null;
  paymentMethod: string;
};

export type OwnReservationPage = {
  items: OwnReservationItem[];
  nextCursor: string | null;
};

type OwnLinkRow = {
  id: string;
  order_id: string;
  reservation_id: string;
  status: string;
  created_at_cursor: string;
  product_name: string;
  quantity: number;
  quantity_basis: string;
  payment_method: string;
};

/**
 * The signed-in customer's own reservations, newest first, keyset-paged. The
 * customer id is the server-resolved session's; a superseded link (a
 * reschedule's older half) is not listed, a released one is (the guest sees
 * "Penahanan habis" / "Dibatalkan", not a vanished row). Orders before the
 * account's `historyFrom` are not listed (ADR-0016 D4), exactly as the account
 * order list.
 */
export async function listOwnReservations(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  historyFrom: Date,
  cursor: KeysetCursor | null,
  limit: number
): Promise<OwnReservationPage> {
  const bounded = Math.min(
    Math.max(1, Math.trunc(limit)),
    OWN_RESERVATIONS_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT l.id, l.order_id, l.reservation_id, l.status,
           ${tx.unsafe(keysetCursorCreatedAtSql("l"))} AS created_at_cursor,
           oi.name AS product_name, oi.quantity,
           ol.quantity_basis, o.payment_method
    FROM awcms_commerce_booking_reservation_links l
    JOIN awcms_commerce_orders o
      ON o.tenant_id = l.tenant_id AND o.id = l.order_id
    JOIN awcms_commerce_order_items oi
      ON oi.tenant_id = l.tenant_id AND oi.id = l.order_item_id
    JOIN awcms_commerce_booking_offering_links ol
      ON ol.tenant_id = l.tenant_id AND ol.id = l.offering_link_id
    WHERE l.tenant_id = ${tenantId}
      AND o.customer_id = ${customerId}
      AND o.channel = 'storefront'
      AND o.deleted_at IS NULL
      AND o.created_at >= ${historyFrom}
      AND l.status <> 'superseded'
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (l.created_at, l.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${bounded}
  `) as OwnLinkRow[];

  const items: OwnReservationItem[] = [];
  for (const row of rows) {
    const view: BookingReservationView | null = await buildReservationView(
      tx,
      tenantId,
      {
        id: row.id,
        orderId: row.order_id,
        reservationId: row.reservation_id,
        status: row.status
      }
    );
    if (!view) continue;
    items.push({
      ...reservationViewBody(view, null),
      productName: row.product_name,
      nights: row.quantity_basis === "nights" ? row.quantity : null,
      paymentMethod: row.payment_method
    });
  }

  const last = rows[rows.length - 1];
  return {
    items,
    nextCursor:
      rows.length === bounded && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}
