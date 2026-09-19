/**
 * Payment-gateway webhook INTAKE (Issue #113, contract #106's D2/D3) — the
 * application logic behind
 * `src/pages/api/v1/commerce/webhooks/[provider]/[endpointToken].ts`. Kept
 * out of the route file itself (`awcms-new-endpoint`'s "thin routes" rule)
 * so the ordering below is unit-testable without an HTTP request.
 *
 * ## Gate ordering (every step short-circuits the next)
 *
 * 1. `resolveWebhookEndpoint` — hash the caller's token, resolve
 *    `(tenant_id, provider)` via the `SECURITY DEFINER`
 *    `awcms_resolve_commerce_webhook_endpoint` (`sql/926`), called on the
 *    PLAIN pool client with NO tenant context open yet (mirrors
 *    `resolvePublicTenantByHost`'s own call to
 *    `awcms_resolve_tenant_domain_lookup` exactly — see that file's
 *    header). Unknown/revoked token -> `null` — the route pads latency and
 *    answers a neutral `404`, never distinguishing "wrong token" from
 *    "right token, wrong provider segment".
 * 2. The route itself calls `provider.verifyWebhook` — deliberately NOT
 *    wrapped here, so this file never imports a concrete adapter and stays
 *    testable against a mocked `PaymentGatewayProvider`. A signature
 *    failure is a `401`, decided by the route before this file's
 *    `applyVerifiedWebhookEvent` is ever called.
 * 3. `applyVerifiedWebhookEvent` — runs INSIDE one `withTenantOrThrow`
 *    transaction. `INSERT … ON CONFLICT DO NOTHING` on
 *    `awcms_commerce_payment_events` is the replay guard contract #106
 *    specifies: zero rows affected means this exact `(tenant, provider,
 *    event_key)` was already processed, and this function returns `{kind:
 *    "replay"}` having done nothing else. This route NEVER calls the
 *    provider itself (`fetchStatus`/any outbound call) — every status this
 *    function acts on was already produced by the route's own
 *    `verifyWebhook` call in step 2.
 *
 * ## Why `markOrderPaidBySystem`/`expireOrderBySystem`, never a bespoke path
 *
 * Both are the SAME functions the `commerce:payments:reconcile` job calls
 * (`scripts/commerce-payments-reconcile.ts`) — one status-mapped outcome,
 * one application path, regardless of whether it was learned from a
 * webhook or a polled `fetchStatus`. `failed`/`refunded` never move the
 * order at all (see `domain/order-status.ts`'s own header for the
 * `refunded` decision) — only the gateway SESSION row records them, via
 * `updateGatewaySessionStatus`.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { hashWebhookEndpointToken } from "../../../lib/auth/webhook-endpoint-token";
import {
  findGatewaySessionByProviderRef,
  updateGatewaySessionStatus
} from "./payment-gateway-directory";
import { expireOrderBySystem, markOrderPaidBySystem } from "./order-directory";
import { recordAuditEvent } from "../../logging/application/audit-log";
import { normalizeMoney } from "../domain/price-calculation";
import {
  checkPaymentAmount,
  isTerminalFailureStatus
} from "../domain/payment-amount-guard";
import type { PaymentGatewayStatus } from "../domain/payment-gateway-provider";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

export type ResolvedWebhookEndpoint = {
  tenantId: string;
  provider: string;
};

/**
 * Issue #118 — a tenant that turned `features.gateway` off answers the SAME
 * neutral 404 an unknown/revoked token does (the route's own gate ordering
 * calls this right after `resolveWebhookEndpoint` succeeds, before ever
 * touching `provider.verifyWebhook`). Lives here, alongside
 * `resolveWebhookEndpoint`/`applyVerifiedWebhookEvent`, rather than as a raw
 * `withTenantOrThrow` call inlined in the route file, for the same "thin
 * routes, testable application layer" reason this file's own header states
 * — `tests/commerce-payment-webhook-route.test.ts` mocks this whole module
 * to drive the route's gate ordering without a real database.
 */
export async function isGatewayFeatureEnabledForTenant(
  sql: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => (await fetchCommerceFeatures(tx, tenantId)).gateway
  );
}

/**
 * Step 1 — called on the PLAIN `Bun.SQL` client, no tenant context. Returns
 * `null` for an unknown or revoked token; never throws for that case (a
 * thrown error here would be a 500, disclosing more than a 404 should).
 */
export async function resolveWebhookEndpoint(
  sql: Bun.SQL,
  token: string
): Promise<ResolvedWebhookEndpoint | null> {
  const tokenHash = hashWebhookEndpointToken(token);

  const rows = (await sql`
    SELECT tenant_id, provider
    FROM awcms_resolve_commerce_webhook_endpoint(${tokenHash})
  `) as { tenant_id: string; provider: string }[];

  const row = rows[0];
  return row ? { tenantId: row.tenant_id, provider: row.provider } : null;
}

export type ApplyWebhookEventInput = {
  provider: string;
  eventKey: string;
  providerRef: string;
  status: PaymentGatewayStatus;
  /**
   * The provider's own reported amount (Midtrans `gross_amount`, a decimal
   * string). When present it is compared against the order's `total` in
   * integer cents BEFORE any order transition — a mismatch is recorded as
   * `outcome = 'amount_mismatch'` and never marks the order paid
   * (`domain/payment-amount-guard.ts`). Absent only for a provider whose
   * status response carries no amount at all (the `log` adapter).
   */
  grossAmount?: string;
  payload: unknown;
  correlationId?: string;
};

export type ApplyWebhookEventResult =
  | { kind: "replay" }
  | { kind: "applied"; orderAffected: boolean }
  | { kind: "ignored" }
  | { kind: "amount_mismatch"; reported: string; expected: string };

/**
 * Shared by this file and `payment-reconcile.ts`: the amount guard plus the
 * audit entry it writes on a mismatch. Returns `null` when the amounts
 * agree (or no amount was reported), or the mismatch detail otherwise —
 * the caller decides what that means for the event row/session.
 */
export async function guardPaymentAmount(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  grossAmount: string | undefined,
  context: {
    provider: string;
    providerRef: string;
    eventKey: string;
    status: string;
    correlationId?: string;
  }
): Promise<{ reported: string; expected: string } | null> {
  if (grossAmount === undefined) return null;

  const rows = (await tx`
    SELECT total, order_code FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as { total: string; order_code: string }[];
  const order = rows[0];
  const expected = order ? normalizeMoney(order.total) : "";

  const check = checkPaymentAmount(grossAmount, expected);
  if (check.ok) return null;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId: undefined,
    moduleKey: "commerce",
    action: "update",
    resourceType: "order",
    resourceId: orderId,
    message: `Payment ${context.provider} event ${context.eventKey} REJECTED: reported amount ${grossAmount} does not match order ${order?.order_code ?? orderId} total ${expected} (${check.reason}). Order NOT marked paid.`,
    attributes: {
      orderCode: order?.order_code ?? null,
      provider: context.provider,
      providerRef: context.providerRef,
      eventKey: context.eventKey,
      providerStatus: context.status,
      reportedAmount: grossAmount,
      expectedAmount: expected,
      reason: check.reason
    },
    correlationId: context.correlationId
  });

  return { reported: grossAmount, expected };
}

/** Which `PaymentGatewayStatus` values move the order at all — see `domain/order-status.ts`'s header for why `failed`/`refunded` never do. */
function isActionableForOrder(
  status: PaymentGatewayStatus
): status is "paid" | "expired" {
  return status === "paid" || status === "expired";
}

/** Every session-row status a webhook status maps to 1:1 — the gateway session's own vocabulary matches `PaymentGatewayStatus` exactly (`sql/926`'s own CHECK constraint). */
function toSessionStatus(status: PaymentGatewayStatus): string {
  return status;
}

/**
 * Step 3 — the ONE place a verified webhook event is persisted and (when
 * actionable) applied. Runs its own `withTenantOrThrow` transaction; the
 * caller (the route) must NOT already have one open.
 */
export async function applyVerifiedWebhookEvent(
  sql: Bun.SQL,
  tenantId: string,
  input: ApplyWebhookEventInput
): Promise<ApplyWebhookEventResult> {
  return withTenantOrThrow(sql, tenantId, async (tx) => {
    const session = await findGatewaySessionByProviderRef(
      tx,
      tenantId,
      input.provider,
      input.providerRef
    );

    // Defense in depth (Issue #113 review): the amount guard runs BEFORE the
    // event row is written, so the row itself records the verdict. It only
    // has an order to compare against when a session resolved; an
    // unattached event falls through to `ignored` as before.
    const mismatch = session
      ? await guardPaymentAmount(
          tx,
          tenantId,
          session.orderId,
          input.grossAmount,
          {
            provider: input.provider,
            providerRef: input.providerRef,
            eventKey: input.eventKey,
            status: input.status,
            correlationId: input.correlationId
          }
        )
      : null;

    const outcome = mismatch
      ? "amount_mismatch"
      : input.status === "pending"
        ? "ignored"
        : "applied";

    const inserted = (await tx`
      INSERT INTO awcms_commerce_payment_events (
        tenant_id, provider, event_key, provider_ref, order_id, payload, outcome
      )
      VALUES (
        ${tenantId}, ${input.provider}, ${input.eventKey}, ${input.providerRef},
        ${session?.orderId ?? null}, ${JSON.stringify(input.payload ?? null)}, ${outcome}
      )
      ON CONFLICT (tenant_id, provider, event_key) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    if (inserted.length === 0) {
      // Redelivery of an event this tenant/provider/event_key already saw —
      // no side effect, 200 to the provider either way (route's own job).
      return { kind: "replay" };
    }

    if (!session) {
      // A verified event for a provider_ref this tenant has no live session
      // row for at all (never created here, or belongs to another tenant —
      // `findGatewaySessionByProviderRef` is tenant-scoped under FORCE RLS,
      // so a cross-tenant provider_ref simply does not resolve). The event
      // is still recorded above for the operator's own audit trail; nothing
      // else can be done without an order to apply it to.
      return { kind: "ignored" };
    }

    if (mismatch) {
      // Recorded + audited above; the ORDER is never touched. The session
      // row only moves when the provider itself says the transaction is
      // terminally failed — a mismatched "paid" leaves it `pending` so the
      // reconcile job / a later correct callback can still settle it.
      if (isTerminalFailureStatus(input.status)) {
        await updateGatewaySessionStatus(
          tx,
          tenantId,
          session.id,
          "failed",
          input.payload
        );
      }
      return { kind: "amount_mismatch", ...mismatch };
    }

    await updateGatewaySessionStatus(
      tx,
      tenantId,
      session.id,
      toSessionStatus(input.status),
      input.payload
    );

    if (!isActionableForOrder(input.status)) {
      // `failed`/`refunded` — session status recorded above; the order
      // itself is deliberately left alone (see `domain/order-status.ts`'s
      // header for the `refunded` decision; `failed` simply means the
      // shopper may retry the same order while it is still
      // `pending_payment`).
      return { kind: "applied", orderAffected: false };
    }

    if (input.status === "paid") {
      const result = await markOrderPaidBySystem(
        tx,
        tenantId,
        session.orderId,
        {
          provider: input.provider,
          providerRef: input.providerRef,
          eventKey: input.eventKey
        },
        input.correlationId
      );
      return { kind: "applied", orderAffected: result.applied };
    }

    // input.status === "expired" — only legal from `pending_payment`
    // (`domain/order-status.ts`'s own `system` edge list); an order the
    // shop already moved on from (paid, cancelled, …) must not throw just
    // because a late/duplicate "expired" callback arrived for it.
    const orderRows = (await tx`
      SELECT status FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${session.orderId} AND deleted_at IS NULL
    `) as { status: string }[];

    if (orderRows[0]?.status !== "pending_payment") {
      return { kind: "applied", orderAffected: false };
    }

    await expireOrderBySystem(
      tx,
      tenantId,
      session.orderId,
      input.correlationId
    );
    return { kind: "applied", orderAffected: true };
  });
}
