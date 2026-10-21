/**
 * The POS side of the booking adapter: the till's lookup, the check-in, the
 * check-out and the balance payment (Issue #383, ADR-0045 D19,
 * `docs/booking-ux-flows.md` section 5; threat controls C-34, C-35, C-36).
 *
 * ## The POS writes no reservation state and no balance (C-36)
 *
 * - A check-in and a check-out are Booking's own transitions: this file asks
 *   `BookingPort.checkIn` / `checkOut` (idempotent; the guarded transition is
 *   Booking's) and records an audit row. It stores no status of its own.
 * - The balance is READ from the order and its payment ledger under the order
 *   row's lock; the service-line price is the order line the product priced. The
 *   request carries neither (the validators refuse a `price` or a `balance`).
 * - Taking the balance is the EXISTING payment path: `planTenders` (explicit
 *   tenders, change for cash, split tenders) and `recordPaymentAllocation` (the
 *   ledger primitive every payment uses: order locked, overpayment refused,
 *   stored-value legs drawn in the same transaction, the order released at its
 *   threshold, the `order.settled` event). No new money mechanism exists here.
 *
 * ## Bound to the actor's own OPEN register session (C-35, ADR-0028)
 *
 * The three writes name a register; the register must have an OPEN session whose
 * current cashier is the actor (`gateSaleToRegisterSession`, which locks the
 * session row `FOR SHARE` for the rest of the transaction, so a close cannot slip
 * in between). The balance legs are STAMPED with that session, so the money is in
 * that shift's cash-up and per-register tender report: a cashier who pockets it
 * shows as a variance. A booking order is a storefront order and has no session
 * of its own; `sql/1046` lets exactly that case be stamped.
 *
 * ## The lookup is not an oracle (C-34)
 *
 * Exact code plus exact customer identifier in ONE statement; the same `null`
 * for an unknown code, a code whose customer is somebody else and another
 * tenant's; a per-actor lookup rate and a per-actor MISS budget; every lookup
 * (hit, miss, throttled) is audited with a keyed digest of the identifier, never
 * the identifier itself; the contact in the answer is always masked.
 *
 * ## One transaction, refusals as values (ADR-0045 G2)
 *
 * A business refusal is RETURNED, never thrown, and a refusal writes nothing the
 * caller has to undo. The payment legs run in a savepoint, so a defect part-way
 * through a split payment leaves no leg behind. The route maps a refusal to its
 * HTTP code after the work.
 */
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord,
  userIdempotencyActor
} from "../../_shared/idempotency";
import type { BookingPort } from "../../_shared/ports/booking-port";
import {
  checkSharedRateLimit,
  refundSharedRateLimit
} from "../../../lib/security/rate-limit";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  BALANCE_COLLECTABLE_STATUSES,
  BALANCE_RECORDABLE_ORDER_STATUSES,
  checkInBlockedByBalance,
  POS_BOOKING_BALANCE_AUDIT_ACTION,
  POS_BOOKING_CHECK_IN_AUDIT_ACTION,
  POS_BOOKING_CHECK_OUT_AUDIT_ACTION,
  POS_BOOKING_LOOKUP_AUDIT_ACTION,
  POS_BOOKING_NOT_SESSION_CASHIER_AUDIT_ACTION,
  POS_LOOKUPS_PER_MINUTE,
  POS_LOOKUP_MISSES_PER_WINDOW,
  POS_LOOKUP_MISS_WINDOW_MS,
  posCardActions,
  type PosBalancePaymentRequest,
  type PosBookingRefusal,
  type PosCardActions,
  type PosLookupRequest
} from "../domain/booking-pos";
import { FeatureDisabledError } from "../domain/commerce-features";
import {
  planTenders,
  type PlannedTender,
  type SettlementView
} from "../domain/payment-allocation";
import { maskPhone } from "../domain/phone-normalisation";
import { fromCents, toCents } from "../domain/price-calculation";
import { maskEmail } from "../domain/segment";
import { isStoredValueTender } from "../domain/stored-value";
import { fetchCheckInRequiresSettlement } from "./booking-adapter-settings";
import {
  buildReservationView,
  type BookingReservationView
} from "./booking-hold-to-order";
import {
  fetchReservationLinkByReservationId,
  type ReservationLinkSummary
} from "./booking-reservation-links";
import {
  findReservationLinkForPosLookup,
  readBookingReservation,
  type PosLookupMatch
} from "./booking-reservation-reads";
import { fetchCommerceFeatures } from "./commerce-feature-gate";
import { makeOrderRelease } from "./order-directory";
import {
  fetchOrderPaymentSummary,
  lockOrderForSettlement,
  recordPaymentAllocation
} from "./payment-allocation-directory";
import { gateSaleToRegisterSession } from "./register-session-directory";
import {
  preflightStoredValueLegs,
  redactTendersForHash,
  resolveStoredValueAccounts
} from "./stored-value-tender";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "commerce_booking_reservation_link";

const CHECK_IN_SCOPE = "commerce.booking_pos.check_in";
const CHECK_OUT_SCOPE = "commerce.booking_pos.check_out";
const BALANCE_SCOPE = "commerce.booking_pos.balance";

export type PosContext = {
  tenantId: string;
  /** The cashier: the authenticated staff member, never a body field. */
  actorTenantUserId: string;
  correlationId: string;
  port: BookingPort;
  /** The request's clock; tests pass one. */
  now?: Date;
};

// ---------------------------------------------------------------------------
// The reservation card
// ---------------------------------------------------------------------------

export type PosReservationCard = {
  reservationId: string;
  reservationNo: string;
  status: string;
  linkStatus: string;
  holdExpiresAt: string | null;
  startsAt: string;
  endsAt: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  /** The contact is ALWAYS masked at the till. */
  guest: { name: string; phoneMasked: string; emailMasked: string | null };
  /** The order line the product priced (read, never typed). `null` if the line is gone. */
  serviceLine: {
    name: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  } | null;
  /** Read from the ledger. `balanceDue` is the figure the tender entry is held to. */
  settlement: {
    total: string;
    paid: string;
    deposit: string;
    balanceDue: string;
    paymentStatus: string;
  };
  policy: { checkInRequiresSettlement: boolean };
  actions: PosCardActions;
};

async function readServiceLine(
  tx: Bun.SQL,
  tenantId: string,
  orderItemId: string
): Promise<PosReservationCard["serviceLine"]> {
  const rows = (await tx`
    SELECT name, quantity, unit_price, line_total
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND id = ${orderItemId}
  `) as {
    name: string;
    quantity: number;
    unit_price: string;
    line_total: string;
  }[];
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    quantity: Number(row.quantity),
    unitPrice: fromCents(toCents(String(row.unit_price))),
    lineTotal: fromCents(toCents(String(row.line_total)))
  };
}

function settlementFields(view: BookingReservationView) {
  const s: SettlementView = view.settlement;
  return {
    total: s.total,
    paid: s.settled,
    deposit: s.deposit ?? s.total,
    balanceDue: s.balanceDue ?? s.outstanding,
    paymentStatus: s.paymentStatus
  };
}

async function buildCard(
  tx: Bun.SQL,
  tenantId: string,
  match: PosLookupMatch,
  requiresSettlement: boolean
): Promise<PosReservationCard | null> {
  const view = await buildReservationView(tx, tenantId, {
    id: match.linkId,
    orderId: match.orderId,
    reservationId: match.reservationId,
    status: match.linkStatus
  });
  if (!view) return null;
  const settlement = settlementFields(view);
  return {
    reservationId: view.reservationId,
    reservationNo: view.reservationNo,
    status: view.status,
    linkStatus: view.linkStatus,
    holdExpiresAt: view.holdExpiresAt,
    startsAt: view.startsAt,
    endsAt: view.endsAt,
    orderId: view.orderId,
    orderCode: view.orderCode,
    orderStatus: view.orderStatus,
    guest: {
      name: match.guestName,
      phoneMasked: maskPhone(match.guestPhone),
      emailMasked: match.guestEmail ? maskEmail(match.guestEmail) : null
    },
    serviceLine: await readServiceLine(tx, tenantId, match.orderItemId),
    settlement,
    policy: { checkInRequiresSettlement: requiresSettlement },
    actions: posCardActions({
      linkStatus: view.linkStatus,
      reservationStatus: view.status,
      orderStatus: view.orderStatus,
      outstandingCents: toCents(settlement.balanceDue),
      requiresSettlement
    })
  };
}

// ---------------------------------------------------------------------------
// Lookup (C-34)
// ---------------------------------------------------------------------------

export type PosLookupResult =
  | { kind: "found"; card: PosReservationCard }
  | { kind: "miss" }
  | { kind: "throttled"; retryAfterSec: number };

/** The audit digest of what the cashier typed: keyed, truncated, never the identifier. */
function identifierDigest(
  tenantId: string,
  identifier: PosLookupRequest["identifier"]
): string {
  return computeRequestHash({
    scope: "booking-pos-lookup",
    tenantId,
    kind: identifier.kind,
    value: identifier.value
  }).slice(0, 16);
}

/**
 * Looks one reservation up by its exact code and the customer's exact phone or
 * e-mail. See the header: a hit, a miss and a throttled attempt are all audited;
 * a miss costs a unit of the actor's miss budget (a hit gives it back), so
 * guessing is stopped after a handful of wrong tries. The route answers a miss
 * with ONE neutral response whatever the reason.
 */
export async function lookupBookingForPos(
  tx: Bun.SQL,
  ctx: Pick<PosContext, "tenantId" | "actorTenantUserId" | "correlationId">,
  request: PosLookupRequest
): Promise<PosLookupResult> {
  const { tenantId, actorTenantUserId } = ctx;
  const rateKey = `commerce:booking:pos-lookup:${tenantId}:${actorTenantUserId}`;
  const missKey = `${rateKey}:misses`;
  const missConfig = {
    maxAttempts: POS_LOOKUP_MISSES_PER_WINDOW,
    windowMs: POS_LOOKUP_MISS_WINDOW_MS
  };
  const base = {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: POS_BOOKING_LOOKUP_AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    correlationId: ctx.correlationId
  } as const;
  const typed = {
    reservationNo: request.reservationNo,
    identifierKind: request.identifier.kind,
    identifierDigest: identifierDigest(tenantId, request.identifier)
  };

  // Only the FIRST throttle of a window is audited (security audit of PR #443,
  // L3): a client hammering a throttled endpoint must not turn the audit log
  // into the amplifier. The limiter itself decides which one is first - a
  // one-attempt bucket of the same window length per kind of throttle - so the
  // choice is as shared across replicas as the limiter is (with Redis down it
  // fails open and every throttle is audited: more rows, never fewer).
  const throttled = async (
    kind: "rate" | "misses",
    retryAfterSec: number
  ): Promise<PosLookupResult> => {
    const first = await checkSharedRateLimit(
      `${rateKey}:throttle-audit:${kind}`,
      {
        maxAttempts: 1,
        windowMs: kind === "rate" ? 60_000 : POS_LOOKUP_MISS_WINDOW_MS
      }
    );
    if (first.allowed) {
      await recordAuditEvent(tx, {
        ...base,
        severity: "warning",
        message: "Booking lookup at the till refused: too many lookups.",
        attributes: { outcome: "throttled", throttle: kind, ...typed }
      });
    }
    return { kind: "throttled", retryAfterSec };
  };
  const perMinute = await checkSharedRateLimit(rateKey, {
    maxAttempts: POS_LOOKUPS_PER_MINUTE,
    windowMs: 60_000
  });
  if (!perMinute.allowed) return throttled("rate", perMinute.retryAfterSec);
  // A lookup is charged to the miss budget up front and the unit is given back
  // on a hit, so only wrong guesses are held to the (small) budget.
  const budget = await checkSharedRateLimit(missKey, missConfig);
  if (!budget.allowed) return throttled("misses", budget.retryAfterSec);

  const match = await findReservationLinkForPosLookup(
    tx,
    tenantId,
    request.reservationNo,
    request.identifier
  );
  if (!match) {
    await recordAuditEvent(tx, {
      ...base,
      severity: "warning",
      message: "Booking lookup at the till found nothing.",
      attributes: { outcome: "miss", ...typed }
    });
    return { kind: "miss" };
  }

  const requiresSettlement = await fetchCheckInRequiresSettlement(tx, tenantId);
  const card = await buildCard(tx, tenantId, match, requiresSettlement);
  if (!card) {
    // The link's reservation or order vanished between the two reads: a miss.
    await recordAuditEvent(tx, {
      ...base,
      severity: "warning",
      message: "Booking lookup at the till found nothing.",
      attributes: { outcome: "miss", ...typed }
    });
    return { kind: "miss" };
  }

  // A hit gives its unit of the miss budget back.
  await refundSharedRateLimit(missKey, missConfig);
  await recordAuditEvent(tx, {
    ...base,
    resourceId: match.linkId,
    message: "Booking reservation looked up at the till.",
    attributes: {
      outcome: "hit",
      ...typed,
      reservationId: card.reservationId,
      orderId: card.orderId,
      reservationStatus: card.status,
      balanceDue: card.settlement.balanceDue
    }
  });
  return { kind: "found", card };
}

// ---------------------------------------------------------------------------
// Shared pieces of the three writes
// ---------------------------------------------------------------------------

type Refused = { kind: "refused"; refusal: PosBookingRefusal };
const refuse = (refusal: PosBookingRefusal): Refused => ({
  kind: "refused",
  refusal
});

/** Two concurrent calls with one key queue here, so the second finds the first's committed record and replays it. */
async function lockIdempotencyKey(
  tx: Bun.SQL,
  tenantId: string,
  scope: string,
  actorTenantUserId: string,
  key: string
): Promise<void> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${scope}:${actorTenantUserId}:${key}`}, 0))
  `;
}

type ReplayCheck =
  | { kind: "none" }
  | { kind: "replay"; body: Record<string, unknown> }
  | Refused;

async function checkReplay(
  tx: Bun.SQL,
  ctx: PosContext,
  scope: string,
  key: string,
  requestHash: string
): Promise<ReplayCheck> {
  await lockIdempotencyKey(tx, ctx.tenantId, scope, ctx.actorTenantUserId, key);
  const existing = await findIdempotencyRecord(
    tx,
    ctx.tenantId,
    scope,
    key,
    userIdempotencyActor(ctx.actorTenantUserId)
  );
  if (!existing) return { kind: "none" };
  if (existing.requestHash !== requestHash) {
    return refuse({ code: "IDEMPOTENCY_CONFLICT" });
  }
  return {
    kind: "replay",
    body: {
      ...(existing.responseBody as Record<string, unknown>),
      replayed: true
    }
  };
}

/**
 * The register must have an OPEN session whose current cashier is the actor; the
 * session is locked FOR SHARE to the end of the transaction.
 *
 * A refusal because the actor is NOT the session's cashier is the one refusal
 * that is also an event: somebody tried to ring money (or a stay) into another
 * cashier's register. It is audited at `warning` and the row COMMITS even though
 * the write is refused - the route returns a refusal as a `Response`, which does
 * not roll the transaction back (the same way a lookup miss keeps its audit row).
 * The row carries the register, the attempted operation and the reservation id as
 * typed, never anything of the customer.
 */
async function gateTillSession(
  tx: Bun.SQL,
  ctx: PosContext,
  registerId: string,
  attempt: { operation: string; reservationId: string }
): Promise<{ kind: "ok"; sessionId: string } | Refused> {
  const gate = await gateSaleToRegisterSession(
    tx,
    ctx.tenantId,
    registerId,
    ctx.actorTenantUserId
  );
  switch (gate.kind) {
    case "ok":
      return { kind: "ok", sessionId: gate.sessionId };
    case "register_not_found":
      return refuse({ code: "REGISTER_NOT_FOUND" });
    case "no_open_session":
      return refuse({ code: "REGISTER_SESSION_REQUIRED" });
    case "session_closing":
      return refuse({ code: "REGISTER_SESSION_CLOSING" });
    case "not_session_cashier":
      await recordAuditEvent(tx, {
        tenantId: ctx.tenantId,
        actorTenantUserId: ctx.actorTenantUserId,
        moduleKey: AUDIT_MODULE_KEY,
        action: POS_BOOKING_NOT_SESSION_CASHIER_AUDIT_ACTION,
        resourceType: "commerce_register",
        resourceId: registerId,
        severity: "warning",
        message:
          "Booking till write refused: the actor is not the cashier of the register's open session.",
        attributes: {
          outcome: "refused",
          operation: attempt.operation,
          registerId,
          reservationId: attempt.reservationId
        },
        correlationId: ctx.correlationId
      });
      return refuse({ code: "NOT_SESSION_CASHIER" });
  }
}

/** The ACTIVE link of a Booking reservation id; an unknown id and another tenant's are one `404`. */
async function resolveActiveLink(
  tx: Bun.SQL,
  tenantId: string,
  reservationId: string
): Promise<{ kind: "ok"; link: ReservationLinkSummary } | Refused> {
  const link = await fetchReservationLinkByReservationId(
    tx,
    tenantId,
    reservationId
  );
  if (!link) return refuse({ code: "RESERVATION_NOT_FOUND" });
  if (link.status !== "active") {
    return refuse({ code: "INVALID_STATE", reason: `link_${link.status}` });
  }
  return { kind: "ok", link };
}

async function saveReplayRecord(
  tx: Bun.SQL,
  ctx: PosContext,
  scope: string,
  key: string,
  requestHash: string,
  body: unknown
): Promise<void> {
  await saveIdempotencyRecord(
    tx,
    ctx.tenantId,
    scope,
    key,
    userIdempotencyActor(ctx.actorTenantUserId),
    requestHash,
    200,
    body
  );
}

// ---------------------------------------------------------------------------
// Check-in and check-out (C-35, C-36)
// ---------------------------------------------------------------------------

export type PosStayInput = {
  reservationId: string;
  registerId: string;
  idempotencyKey: string;
};

export type PosStayBody = {
  replayed: boolean;
  reservation: { id: string; reservationNo: string; status: string };
  /** What was still owed when the guest was checked in or out (an allowed check-in with a balance is visible). */
  balanceDue: string;
  registerSessionId: string;
};

export type PosStayResult =
  { kind: "done" | "replayed"; body: PosStayBody } | Refused;

async function changeStay(
  tx: Bun.TransactionSQL,
  ctx: PosContext,
  input: PosStayInput,
  verb: "check_in" | "check_out"
): Promise<PosStayResult> {
  const { tenantId, actorTenantUserId } = ctx;
  const scope = verb === "check_in" ? CHECK_IN_SCOPE : CHECK_OUT_SCOPE;
  const requestHash = computeRequestHash({
    scope,
    actor: actorTenantUserId,
    reservationId: input.reservationId,
    registerId: input.registerId
  });

  const replay = await checkReplay(
    tx,
    ctx,
    scope,
    input.idempotencyKey,
    requestHash
  );
  if (replay.kind === "refused") return replay;
  if (replay.kind === "replay") {
    return { kind: "replayed", body: replay.body as PosStayBody };
  }

  const session = await gateTillSession(tx, ctx, input.registerId, {
    operation: verb,
    reservationId: input.reservationId
  });
  if (session.kind === "refused") return session;

  const resolved = await resolveActiveLink(tx, tenantId, input.reservationId);
  if (resolved.kind === "refused") return resolved;
  const { link } = resolved;

  // The order row is locked first (the lock a payment, a cancel and a reschedule
  // take), so a balance collected a moment ago is visible and a concurrent one
  // queues behind this check.
  const header = await lockOrderForSettlement(tx, tenantId, link.orderId);
  if (!header) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const summary = await fetchOrderPaymentSummary(tx, tenantId, link.orderId);
  if (!summary) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const outstanding =
    summary.settlement.balanceDue ?? summary.settlement.outstanding;

  const facts = await readBookingReservation(tx, tenantId, link.reservationId);
  if (!facts) return refuse({ code: "RESERVATION_NOT_FOUND" });

  const expected = verb === "check_in" ? "confirmed" : "checked_in";
  const target = verb === "check_in" ? "checked_in" : "completed";
  if (facts.status !== expected && facts.status !== target) {
    // Booking would refuse too; the current status makes the message useful.
    return refuse({ code: "INVALID_STATE", reason: facts.status });
  }

  let requiresSettlement = false;
  if (verb === "check_in" && facts.status === expected) {
    requiresSettlement = await fetchCheckInRequiresSettlement(tx, tenantId);
    if (
      checkInBlockedByBalance({
        requiresSettlement,
        outstandingCents: toCents(outstanding)
      })
    ) {
      return refuse({ code: "BALANCE_NOT_SETTLED", outstanding });
    }
  }

  const targeted = {
    tenantId,
    reservationId: link.reservationId,
    // Derived from the LINK, never from client input (G5): a second attempt
    // finds the state already reached and is a harmless replay.
    idempotencyKey: `commerce-booking-pos-${verb}:${link.id}`,
    correlationId: ctx.correlationId,
    actorTenantUserId
  };
  const outcome =
    verb === "check_in"
      ? await ctx.port.checkIn(tx, targeted)
      : await ctx.port.checkOut(tx, targeted);
  if (!outcome.ok) {
    return refuse({ code: "BOOKING", reason: outcome.reason });
  }

  const body: PosStayBody = {
    replayed: outcome.replayed,
    reservation: {
      id: link.reservationId,
      reservationNo: facts.reservationNo,
      status: outcome.status
    },
    balanceDue: outstanding,
    registerSessionId: session.sessionId
  };

  if (!outcome.replayed) {
    await recordAuditEvent(tx, {
      tenantId,
      actorTenantUserId,
      moduleKey: AUDIT_MODULE_KEY,
      action:
        verb === "check_in"
          ? POS_BOOKING_CHECK_IN_AUDIT_ACTION
          : POS_BOOKING_CHECK_OUT_AUDIT_ACTION,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: link.id,
      severity: "info",
      message:
        verb === "check_in"
          ? "Booking guest checked in at the till."
          : "Booking guest checked out at the till.",
      attributes: {
        reservationId: link.reservationId,
        reservationNo: facts.reservationNo,
        orderId: link.orderId,
        registerId: input.registerId,
        registerSessionId: session.sessionId,
        balanceDue: outstanding,
        // The evidence of the tenant policy at the moment (D19): an ALLOWED
        // check-in with a balance owed says so.
        ...(verb === "check_in"
          ? {
              checkInRequiresSettlement: requiresSettlement,
              balanceWaived: toCents(outstanding) > 0n
            }
          : {})
      },
      correlationId: ctx.correlationId
    });
  }
  await saveReplayRecord(
    tx,
    ctx,
    scope,
    input.idempotencyKey,
    requestHash,
    body
  );
  return { kind: outcome.replayed ? "replayed" : "done", body };
}

/** Checks a confirmed guest in. D19: refused with `BALANCE_NOT_SETTLED` while a balance is owed AND the tenant requires settlement. */
export function checkInAtPos(
  tx: Bun.TransactionSQL,
  ctx: PosContext,
  input: PosStayInput
): Promise<PosStayResult> {
  return changeStay(tx, ctx, input, "check_in");
}

/** Checks a checked-in guest out. */
export function checkOutAtPos(
  tx: Bun.TransactionSQL,
  ctx: PosContext,
  input: PosStayInput
): Promise<PosStayResult> {
  return changeStay(tx, ctx, input, "check_out");
}

// ---------------------------------------------------------------------------
// The balance payment (C-35, C-36)
// ---------------------------------------------------------------------------

export type PosBalanceInput = PosBalancePaymentRequest & {
  reservationId: string;
  idempotencyKey: string;
};

export type PosBalanceBody = {
  replayed: boolean;
  reservation: { id: string; reservationNo: string; status: string };
  orderId: string;
  orderCode: string;
  /** What was owed when the cashier started, from the ledger. */
  balanceBefore: string;
  /** The legs written, in order. A cash leg shows what was handed over and the change. */
  payments: {
    id: string;
    tenderType: string;
    amount: string;
    tenderedAmount: string | null;
    changeAmount: string | null;
  }[];
  /** Cash change to hand back, `null` when no cash leg. */
  change: string | null;
  settlement: SettlementView;
  registerSessionId: string;
};

export type PosBalanceResult =
  { kind: "collected" | "replayed"; body: PosBalanceBody } | Refused;

/**
 * Takes (part of) the outstanding balance of a reservation's order at the till.
 *
 * @throws {InvalidTenderPlanError | OverpaymentError | FeatureDisabledError} and
 *   the stored-value tender errors, all raised BEFORE any leg is written (the
 *   route maps them as the POS sale does).
 */
export async function collectBalanceAtPos(
  tx: Bun.TransactionSQL,
  ctx: PosContext,
  input: PosBalanceInput
): Promise<PosBalanceResult> {
  const { tenantId, actorTenantUserId } = ctx;
  const requestHash = computeRequestHash({
    scope: BALANCE_SCOPE,
    actor: actorTenantUserId,
    reservationId: input.reservationId,
    registerId: input.registerId,
    // The plaintext stored-value code never enters the hash.
    tenders: redactTendersForHash(tenantId, input.tenders)
  });

  const replay = await checkReplay(
    tx,
    ctx,
    BALANCE_SCOPE,
    input.idempotencyKey,
    requestHash
  );
  if (replay.kind === "refused") return replay;
  if (replay.kind === "replay") {
    return { kind: "replayed", body: replay.body as PosBalanceBody };
  }

  const session = await gateTillSession(tx, ctx, input.registerId, {
    operation: "balance",
    reservationId: input.reservationId
  });
  if (session.kind === "refused") return session;

  const resolved = await resolveActiveLink(tx, tenantId, input.reservationId);
  if (resolved.kind === "refused") return resolved;
  const { link } = resolved;

  const facts = await readBookingReservation(tx, tenantId, link.reservationId);
  if (!facts) return refuse({ code: "RESERVATION_NOT_FOUND" });
  if (!BALANCE_COLLECTABLE_STATUSES.has(facts.status)) {
    return refuse({ code: "INVALID_STATE", reason: facts.status });
  }
  // A hold that has lapsed is not a reservation any more: the sweep has only
  // not run yet. Money must not be taken at the till for capacity that may
  // already be gone (a payment after expiry is a late-payment case for staff).
  if (
    facts.status === "held" &&
    facts.holdExpiresAt !== null &&
    Date.parse(facts.holdExpiresAt) <= (ctx.now ?? new Date()).getTime()
  ) {
    return refuse({ code: "INVALID_STATE", reason: "hold_expired" });
  }

  // The balance is READ here, under the order row's lock, from the ledger. It is
  // what the tenders are planned against and what they are held to.
  const header = await lockOrderForSettlement(tx, tenantId, link.orderId);
  if (!header) return refuse({ code: "RESERVATION_NOT_FOUND" });
  if (
    !(BALANCE_RECORDABLE_ORDER_STATUSES as readonly string[]).includes(
      header.status
    )
  ) {
    return refuse({ code: "ORDER_NOT_PAYABLE", orderStatus: header.status });
  }
  const before = await fetchOrderPaymentSummary(tx, tenantId, link.orderId);
  if (!before) return refuse({ code: "RESERVATION_NOT_FOUND" });
  const balanceBefore = before.settlement.outstanding;
  if (toCents(balanceBefore) <= 0n) return refuse({ code: "NO_BALANCE_DUE" });

  // Explicit tenders, change for cash, split tenders: the POS planner. A due
  // remainder is allowed (a part-payment); anything above the balance is not.
  const plan = planTenders(balanceBefore, input.tenders, { allowDue: true });

  // Stored-value tenders are resolved (throttled) and their accounts locked and
  // checked before the first leg exists - order lock first, then accounts.
  const storedValueLegs = plan.legs.flatMap((leg, index) =>
    isStoredValueTender(leg.tenderType) && leg.storedValueCode
      ? [{ index, leg, code: leg.storedValueCode }]
      : []
  );
  const accountByLeg = new Map<number, string>();
  if (storedValueLegs.length > 0) {
    const features = await fetchCommerceFeatures(tx, tenantId);
    if (!features.storedValue) throw new FeatureDisabledError("storedValue");
    const accountIds = await resolveStoredValueAccounts(
      tx,
      tenantId,
      actorTenantUserId,
      storedValueLegs.map(({ leg, code }) => ({
        tenderType: leg.tenderType as "gift_card" | "store_credit",
        code
      }))
    );
    storedValueLegs.forEach(({ index }, position) => {
      accountByLeg.set(index, accountIds[position]!);
    });
    await preflightStoredValueLegs(
      tx,
      tenantId,
      storedValueLegs.map(({ index, leg }) => ({
        accountId: accountByLeg.get(index)!,
        tenderType: leg.tenderType as "gift_card" | "store_credit",
        amount: leg.amount
      }))
    );
  }

  // The source key is the ledger's own dedupe key, shared by the whole tenant
  // (security audit of PR #443, L2): it must name the ACTOR (and the register
  // session) as well as the client's Idempotency-Key. The replay record is
  // already per actor; without the actor here two cashiers who happened to send
  // the same header would find each other's legs and answer `deduplicated` with
  // an allocation that is not theirs.
  const keyDigest = computeRequestHash({
    key: input.idempotencyKey,
    actor: actorTenantUserId,
    registerSessionId: session.sessionId
  }).slice(0, 40);
  // The legs are written together or not at all: a defect after the first leg of
  // a split payment rolls the whole payment back to here.
  const payments = await tx.savepoint(async (sp) => {
    const release = makeOrderRelease(
      sp as Bun.TransactionSQL,
      tenantId,
      "admin",
      actorTenantUserId,
      link.orderId,
      ctx.correlationId
    );
    const rows: PosBalanceBody["payments"] = [];
    for (const [index, leg] of plan.legs.entries()) {
      const outcome = await recordPaymentAllocation(sp, tenantId, {
        orderId: link.orderId,
        tenderType: leg.tenderType,
        amount: leg.amount,
        providerReference: leg.reference,
        tenderedAmount: leg.tenderedAmount,
        changeAmount: leg.changeAmount,
        storedValueAccountId: accountByLeg.get(index) ?? null,
        source: "pos",
        sourceKey: `posbal:${link.id}:${keyDigest}:${index}`,
        actor: { kind: "tenant_user", tenantUserId: actorTenantUserId },
        enforceNoOverpayment: true,
        allowedOrderStatuses: BALANCE_RECORDABLE_ORDER_STATUSES,
        release,
        releaseNote: "Booking balance paid at the register.",
        correlationId: ctx.correlationId,
        // The till's open session, so the shift's cash-up counts the money.
        registerSessionId: session.sessionId
      });
      if (outcome.kind !== "recorded" && outcome.kind !== "deduplicated") {
        // Unreachable under the locks held above; throw (never return) so the
        // savepoint rolls the earlier legs back.
        throw new Error(
          `A booking balance leg was refused after the checks (${outcome.kind}).`
        );
      }
      rows.push({
        id: outcome.allocation.id,
        tenderType: outcome.allocation.tenderType,
        amount: outcome.allocation.amount,
        tenderedAmount: outcome.allocation.tenderedAmount,
        changeAmount: outcome.allocation.changeAmount
      });
    }
    return rows;
  });

  const after = await fetchOrderPaymentSummary(tx, tenantId, link.orderId);
  const settlement = after!.settlement;

  const body: PosBalanceBody = {
    replayed: false,
    reservation: {
      id: link.reservationId,
      reservationNo: facts.reservationNo,
      status: facts.status
    },
    orderId: link.orderId,
    orderCode: header.orderCode,
    balanceBefore,
    payments,
    change: plan.changeAmount,
    settlement,
    registerSessionId: session.sessionId
  };

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: POS_BOOKING_BALANCE_AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: link.id,
    severity: "info",
    message: `Booking balance collected at the till (${plan.legs.map((leg: PlannedTender) => leg.tenderType).join(" + ")}).`,
    attributes: {
      reservationId: link.reservationId,
      reservationNo: facts.reservationNo,
      orderId: link.orderId,
      orderCode: header.orderCode,
      registerId: input.registerId,
      registerSessionId: session.sessionId,
      balanceBefore,
      balanceAfter: settlement.outstanding,
      tenders: plan.legs.map((leg: PlannedTender) => ({
        tenderType: leg.tenderType,
        amount: leg.amount
      })),
      change: plan.changeAmount
    },
    correlationId: ctx.correlationId
  });

  await saveReplayRecord(
    tx,
    ctx,
    BALANCE_SCOPE,
    input.idempotencyKey,
    requestHash,
    body
  );
  return { kind: "collected", body };
}
