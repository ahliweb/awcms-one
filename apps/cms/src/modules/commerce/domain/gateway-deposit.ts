/**
 * Gateway session purposes and the server-computed expected amount (Issue
 * #379, ADR-0041 D1/D3/D5). Pure - no database, no I/O.
 *
 * A hosted-checkout session has a `purpose`:
 *
 *   - `full`: the whole-total session of ADR-0025. The expected amount is the
 *     order total, allowed only for a `gateway` order while nothing is settled.
 *     This is the path every order without a deposit takes, and it is decided
 *     by `payment-gateway-directory.ts` exactly as before - this file never
 *     decides it.
 *   - `deposit`: the down payment of a down-payment order. The expected amount
 *     is the release threshold (`dp_amount`) minus what is already settled.
 *   - `balance`: what remains of a down-payment order after the threshold has
 *     been reached. The expected amount is `total - settled`.
 *
 * Both figures come from the ledger (`settledCents` is the caller's derivation
 * under the order-row lock), never from the request: the client may only ask
 * for "pay the deposit" or "pay the balance". A whole-total order has no
 * deposit (ADR-0041 D3), so it can never obtain `deposit` or `balance`.
 *
 * Money is integer cents (`bigint`, ADR-0003); nothing here uses a float.
 */
import { fromCents, toCents } from "./price-calculation";
import { isOrderPayable, type OrderStatus } from "./order-status";
import { releaseThresholdCents } from "./payment-allocation";

export const GATEWAY_SESSION_PURPOSES = ["full", "deposit", "balance"] as const;
export type GatewaySessionPurpose = (typeof GATEWAY_SESSION_PURPOSES)[number];

/** The purposes a client may name; anything else (or absent) is `full`. */
export function parseGatewaySessionPurpose(
  value: unknown
): GatewaySessionPurpose | null {
  if (value === undefined || value === null) return "full";
  return typeof value === "string" &&
    (GATEWAY_SESSION_PURPOSES as readonly string[]).includes(value)
    ? (value as GatewaySessionPurpose)
    : null;
}

type DepositOrderFacts = {
  total: string;
  paymentMethod: string;
  dpAmount: string | null;
};

/**
 * `true` for a down-payment order: `payment_method = 'dp'` with a positive
 * `dp_amount` below the total (the same rule as the ledger's release threshold,
 * ADR-0025 D3). Every other order is a whole-total order.
 */
export function isDepositOrder(order: DepositOrderFacts): boolean {
  return releaseThresholdCents(order) < toCents(order.total);
}

/**
 * Order statuses in which a BALANCE may still be collected: the order was
 * released at the deposit (`paid`) and may have moved on, but is not a dead end.
 */
const BALANCE_ORDER_STATUSES: readonly OrderStatus[] = [
  "pending_payment",
  "paid",
  "processing",
  "shipped",
  "completed"
];

/**
 * The purposes the order's CURRENT state admits (ADR-0041 D1). Used both to
 * decide a request and to tell the caller what it may ask for instead
 * (`details.allowed`).
 */
export function allowedGatewayPurposes(
  order: DepositOrderFacts & { status: OrderStatus },
  settledInput: bigint
): GatewaySessionPurpose[] {
  const settledCents = settledInput < 0n ? 0n : settledInput;
  const totalCents = toCents(order.total);
  if (!isDepositOrder(order)) {
    return order.paymentMethod === "gateway" &&
      isOrderPayable(order.status) &&
      settledCents === 0n
      ? ["full"]
      : [];
  }
  const threshold = releaseThresholdCents(order);
  if (settledCents < threshold && isOrderPayable(order.status)) {
    return ["deposit"];
  }
  if (
    settledCents >= threshold &&
    settledCents < totalCents &&
    BALANCE_ORDER_STATUSES.includes(order.status)
  ) {
    return ["balance"];
  }
  return [];
}

export type GatewayPurposeDecision =
  | {
      ok: true;
      purpose: "deposit" | "balance";
      expectedCents: bigint;
      /** `numeric(14,2)` string, exactly the `gross_amount` sent to the provider. */
      expectedAmount: string;
    }
  | { ok: false; allowed: GatewaySessionPurpose[] };

/**
 * Decides a `deposit` or `balance` request against the ledger. `settledCents`
 * is `Σ succeeded payments − Σ succeeded reversals` read under the order-row
 * lock. A refusal carries the purposes the order does admit.
 */
export function decideGatewayPurpose(
  order: DepositOrderFacts & { status: OrderStatus },
  settledInput: bigint,
  requested: "deposit" | "balance"
): GatewayPurposeDecision {
  const settledCents = settledInput < 0n ? 0n : settledInput;
  const allowed = allowedGatewayPurposes(order, settledCents);
  if (!allowed.includes(requested)) return { ok: false, allowed };

  const expectedCents =
    requested === "deposit"
      ? releaseThresholdCents(order) - settledCents
      : toCents(order.total) - settledCents;
  return {
    ok: true,
    purpose: requested,
    expectedCents,
    expectedAmount: fromCents(expectedCents)
  };
}

/**
 * What to do with a still-live session when another is about to be created
 * (ADR-0041 D5.1, one live session per order). It is handed back only when it
 * is exactly the one the request would create - the same purpose and, for a
 * deposit/balance, the same expected amount; anything else must end first.
 * Pure so the validate step and the persist step (which re-checks under the
 * order-row lock) decide identically.
 */
export function decideLiveSessionReuse(
  live: { purpose: string; expectedAmount: string | null },
  wanted: { purpose: GatewaySessionPurpose; expectedAmount: string }
): "reuse" | "in_progress" {
  if (live.purpose !== wanted.purpose) return "in_progress";
  if (wanted.purpose === "full") return "reuse";
  return live.expectedAmount !== null &&
    toCents(live.expectedAmount) === toCents(wanted.expectedAmount)
    ? "reuse"
    : "in_progress";
}

/** A JSON request body that is a plain object (not null, an array or a primitive). */
export function isPlainJsonObject(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
