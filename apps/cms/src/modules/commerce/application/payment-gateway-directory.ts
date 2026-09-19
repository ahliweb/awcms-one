/**
 * `awcms_commerce_payment_gateway_sessions` persistence — Issue #110
 * (contract #106's D3). The one place this module ever calls a
 * `PaymentGatewayProvider` (`../domain/payment-gateway-provider.ts`).
 *
 * ## The transaction discipline this file exists to enforce
 *
 * ADR-0006/0010/ADR-0017 D1: an external provider call must never run
 * inside an open DB transaction. `createGatewaySession` follows the same
 * three-step shape `shipping-rate-directory.ts`'s `resolveDestination`/
 * `getCourierRates` already established for this module: validate + check
 * for a reusable session in one short `withTenantOrThrow` transaction, call
 * the provider with NO transaction open, then persist the result in a
 * SECOND short transaction. Both transactions take the raw pool client
 * (`sql: Bun.SQL`), never a caller's already-open `tx` — the same reason
 * `createGatewaySession`'s own signature matches contract #106's literal
 * `(sql, tenantId, orderCode, auth)`.
 *
 * ## Idempotency
 *
 * Two independent guards, for two independent failure modes:
 *
 * 1. SEQUENTIAL double-create (the shopper double-clicks "Pay"): the first
 *    transaction's own `SELECT ... WHERE status IN ('created', 'pending')`
 *    finds the still-live session from the FIRST call and returns it
 *    without ever reaching the provider a second time.
 * 2. GENUINELLY CONCURRENT double-create (two requests both pass step 1
 *    before either commits): both call the provider (wasteful but
 *    harmless — Midtrans's own `order_id` is unique per ATTEMPT, so this
 *    never mints two live sessions at the provider for the same attempt
 *    number) and both try to INSERT; the loser's `INSERT` hits the
 *    `(provider, provider_ref)` UNIQUE constraint (`23505`) and, rather
 *    than 500ing, re-fetches and returns the winner's own row.
 */
import { getProviderCircuitBreaker } from "../../../lib/database/circuit-breaker";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { normalizeMoney } from "../domain/price-calculation";
import { normalizePhoneNumber } from "../domain/phone-normalisation";
import { isOrderPayable, type OrderStatus } from "../domain/order-status";
import type { PaymentGatewayProvider } from "../domain/payment-gateway-provider";
import { requireCustomerSession } from "./customer-session-auth";

const POSTGRES_UNIQUE_VIOLATION = "23505";
const PROVIDER_REF_CONSTRAINT =
  "awcms_commerce_payment_gateway_sessions_provider_ref_key";
const LIVE_STATUSES = ["created", "pending"] as const;

export type GatewaySessionRecord = {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string;
  redirectUrl: string;
  status: string;
  expiresAt: string;
};

export type CreateGatewaySessionAuth =
  { kind: "phone"; phone: string } | { kind: "bearer"; request: Request };

export type CreateGatewaySessionOutcome =
  | { kind: "created" | "reused"; session: GatewaySessionRecord }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "not_applicable" }
  | { kind: "gateway_unavailable" };

type OrderRow = {
  id: string;
  order_code: string;
  customer_id: string;
  status: string;
  payment_method: string;
  total: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
};

type SessionRow = {
  id: string;
  order_id: string;
  provider: string;
  provider_ref: string;
  redirect_url: string;
  status: string;
  expires_at: Date;
};

function toRecord(row: SessionRow): GatewaySessionRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    redirectUrl: row.redirect_url,
    status: row.status,
    expiresAt: row.expires_at.toISOString()
  };
}

async function fetchOrderForGateway(
  tx: Bun.SQL,
  tenantId: string,
  orderCode: string
): Promise<OrderRow | null> {
  const rows = (await tx`
    SELECT o.id, o.order_code, o.customer_id, o.status, o.payment_method, o.total,
           c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId} AND o.order_code = ${orderCode} AND o.deleted_at IS NULL
  `) as OrderRow[];
  return rows[0] ?? null;
}

async function fetchLiveSession(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<SessionRow | null> {
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, redirect_url, status, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
      AND status = ANY(${tx.array([...LIVE_STATUSES], "text")}::text[])
    ORDER BY created_at DESC
    LIMIT 1
  `) as SessionRow[];
  return rows[0] ?? null;
}

async function countPriorAttempts(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS count
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
  `) as { count: number }[];
  return rows[0]?.count ?? 0;
}

type ValidateResult =
  | { kind: "reuse"; session: SessionRow }
  | {
      kind: "call_provider";
      orderId: string;
      orderCode: string;
      customerName: string;
      customerPhone: string;
      customerEmail: string | null;
      total: string;
      attempt: number;
    }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "not_applicable" };

async function validateAndCheckReuse(
  sql: Bun.SQL,
  tenantId: string,
  orderCode: string,
  auth: CreateGatewaySessionAuth
): Promise<ValidateResult> {
  return withTenantOrThrow(sql, tenantId, async (tx) => {
    const order = await fetchOrderForGateway(tx, tenantId, orderCode);
    if (!order) return { kind: "not_found" };

    if (auth.kind === "phone") {
      const phoneResult = normalizePhoneNumber(auth.phone);
      if (!phoneResult.valid || phoneResult.value !== order.customer_phone) {
        return { kind: "not_found" };
      }
    } else {
      const authOutcome = await requireCustomerSession(
        auth.request,
        tx,
        tenantId
      );
      if (!authOutcome.ok) return { kind: "unauthenticated" };
      if (authOutcome.account.customerId !== order.customer_id) {
        // A live bearer session, just not THIS order's owner — the same
        // neutral answer as an unknown order or a wrong phone (contract's
        // own "same neutral 404 the order-tracking route uses" rule): a
        // caller must never learn "this order exists but is not yours"
        // from a different status code than "this order code does not
        // exist at all".
        return { kind: "not_found" };
      }
    }

    if (
      order.payment_method !== "gateway" ||
      !isOrderPayable(order.status as OrderStatus)
    ) {
      return { kind: "not_applicable" };
    }

    const live = await fetchLiveSession(tx, tenantId, order.id);
    if (live) return { kind: "reuse", session: live };

    const priorAttempts = await countPriorAttempts(tx, tenantId, order.id);

    return {
      kind: "call_provider",
      orderId: order.id,
      orderCode: order.order_code,
      customerName: order.customer_name,
      customerPhone: order.customer_phone,
      customerEmail: order.customer_email,
      total: normalizeMoney(order.total),
      attempt: priorAttempts + 1
    };
  });
}

/**
 * `createGatewaySession(sql, tenantId, orderCode, auth)` — contract #106's
 * own signature. `provider` is resolved by the caller (the route), not this
 * function, so a `503 GATEWAY_UNAVAILABLE` (no provider configured at all)
 * never needs to open a transaction first.
 */
export async function createGatewaySession(
  sql: Bun.SQL,
  tenantId: string,
  orderCode: string,
  auth: CreateGatewaySessionAuth,
  provider: PaymentGatewayProvider,
  providerKey: "midtrans" | "log"
): Promise<CreateGatewaySessionOutcome> {
  const validated = await validateAndCheckReuse(sql, tenantId, orderCode, auth);

  if (validated.kind === "not_found") return { kind: "not_found" };
  if (validated.kind === "unauthenticated") return { kind: "unauthenticated" };
  if (validated.kind === "not_applicable") return { kind: "not_applicable" };
  if (validated.kind === "reuse") {
    return { kind: "reused", session: toRecord(validated.session) };
  }

  // -- Provider call — NO transaction open (ADR-0006/0010/ADR-0017 D1). ----
  const breaker = getProviderCircuitBreaker(`commerce-${providerKey}`);
  let created: Awaited<ReturnType<PaymentGatewayProvider["createSession"]>>;
  try {
    created = await provider.createSession({
      orderCode: validated.orderCode,
      attempt: validated.attempt,
      grossAmount: validated.total,
      customerName: validated.customerName,
      customerPhone: validated.customerPhone,
      customerEmail: validated.customerEmail
    });
  } catch {
    return { kind: "gateway_unavailable" };
  }
  void breaker; // the adapter itself owns breaker bookkeeping; referenced here only to keep the provider-family key visible to a reader of this file.

  // -- Persist — second, independent short transaction. --------------------
  try {
    return await withTenantOrThrow(sql, tenantId, async (tx) => {
      const rows = (await tx`
        INSERT INTO awcms_commerce_payment_gateway_sessions (
          tenant_id, order_id, provider, provider_ref, redirect_url, status, expires_at
        )
        VALUES (
          ${tenantId}, ${validated.orderId}, ${providerKey}, ${created.providerRef},
          ${created.redirectUrl}, 'pending', ${created.expiresAt}
        )
        RETURNING id, order_id, provider, provider_ref, redirect_url, status, expires_at
      `) as SessionRow[];

      return { kind: "created", session: toRecord(rows[0]!) };
    });
  } catch (error) {
    const isCollision =
      error instanceof Bun.SQL.PostgresError &&
      String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
      error.constraint === PROVIDER_REF_CONSTRAINT;
    if (!isCollision) throw error;

    // A genuinely concurrent create won the (provider, provider_ref) race —
    // re-fetch and hand back ITS row rather than 500ing.
    return withTenantOrThrow(sql, tenantId, async (tx) => {
      const rows = (await tx`
        SELECT id, order_id, provider, provider_ref, redirect_url, status, expires_at
        FROM awcms_commerce_payment_gateway_sessions
        WHERE tenant_id = ${tenantId} AND provider = ${providerKey} AND provider_ref = ${created.providerRef}
      `) as SessionRow[];

      if (!rows[0]) throw error; // Should be unreachable — the row that just lost this INSERT must exist.
      return { kind: "reused", session: toRecord(rows[0]) };
    });
  }
}

// ---------------------------------------------------------------------------
// Issue #113 (contract #106's D2) — webhook intake / reconcile job's own
// reads and status writes against this table. None of these call the
// provider (that stays the webhook route's and the reconcile job's own
// concern, per `PaymentGatewayProvider`'s own header) — this file only ever
// persists a status a caller already obtained.
// ---------------------------------------------------------------------------

/** The webhook route's own lookup — `(tenant, provider, providerRef)` uniquely identifies one session (`sql/926`'s own UNIQUE index). */
export async function findGatewaySessionByProviderRef(
  tx: Bun.SQL,
  tenantId: string,
  provider: string,
  providerRef: string
): Promise<GatewaySessionRecord | null> {
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, redirect_url, status, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId} AND provider = ${provider} AND provider_ref = ${providerRef}
  `) as SessionRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Persists a new session status (webhook intake / reconcile job's own
 * mapped outcome). `rawStatus` is the provider's own untrusted response
 * body, stored for operator debugging only (`sql/926`'s own column
 * comment) — nothing in this module ever reads a field back out of it.
 */
export async function updateGatewaySessionStatus(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  status: string,
  rawStatus: unknown
): Promise<void> {
  await tx`
    UPDATE awcms_commerce_payment_gateway_sessions
    SET status = ${status},
        raw_status = ${JSON.stringify(rawStatus ?? null)},
        last_checked_at = now(),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
  `;
}

export type PendingGatewaySessionForReconcile = {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string;
  expiresAt: Date;
};

/**
 * `commerce:payments:reconcile`'s own scan (Issue #113): every session in
 * `pending` older than `olderThanMs`, for tenant `tenantId` — `FOR UPDATE
 * SKIP LOCKED` the same way `listExpirableOrderIds` bounds the expiry job's
 * own scan, so two overlapping reconcile ticks (or the job racing an
 * inbound webhook that is about to mark the same session `paid`) never
 * double-process a row.
 */
export async function listPendingGatewaySessionsForReconcile(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  olderThanMs: number,
  limit = 200
): Promise<PendingGatewaySessionForReconcile[]> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId}
      AND status = 'pending'
      AND created_at <= ${cutoff}
    ORDER BY created_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `) as {
    id: string;
    order_id: string;
    provider: string;
    provider_ref: string;
    expires_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    expiresAt: row.expires_at
  }));
}

/** Every session past `expires_at` that is still `created`/`pending` — expired regardless of a `fetchStatus` result (Issue #113's own "expire past expires_at either way" rule). */
export async function listExpiredGatewaySessions(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  limit = 200
): Promise<PendingGatewaySessionForReconcile[]> {
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId}
      AND status = ANY(${tx.array([...LIVE_STATUSES], "text")}::text[])
      AND expires_at <= ${now}
    ORDER BY expires_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `) as {
    id: string;
    order_id: string;
    provider: string;
    provider_ref: string;
    expires_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    providerRef: row.provider_ref,
    expiresAt: row.expires_at
  }));
}

/** Fetches one gateway session by its own id, tenant-scoped — the admin "Cek status" action's own single-row lookup. */
export async function findGatewaySessionById(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string
): Promise<GatewaySessionRecord | null> {
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, redirect_url, status, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
  `) as SessionRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The order detail admin screen's own read — the most recent session for one order, plus every payment event, oldest first. */
export type PaymentEventSummary = {
  id: string;
  provider: string;
  eventKey: string;
  outcome: string;
  receivedAt: string;
};

export async function fetchLatestGatewaySessionForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<GatewaySessionRecord | null> {
  const rows = (await tx`
    SELECT id, order_id, provider, provider_ref, redirect_url, status, expires_at
    FROM awcms_commerce_payment_gateway_sessions
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as SessionRow[];
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function listPaymentEventsForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<PaymentEventSummary[]> {
  const rows = (await tx`
    SELECT id, provider, event_key, outcome, received_at
    FROM awcms_commerce_payment_events
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY received_at DESC
    LIMIT 100
  `) as {
    id: string;
    provider: string;
    event_key: string;
    outcome: string;
    received_at: Date;
  }[];

  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    eventKey: row.event_key,
    outcome: row.outcome,
    receivedAt: row.received_at.toISOString()
  }));
}
