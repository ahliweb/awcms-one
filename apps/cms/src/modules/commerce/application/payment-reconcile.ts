/**
 * `commerce:payments:reconcile` (Issue #113, contract #106's D2) — the
 * reconciliation half of the payment-gateway intake story: a webhook can be
 * lost (network blip, provider retry budget exhausted before this deployment
 * came back up), so this job polls every gateway session still `pending`
 * more than `PENDING_SESSION_AGE_MS` after it was created, and applies the
 * SAME transition path the webhook route uses
 * (`application/payment-webhook-intake.ts`'s `markOrderPaidBySystem`/
 * `expireOrderBySystem`) — one status-mapped outcome, reached from either
 * source.
 *
 * ## Transaction discipline (ADR-0006/0010/ADR-0017 D1)
 *
 * Same three-step shape `application/payment-gateway-directory.ts`'s
 * `createGatewaySession` already established for this module: read the
 * candidate batch in one short transaction, call `provider.fetchStatus`
 * with NO transaction open (the adapter itself wraps `withTimeout` +
 * `getProviderCircuitBreaker` — see `infrastructure/midtrans-provider.ts`'s
 * header), then persist the outcome in a second short transaction. A
 * `fetchStatus` failure (timeout, breaker open, non-2xx) is caught PER
 * SESSION and simply skipped for this tick — it stays `pending` and is
 * retried on the next run, exactly like a message the WhatsApp dispatcher's
 * breaker deferred back to `queued`.
 *
 * `expireStaleGatewaySessions` is unconditional — a session past its own
 * `expires_at` is expired regardless of what (or whether) `fetchStatus`
 * answered, per the issue's own "expire sessions whose expires_at has
 * passed regardless of fetchStatus result" rule.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import {
  listExpiredGatewaySessions,
  listPendingGatewaySessionsForReconcile,
  updateGatewaySessionStatus,
  type PendingGatewaySessionForReconcile
} from "./payment-gateway-directory";
import { expireOrderBySystem, markOrderPaidBySystem } from "./order-directory";
import { guardPaymentAmount } from "./payment-webhook-intake";
import { isTerminalFailureStatus } from "../domain/payment-amount-guard";
import type { PaymentGatewayProvider } from "../domain/payment-gateway-provider";

/** Sessions younger than this are left alone — the webhook is still the expected path; only a session stuck `pending` longer than this is worth a provider round trip. */
export const PENDING_SESSION_AGE_MS = 2 * 60_000;

export type ReconcileTickResult = {
  checked: number;
  markedPaid: number;
  expiredSessions: number;
  expiredOrders: number;
  fetchFailures: number;
};

/** Midtrans's own status response carries `gross_amount`; the `log` adapter's does not. Read it when present so the reconcile path runs the SAME amount guard the webhook route does. */
function readReportedGrossAmount(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const value = (raw as Record<string, unknown>).gross_amount;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function applyFetchedStatus(
  sql: Bun.SQL,
  tenantId: string,
  session: PendingGatewaySessionForReconcile,
  providerKey: string,
  status: "pending" | "paid" | "expired" | "failed" | "refunded",
  raw: unknown,
  correlationId?: string
): Promise<{ markedPaid: boolean; expiredOrder: boolean }> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      // Same defense-in-depth amount guard the webhook route applies
      // (`payment-webhook-intake.ts`'s `guardPaymentAmount`): a mismatch is
      // recorded as an `amount_mismatch` payment event + audit entry, never
      // marks the order paid, and moves the session only on a terminal
      // provider failure.
      const eventKey = `reconcile:${session.providerRef}:${status}`;
      const mismatch = await guardPaymentAmount(
        tx,
        tenantId,
        session.orderId,
        readReportedGrossAmount(raw),
        {
          provider: providerKey,
          providerRef: session.providerRef,
          eventKey,
          status,
          correlationId
        }
      );
      if (mismatch) {
        await tx`
          INSERT INTO awcms_commerce_payment_events (
            tenant_id, provider, event_key, provider_ref, order_id, payload, outcome
          )
          VALUES (
            ${tenantId}, ${providerKey}, ${eventKey}, ${session.providerRef},
            ${session.orderId}, ${JSON.stringify(raw ?? null)}, 'amount_mismatch'
          )
          ON CONFLICT (tenant_id, provider, event_key) DO NOTHING
        `;
        if (isTerminalFailureStatus(status)) {
          await updateGatewaySessionStatus(
            tx,
            tenantId,
            session.id,
            "failed",
            raw
          );
        }
        return { markedPaid: false, expiredOrder: false };
      }

      await updateGatewaySessionStatus(tx, tenantId, session.id, status, raw);

      if (status === "paid") {
        const result = await markOrderPaidBySystem(
          tx,
          tenantId,
          session.orderId,
          {
            provider: providerKey,
            providerRef: session.providerRef,
            eventKey: `reconcile:${session.providerRef}`
          },
          correlationId
        );
        return { markedPaid: result.applied, expiredOrder: false };
      }

      if (status === "expired") {
        const orderRows = (await tx`
          SELECT status FROM awcms_commerce_orders
          WHERE tenant_id = ${tenantId} AND id = ${session.orderId} AND deleted_at IS NULL
        `) as { status: string }[];
        if (orderRows[0]?.status === "pending_payment") {
          await expireOrderBySystem(
            tx,
            tenantId,
            session.orderId,
            correlationId
          );
          return { markedPaid: false, expiredOrder: true };
        }
      }

      // `pending`/`failed`/`refunded` — see `domain/order-status.ts`'s
      // header for why `refunded` never auto-transitions the order.
      return { markedPaid: false, expiredOrder: false };
    },
    { workClass: "background_sync" }
  );
}

/** One tenant's worth of reconcile work — the job script's own per-tenant call. */
export async function reconcilePendingSessionsForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  provider: PaymentGatewayProvider,
  providerKey: string,
  correlationId?: string
): Promise<ReconcileTickResult> {
  const result: ReconcileTickResult = {
    checked: 0,
    markedPaid: 0,
    expiredSessions: 0,
    expiredOrders: 0,
    fetchFailures: 0
  };

  // -- Step 1: unconditional expiry of sessions past expires_at. -----------
  const expired = await withTenantOrThrow(
    sql,
    tenantId,
    (tx) => listExpiredGatewaySessions(tx, tenantId, now),
    { workClass: "background_sync" }
  );

  for (const session of expired) {
    await withTenantOrThrow(
      sql,
      tenantId,
      async (tx) => {
        await updateGatewaySessionStatus(
          tx,
          tenantId,
          session.id,
          "expired",
          null
        );
        const orderRows = (await tx`
          SELECT status FROM awcms_commerce_orders
          WHERE tenant_id = ${tenantId} AND id = ${session.orderId} AND deleted_at IS NULL
        `) as { status: string }[];
        if (orderRows[0]?.status === "pending_payment") {
          await expireOrderBySystem(
            tx,
            tenantId,
            session.orderId,
            correlationId
          );
          result.expiredOrders += 1;
        }
      },
      { workClass: "background_sync" }
    );
    result.expiredSessions += 1;
  }

  // -- Step 2: poll every still-pending, aged session. ----------------------
  const candidates = await withTenantOrThrow(
    sql,
    tenantId,
    (tx) =>
      listPendingGatewaySessionsForReconcile(
        tx,
        tenantId,
        now,
        PENDING_SESSION_AGE_MS
      ),
    { workClass: "background_sync" }
  );

  for (const session of candidates) {
    result.checked += 1;

    let status: "pending" | "paid" | "expired" | "failed" | "refunded";
    let raw: unknown;
    try {
      const fetched = await provider.fetchStatus(session.providerRef);
      status = fetched.status;
      raw = fetched.raw;
    } catch {
      // Timeout / breaker open / non-2xx — leave `pending`, retried next tick.
      result.fetchFailures += 1;
      continue;
    }

    if (status === "pending") continue;

    const applied = await applyFetchedStatus(
      sql,
      tenantId,
      session,
      providerKey,
      status,
      raw,
      correlationId
    );
    if (applied.markedPaid) result.markedPaid += 1;
    if (applied.expiredOrder) result.expiredOrders += 1;
  }

  return result;
}

/** The admin "Cek status" action's own scoped, single-order reconcile (Issue #113) — never the full tenant batch. */
export async function reconcileOneOrderPaymentSession(
  sql: Bun.SQL,
  tenantId: string,
  orderId: string,
  provider: PaymentGatewayProvider,
  providerKey: string,
  correlationId?: string
): Promise<{ outcome: "no_session" | "checked"; status?: string }> {
  const session = await withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id, order_id, provider, provider_ref, expires_at
        FROM awcms_commerce_payment_gateway_sessions
        WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
        ORDER BY created_at DESC
        LIMIT 1
      `) as {
        id: string;
        order_id: string;
        provider: string;
        provider_ref: string;
        expires_at: Date;
      }[];
      const row = rows[0];
      return row
        ? {
            id: row.id,
            orderId: row.order_id,
            provider: row.provider,
            providerRef: row.provider_ref,
            expiresAt: row.expires_at
          }
        : null;
    },
    { workClass: "interactive" }
  );

  if (!session) return { outcome: "no_session" };

  const now = new Date();
  if (session.expiresAt <= now) {
    await applyFetchedStatus(
      sql,
      tenantId,
      session,
      providerKey,
      "expired",
      null,
      correlationId
    );
    return { outcome: "checked", status: "expired" };
  }

  let status: "pending" | "paid" | "expired" | "failed" | "refunded";
  let raw: unknown;
  try {
    const fetched = await provider.fetchStatus(session.providerRef);
    status = fetched.status;
    raw = fetched.raw;
  } catch {
    return { outcome: "checked", status: "pending" };
  }

  if (status !== "pending") {
    await applyFetchedStatus(
      sql,
      tenantId,
      session,
      providerKey,
      status,
      raw,
      correlationId
    );
  }

  return { outcome: "checked", status };
}
