/**
 * A deterministic, stateful fake `PaymentGatewayProvider` for the unknown-
 * outcome tests (issue #564). Unlike the `log` adapter it has a MEMORY of what
 * the "provider" did, so a test can tell "the caller saw a failure" apart from
 * "the provider did nothing" - the distinction a timeout hides.
 *
 * Every operation takes a script of faults, consumed one per call:
 *
 *   - `ok`             the provider acts and the caller sees the answer;
 *   - `fail_before`    the caller sees a failure and the provider did NOTHING
 *                      (`timeout_before`, `http429`, `http500`);
 *   - `fail_after`     the provider ACTED (session created / refund moved) and
 *                      the caller sees a failure anyway (`timeout_after`,
 *                      `malformed`, `lost_ack`) - the unknown outcome.
 *
 * Two provider behaviours the real adapters depend on are switchable, because
 * the guarantee a retry can rely on is the provider's, not ours:
 *
 *   - `duplicateOrderId`: `reject` models Midtrans Snap's "order_id has
 *     already been taken" (the default), `reuse` models a provider that
 *     answers a repeat create with the existing session;
 *   - `duplicateRefundKey`: `reject_406` models Midtrans's documented
 *     "406 Duplicate refund ID" (the default; the docs do not say the
 *     original result is returned), `replay_original` models a provider that
 *     is idempotent on the key.
 *
 * No timers, no network: a "delay" is an injected async hook, so ordering is
 * decided by the test.
 */
import type {
  PaymentGatewayCreateSessionInput,
  PaymentGatewayProvider,
  PaymentGatewayRefundInput,
  PaymentGatewayRefundResult,
  PaymentGatewaySessionResult,
  PaymentGatewayStatus,
  PaymentGatewayStatusResult,
  PaymentGatewayWebhookResult
} from "../../src/modules/commerce/domain/payment-gateway-provider";

export type FaultLabel =
  | "ok"
  | "timeout_before"
  | "http429"
  | "http500"
  | "timeout_after"
  | "malformed"
  | "lost_ack"
  | "accepted_pending";

const BEFORE: ReadonlySet<FaultLabel> = new Set([
  "timeout_before",
  "http429",
  "http500"
]);
const AFTER: ReadonlySet<FaultLabel> = new Set([
  "timeout_after",
  "malformed",
  "lost_ack"
]);

export type ProviderSession = {
  providerRef: string;
  amount: string;
  status: PaymentGatewayStatus;
  /** What `fetchStatus` reports as `gross_amount` (a test can make it lie). */
  reportedGross: string;
};

export class FakePaymentGateway implements PaymentGatewayProvider {
  readonly sessions = new Map<string, ProviderSession>();
  /** Money the PROVIDER has moved back, by refund key. */
  readonly refundsMoved = new Map<
    string,
    { providerRef: string; amount: string; result: PaymentGatewayRefundResult }
  >();
  readonly calls = {
    createSession: [] as PaymentGatewayCreateSessionInput[],
    fetchStatus: [] as string[],
    refund: [] as PaymentGatewayRefundInput[]
  };

  duplicateOrderId: "reject" | "reuse" = "reject";
  duplicateRefundKey: "reject_406" | "replay_original" = "reject_406";
  /** Runs inside `createSession` after the call is recorded, before it acts. */
  onCreateSession: (() => Promise<void>) | null = null;
  /**
   * `true` models a provider that mints a fresh reference per call (the `log`
   * adapter folds a timestamp into it): two concurrent creates then do NOT
   * collide on `(provider, provider_ref)`, so only the order-level guards can
   * keep one live session.
   */
  distinctRefPerCall = false;
  /** Runs inside `refund` after the call is recorded, before it acts. */
  onRefund: (() => Promise<void>) | null = null;
  /** Lifetime the fake reports for a created session. */
  sessionLifetimeMs = 60 * 60_000;

  private readonly scripts = {
    createSession: [] as FaultLabel[],
    fetchStatus: [] as FaultLabel[],
    refund: [] as FaultLabel[]
  };

  script(
    operation: "createSession" | "fetchStatus" | "refund",
    ...faults: FaultLabel[]
  ): this {
    this.scripts[operation].push(...faults);
    return this;
  }

  /** The provider's own record of a payment (what a shopper did at the hosted page). */
  setProviderStatus(
    providerRef: string,
    status: PaymentGatewayStatus,
    reportedGross?: string
  ): void {
    const session = this.sessions.get(providerRef);
    if (!session) throw new Error(`no provider session ${providerRef}`);
    session.status = status;
    if (reportedGross !== undefined) session.reportedGross = reportedGross;
  }

  /** Total the provider has actually refunded, in whole currency units' cents. */
  refundedCents(): bigint {
    let total = 0n;
    for (const moved of this.refundsMoved.values()) {
      total += BigInt(Math.round(Number(moved.amount) * 100));
    }
    return total;
  }

  private next(operation: "createSession" | "fetchStatus" | "refund") {
    return this.scripts[operation].shift() ?? "ok";
  }

  async createSession(
    input: PaymentGatewayCreateSessionInput
  ): Promise<PaymentGatewaySessionResult> {
    this.calls.createSession.push(input);
    const callNumber = this.calls.createSession.length;
    const fault = this.next("createSession");
    if (BEFORE.has(fault)) throw new Error(`provider ${fault}`);
    if (this.onCreateSession) await this.onCreateSession();

    const providerRef = this.distinctRefPerCall
      ? `${input.orderCode}-${input.attempt}-c${callNumber}`
      : `${input.orderCode}-${input.attempt}`;
    if (this.sessions.has(providerRef) && this.duplicateOrderId === "reject") {
      throw new Error("order_id has already been taken");
    }
    if (!this.sessions.has(providerRef)) {
      this.sessions.set(providerRef, {
        providerRef,
        amount: input.grossAmount,
        status: "pending",
        reportedGross: input.grossAmount
      });
    }
    if (AFTER.has(fault)) throw new Error(`provider ${fault}`);
    return {
      providerRef,
      redirectUrl: `https://pay.example.test/${providerRef}`,
      expiresAt: new Date(Date.now() + this.sessionLifetimeMs)
    };
  }

  async fetchStatus(providerRef: string): Promise<PaymentGatewayStatusResult> {
    this.calls.fetchStatus.push(providerRef);
    const fault = this.next("fetchStatus");
    if (BEFORE.has(fault) || AFTER.has(fault)) {
      throw new Error(`provider ${fault}`);
    }
    const session = this.sessions.get(providerRef);
    if (!session) return { status: "pending", raw: { order_id: providerRef } };
    return {
      status: session.status,
      raw: { order_id: providerRef, gross_amount: session.reportedGross }
    };
  }

  async verifyWebhook(): Promise<PaymentGatewayWebhookResult> {
    throw new Error("the unknown-outcome tests apply verified events directly");
  }

  async refund(
    input: PaymentGatewayRefundInput
  ): Promise<PaymentGatewayRefundResult> {
    this.calls.refund.push(input);
    const fault = this.next("refund");
    if (BEFORE.has(fault)) throw new Error(`provider ${fault}`);
    if (this.onRefund) await this.onRefund();

    const earlier = this.refundsMoved.get(input.refundKey);
    if (earlier) {
      if (AFTER.has(fault)) throw new Error(`provider ${fault}`);
      return this.duplicateRefundKey === "replay_original"
        ? earlier.result
        : {
            status: "failed",
            providerRefundId: null,
            failureCode: "MIDTRANS_406",
            raw: { status_code: "406", status_message: "Duplicate refund ID" }
          };
    }

    const result: PaymentGatewayRefundResult =
      fault === "accepted_pending"
        ? {
            status: "pending",
            providerRefundId: `prov-${input.refundKey}`,
            failureCode: null,
            raw: { status_code: "201" }
          }
        : {
            status: "succeeded",
            providerRefundId: `prov-${input.refundKey}`,
            failureCode: null,
            raw: { status_code: "200" }
          };
    this.refundsMoved.set(input.refundKey, {
      providerRef: input.providerRef,
      amount: input.amount,
      result
    });
    if (AFTER.has(fault)) throw new Error(`provider ${fault}`);
    return result;
  }
}
