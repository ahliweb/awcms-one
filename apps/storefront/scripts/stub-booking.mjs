/**
 * The booking half of `scripts/stub-awcms.mjs` (issue #386, ADR-0045): the
 * `/api/v1/commerce/storefront/booking/*` routes the `toko` booking pages call
 * from the browser, as a small STATE MACHINE (offerings -> availability ->
 * quote -> hold -> pay -> confirmed / expired) so `tests/e2e/booking.e2e.ts` can
 * prove the hold, the countdown, the expiry and the shopper's own list against
 * a real browser and a real build, without a CMS.
 *
 * Faithful to the CMS contract in what the pages depend on: nights and totals
 * are computed HERE (never by the page), the hold body carries `serverNow` and
 * `holdExpiresAt`, a refusal keeps its code (`SLOT_UNAVAILABLE`,
 * `HOLD_LIMIT_EXCEEDED`, `IDEMPOTENCY_CONFLICT`...), an unknown query key is a
 * `400`, availability never names a resource, and the own list shows only the
 * bearer's reservations. A reservation's status is DERIVED from its order on
 * every read (paid -> confirmed; unpaid past `holdExpiresAt` -> expired), the way
 * the real adapter reconciles Booking with the ledger.
 *
 * Fixed data lives in `tests/fixtures/awcms/booking.json`, which the e2e spec
 * imports too, so a date a test books is a date this stub treats as free,
 * blocked or full. `POST /stub/booking/control` (no CORS, test-only) shortens
 * the hold, expires every live hold now, or switches the `booking` feature off
 * (the neutral 404 the pages show as "Pemesanan tidak tersedia").
 */
import { readFileSync } from "node:fs";

const CONFIG = JSON.parse(
  readFileSync(new URL("../tests/fixtures/awcms/booking.json", import.meta.url), "utf8")
);

const DAY_MS = 86_400_000;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date) {
  if (typeof date !== "string" || !LOCAL_DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return Math.round(ms / DAY_MS);
}

function today() {
  return Math.floor(Date.now() / DAY_MS);
}

function toCents(price) {
  const [whole, fraction = ""] = String(price).split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function fromCents(cents) {
  const value = cents < 0n ? 0n : cents;
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/**
 * @param {{
 *   envelope: Function, envelopeError: Function, findAccountByBearer: Function,
 *   orders: Map<string, any>, generateOrderCode: () => string,
 *   storeSettings: () => any, normalizeEmail: (e: string) => string
 * }} deps
 */
export function createBookingStub(deps) {
  const { envelope, envelopeError, findAccountByBearer, orders, generateOrderCode, storeSettings } = deps;

  const control = { holdSeconds: CONFIG.holdSeconds, featureOff: false };
  /** orderCode -> reservation. */
  const reservations = new Map();
  /** namespaced idempotency key -> { fingerprint, orderCode }. */
  const keys = new Map();
  let sequence = 0;

  const offeringPublic = () => ({
    offeringId: CONFIG.offering.offeringId,
    granularity: "stay",
    quantityBasis: "nights",
    name: CONFIG.offering.name,
    slug: CONFIG.offering.slug,
    image: null,
    unitPrice: CONFIG.offering.unitPrice,
    minNights: CONFIG.offering.minNights,
    maxNights: CONFIG.offering.maxNights,
    minParty: CONFIG.offering.minParty,
    maxParty: CONFIG.offering.maxParty,
    durationSeconds: null,
    resourceIds: CONFIG.resourceIds
  });

  function unknownKeys(url, allowed) {
    return [...new Set(url.searchParams.keys())]
      .filter((key) => !allowed.includes(key))
      .map((field) => ({ field, message: `${field} is not a known parameter.` }));
  }

  function stayRange(checkIn, checkOut) {
    const from = dayNumber(checkIn);
    const to = dayNumber(checkOut);
    if (from === null || to === null || to <= from || to - from > 366) return null;
    return { from, to, nights: to - from };
  }

  /** Free units (0 or 1) of one resource over [from, to). */
  function freeUnits(resourceId, from, to) {
    const base = today();
    const full = base + CONFIG.fullOffsetDays;
    if (from <= full && full < to) return 0;
    if (resourceId === CONFIG.resourceIds[0]) {
      const blocked = base + CONFIG.firstResourceBlockedOffsetDays;
      if (from <= blocked && blocked < to) return 0;
    }
    for (const reservation of reservations.values()) {
      refresh(reservation);
      if (reservation.resourceId !== resourceId) continue;
      if (reservation.status !== "held" && reservation.status !== "confirmed") continue;
      if (reservation.fromDay < to && from < reservation.toDay) return 0;
    }
    return 1;
  }

  function settlementOf(reservation) {
    const order = orders.get(reservation.orderCode);
    const paid = order && order.status !== "pending_payment" && order.status !== "expired" && order.status !== "cancelled";
    const total = BigInt(reservation.totalCents);
    const deposit = reservation.paymentMethod === "dp" ? BigInt(reservation.depositCents) : total;
    const settled = paid ? deposit : 0n;
    const outstanding = total - settled;
    return {
      total: fromCents(total),
      paid: fromCents(settled),
      reversed: "0.00",
      settled: fromCents(settled),
      outstanding: fromCents(outstanding),
      overpaid: "0.00",
      paymentStatus: settled === 0n ? "unpaid" : outstanding === 0n ? "paid" : "dp_paid",
      deposit: fromCents(deposit),
      balanceDue: fromCents(outstanding),
      settledAt: settled === 0n ? null : reservation.settledAt ?? new Date().toISOString()
    };
  }

  /** Reconciles the reservation with its order: paid -> confirmed; unpaid past the hold -> expired. */
  function refresh(reservation) {
    const order = orders.get(reservation.orderCode);
    if (!order) return;
    if (reservation.status === "held") {
      if (order.status === "paid") {
        reservation.status = "confirmed";
        reservation.settledAt = order.paidAt ?? new Date().toISOString();
      } else if (order.status === "cancelled") {
        reservation.status = "cancelled";
        reservation.linkStatus = "released";
      } else if (new Date(reservation.holdExpiresAt).getTime() <= Date.now()) {
        reservation.status = "expired";
        reservation.linkStatus = "released";
        if (order.status === "pending_payment") {
          order.status = "expired";
          order.timeline.push({ status: "expired", at: new Date().toISOString(), note: "Penahanan habis." });
        }
      }
    }
  }

  function view(reservation) {
    refresh(reservation);
    return {
      serverNow: new Date().toISOString(),
      reservationId: reservation.reservationId,
      reservationNo: reservation.reservationNo,
      orderId: reservation.orderId,
      orderCode: reservation.orderCode,
      orderStatus: orders.get(reservation.orderCode)?.status ?? "pending_payment",
      status: reservation.status,
      linkStatus: reservation.linkStatus,
      holdExpiresAt: reservation.holdExpiresAt,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      settlement: settlementOf(reservation),
      refund: null
    };
  }

  function listItem(reservation) {
    return {
      ...view(reservation),
      productName: CONFIG.offering.name,
      nights: reservation.nights,
      paymentMethod: reservation.paymentMethod
    };
  }

  function notFound(headers) {
    return Response.json({ success: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404, headers });
  }

  /** `path` is relative to `/booking`. Returns a Response, or `null` for an unknown route. */
  async function handle(request, url, path, body, headers) {
    if (control.featureOff) return notFound(headers);
    const method = request.method;

    if (path === "/offerings" && method === "GET") {
      const extra = unknownKeys(url, []);
      if (extra.length > 0) return envelopeError(400, "VALIDATION_ERROR", "This route takes no query parameters.", extra, headers);
      return envelope({ items: [offeringPublic()] }, { headers });
    }

    if (path === "/availability" && method === "GET") {
      const errors = unknownKeys(url, ["offeringId", "resourceId", "checkInDate", "checkOutDate", "from", "to"]);
      const range = stayRange(url.searchParams.get("checkInDate"), url.searchParams.get("checkOutDate"));
      if (!range) errors.push({ field: "checkOutDate", message: "checkOutDate must be after checkInDate, at most 366 nights." });
      else if (range.from < today() - 1) errors.push({ field: "checkInDate", message: "checkInDate cannot be in the past." });
      if (errors.length > 0) return envelopeError(400, "VALIDATION_ERROR", "Invalid availability request.", errors, headers);
      if (url.searchParams.get("offeringId") !== CONFIG.offering.offeringId) return notFound(headers);

      const resourceId = url.searchParams.get("resourceId");
      const units = CONFIG.resourceIds.includes(resourceId) ? freeUnits(resourceId, range.from, range.to) : 0;
      const checkInDate = url.searchParams.get("checkInDate");
      const checkOutDate = url.searchParams.get("checkOutDate");
      return envelope(
        units > 0
          ? { mode: "stay", timezone: CONFIG.timezone, checkInDate, checkOutDate, nights: range.nights, available: true, freeUnits: units }
          : { mode: "stay", timezone: "UTC", checkInDate, checkOutDate, nights: null, available: false, freeUnits: 0, reason: "SLOT_UNAVAILABLE" },
        { headers }
      );
    }

    if (path === "/quote" && method === "GET") {
      const errors = unknownKeys(url, ["offeringId", "checkInDate", "checkOutDate"]);
      const range = stayRange(url.searchParams.get("checkInDate"), url.searchParams.get("checkOutDate"));
      if (!range) errors.push({ field: "checkOutDate", message: "checkOutDate must be after checkInDate, at most 366 nights." });
      else if (range.nights < CONFIG.offering.minNights || range.nights > CONFIG.offering.maxNights) {
        errors.push({ field: "checkOutDate", message: `The maximum stay is ${CONFIG.offering.maxNights} nights.` });
      }
      if (errors.length > 0) return envelopeError(400, "VALIDATION_ERROR", "Invalid quote request.", errors, headers);
      if (url.searchParams.get("offeringId") !== CONFIG.offering.offeringId) return notFound(headers);

      const totalCents = toCents(CONFIG.offering.unitPrice) * BigInt(range.nights);
      const depositCents = (totalCents * BigInt(CONFIG.depositPercent) + 50n) / 100n;
      const settings = storeSettings();
      return envelope(
        {
          offeringId: CONFIG.offering.offeringId,
          granularity: "stay",
          nights: range.nights,
          quantity: range.nights,
          product: { name: CONFIG.offering.name, slug: CONFIG.offering.slug, image: null },
          unitPrice: CONFIG.offering.unitPrice,
          subtotal: fromCents(totalCents),
          tax: { active: false, percent: 0, amount: "0.00" },
          total: fromCents(totalCents),
          deposit: { available: true, amount: fromCents(depositCents), balanceDue: fromCents(totalCents - depositCents) },
          paymentMethods: [
            { method: "gateway", available: Boolean(settings.payment?.gatewayEnabled) },
            { method: "dp", available: true },
            { method: "manual_bank", available: true },
            { method: "manual_qris", available: true }
          ],
          canCheckout: true,
          quotedAt: new Date().toISOString()
        },
        { headers }
      );
    }

    if (path === "/reservations" && method === "POST") return createReservation(request, body, headers);

    if (path === "/reservations" && method === "GET") {
      const account = findAccountByBearer(request);
      if (!account) return envelopeError(401, "UNAUTHENTICATED", "Missing, invalid, or expired session.", undefined, headers);
      const email = deps.normalizeEmail(account.email);
      const mine = [...reservations.values()]
        .filter((reservation) => reservation.accountEmail === email && reservation.linkStatus !== "superseded")
        .sort((a, b) => b.sequence - a.sequence);
      const limit = Math.min(Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20), 50);
      const cursorParam = url.searchParams.get("cursor");
      let start = 0;
      if (cursorParam) {
        const after = Number.parseInt(Buffer.from(cursorParam, "base64url").toString("utf8"), 10);
        if (!Number.isFinite(after)) return envelopeError(400, "VALIDATION_ERROR", "cursor is malformed.", undefined, headers);
        start = mine.findIndex((reservation) => reservation.sequence < after);
        if (start < 0) start = mine.length;
      }
      const page = mine.slice(start, start + limit);
      const nextCursor =
        page.length === limit && start + limit < mine.length
          ? Buffer.from(String(page[page.length - 1].sequence), "utf8").toString("base64url")
          : null;
      return envelope({ items: page.map(listItem), nextCursor }, { headers });
    }

    const byCode = /^\/reservations\/([^/]+)$/.exec(path);
    if (byCode && method === "GET") {
      const account = findAccountByBearer(request);
      const reservation = reservations.get(decodeURIComponent(byCode[1]));
      if (request.headers.get("authorization") && !account) {
        return envelopeError(401, "UNAUTHENTICATED", "Missing, invalid, or expired session.", undefined, headers);
      }
      if (!account || !reservation || reservation.accountEmail !== deps.normalizeEmail(account.email)) return notFound(headers);
      return envelope(view(reservation), { headers });
    }

    return null;
  }

  function createReservation(request, body, headers) {
    const authorization = request.headers.get("authorization");
    const account = findAccountByBearer(request);
    if (authorization && !account) {
      return envelopeError(401, "UNAUTHENTICATED", "Missing, invalid, or expired session.", undefined, headers);
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!idempotencyKey) {
      return envelopeError(400, "IDEMPOTENCY_REQUIRED", "Idempotency-Key header is required (1 to 255 characters).", undefined, headers);
    }

    const errors = [];
    const allowed = ["offeringId", "resourceId", "startsAt", "stay", "partySize", "guest", "payment", "notes"];
    for (const key of Object.keys(body ?? {})) {
      if (!allowed.includes(key)) errors.push({ field: key, message: `${key} is not a known field or is derived by the server.` });
    }
    const range = body?.stay ? stayRange(body.stay.checkInDate, body.stay.checkOutDate) : null;
    if (!range) errors.push({ field: "stay", message: "stay needs real local dates checkInDate < checkOutDate (YYYY-MM-DD)." });
    if (!account && !(body?.guest?.name && body?.guest?.phone)) {
      errors.push({ field: "guest", message: "guest is required without a session." });
    }
    const method = body?.payment?.method;
    if (!["gateway", "dp", "manual_bank", "manual_qris"].includes(method)) {
      errors.push({ field: "payment.method", message: "payment.method is required." });
    }
    if (errors.length > 0) return envelopeError(400, "VALIDATION_ERROR", "Invalid booking request.", errors, headers);

    const namespace = account ? `cust:${deps.normalizeEmail(account.email)}` : `anon:${body.guest.phone}`;
    const keyId = `${namespace}:${idempotencyKey}`;
    const fingerprint = JSON.stringify([body.offeringId, body.resourceId, body.stay, body.partySize, method, body.notes ?? null]);
    const prior = keys.get(keyId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return envelopeError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different request.", undefined, headers);
      }
      const reservation = reservations.get(prior.orderCode);
      return envelope({ ...createdBody(reservation), replayed: true }, { status: 200, headers });
    }

    if (body.offeringId !== CONFIG.offering.offeringId) {
      return envelopeError(409, "OFFERING_NOT_LINKED", "This offering is not linked to a product for sale.", undefined, headers);
    }
    if (!CONFIG.resourceIds.includes(body.resourceId)) {
      return envelopeError(404, "RESOURCE_NOT_FOUND", "Booking resource or offering not found.", undefined, headers);
    }
    if (range.nights < CONFIG.offering.minNights || range.nights > CONFIG.offering.maxNights) {
      return envelopeError(409, "STAY_MAX_NIGHTS", "Booking refused the request (STAY_MAX_NIGHTS).", undefined, headers);
    }
    if (account) {
      const email = deps.normalizeEmail(account.email);
      const live = [...reservations.values()].filter((reservation) => {
        refresh(reservation);
        return reservation.accountEmail === email && reservation.status === "held";
      });
      if (live.length >= CONFIG.maxLiveHolds) {
        return envelopeError(429, "HOLD_LIMIT_EXCEEDED", "Too many live holds. Complete or release one first.", undefined, headers);
      }
    }
    if (freeUnits(body.resourceId, range.from, range.to) === 0) {
      return envelopeError(409, "SLOT_UNAVAILABLE", "Booking refused the request (SLOT_UNAVAILABLE).", undefined, headers);
    }

    sequence += 1;
    const orderCode = generateOrderCode();
    const totalCents = toCents(CONFIG.offering.unitPrice) * BigInt(range.nights);
    const depositCents = (totalCents * BigInt(CONFIG.depositPercent) + 50n) / 100n;
    const now = new Date();
    const holdExpiresAt = new Date(now.getTime() + control.holdSeconds * 1000).toISOString();
    const createdAt = now.toISOString();
    const startsAt = new Date(range.from * DAY_MS + 7 * 3600_000).toISOString();
    const endsAt = new Date(range.to * DAY_MS + 5 * 3600_000).toISOString();
    const phone = account ? account.phone : body.guest.phone;
    const name = account ? account.name : body.guest.name;

    orders.set(orderCode, {
      orderCode,
      status: "pending_payment",
      paymentStatus: "unpaid",
      paymentMethod: method,
      shippingMethod: "self_pickup",
      shippingServiceName: null,
      customerName: name,
      customerEmail: account ? account.email : (body.guest.email ?? null),
      phone,
      address: null,
      lines: [
        {
          name: CONFIG.offering.name,
          variantName: null,
          sku: "BOOKING",
          quantity: range.nights,
          unitPrice: CONFIG.offering.unitPrice,
          lineTotal: fromCents(totalCents),
          image: null,
          serviceFormValues: null
        }
      ],
      subtotal: fromCents(totalCents),
      discount: "0.00",
      voucherCode: null,
      shippingCost: "0.00",
      insuranceFee: "0.00",
      tax: "0.00",
      total: fromCents(totalCents),
      paymentConfirmations: [],
      timeline: [{ status: "pending_payment", at: createdAt, note: null }],
      createdAt,
      expiresAt: holdExpiresAt,
      paidAt: null,
      cancelledAt: null,
      accountEmail: account ? deps.normalizeEmail(account.email) : null,
      booking: true
    });

    const reservation = {
      sequence,
      orderCode,
      orderId: crypto.randomUUID(),
      reservationId: crypto.randomUUID(),
      reservationNo: `RSV-${String(sequence).padStart(5, "0")}`,
      accountEmail: account ? deps.normalizeEmail(account.email) : null,
      resourceId: body.resourceId,
      fromDay: range.from,
      toDay: range.to,
      nights: range.nights,
      status: "held",
      linkStatus: "active",
      holdExpiresAt,
      startsAt,
      endsAt,
      paymentMethod: method,
      totalCents: totalCents.toString(),
      depositCents: depositCents.toString()
    };
    reservations.set(orderCode, reservation);
    keys.set(keyId, { fingerprint, orderCode });
    return envelope(createdBody(reservation), { status: 201, headers });
  }

  function createdBody(reservation) {
    const v = view(reservation);
    return {
      replayed: false,
      serverNow: v.serverNow,
      orderId: v.orderId,
      orderCode: v.orderCode,
      reservation: {
        id: v.reservationId,
        reservationNo: v.reservationNo,
        status: v.status,
        holdExpiresAt: v.holdExpiresAt,
        startsAt: v.startsAt,
        endsAt: v.endsAt
      },
      settlement: v.settlement
    };
  }

  /** `POST /stub/booking/control` - test-only; not under the storefront prefix, so no CORS and no tenant gate. */
  async function handleControl(request) {
    const body = await request.json().catch(() => ({}));
    if (typeof body.holdSeconds === "number" && body.holdSeconds > 0) control.holdSeconds = body.holdSeconds;
    if (typeof body.featureOff === "boolean") control.featureOff = body.featureOff;
    if (body.expireAll === true) {
      for (const reservation of reservations.values()) {
        if (reservation.status === "held") reservation.holdExpiresAt = new Date(Date.now() - 1000).toISOString();
      }
    }
    if (body.reset === true) {
      reservations.clear();
      keys.clear();
      control.holdSeconds = CONFIG.holdSeconds;
      control.featureOff = false;
    }
    return Response.json({ success: true, data: { ...control, reservations: reservations.size } });
  }

  return { handle, handleControl };
}
