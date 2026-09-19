/**
 * Amount guard (Issue #113 review, defense in depth) — the pure check plus
 * `applyVerifiedWebhookEvent`'s mismatch branch against a scripted fake
 * transaction (no database). The same branch is proven against a real
 * Postgres in `tests/integration/commerce-payment-webhook.integration.test.ts`.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  checkPaymentAmount,
  isTerminalFailureStatus
} from "../src/modules/commerce/domain/payment-amount-guard";
import * as realTenantContext from "../src/lib/database/tenant-context";
import * as realDirectory from "../src/modules/commerce/application/payment-gateway-directory";
import * as realOrders from "../src/modules/commerce/application/order-directory";
import * as realAudit from "../src/modules/logging/application/audit-log";

const ORIGINAL_TENANT = { ...realTenantContext };
const ORIGINAL_DIRECTORY = { ...realDirectory };
const ORIGINAL_ORDERS = { ...realOrders };
const ORIGINAL_AUDIT = { ...realAudit };

describe("checkPaymentAmount (pure)", () => {
  test("equal amounts in cents pass, regardless of scale", () => {
    expect(checkPaymentAmount("150000.00", "150000.00").ok).toBe(true);
    expect(checkPaymentAmount("150000", "150000.00").ok).toBe(true);
    expect(checkPaymentAmount("150000.5", "150000.50").ok).toBe(true);
  });

  test("a different amount is a mismatch, never a pass", () => {
    const result = checkPaymentAmount("149999.00", "150000.00");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("mismatch");
  });

  test("an unparseable reported amount fails closed", () => {
    for (const bad of ["", "abc", "-1", "1e5", "150000.001"]) {
      const result = checkPaymentAmount(bad, "150000.00");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unparseable");
    }
  });

  test("only failed/expired count as a terminal failure", () => {
    expect(isTerminalFailureStatus("failed")).toBe(true);
    expect(isTerminalFailureStatus("expired")).toBe(true);
    expect(isTerminalFailureStatus("paid")).toBe(false);
    expect(isTerminalFailureStatus("pending")).toBe(false);
    expect(isTerminalFailureStatus("refunded")).toBe(false);
  });
});

describe("applyVerifiedWebhookEvent — amount mismatch branch (mocked tx)", () => {
  afterEach(() => {
    mock.module("../src/lib/database/tenant-context", () => ORIGINAL_TENANT);
    mock.module(
      "../src/modules/commerce/application/payment-gateway-directory",
      () => ORIGINAL_DIRECTORY
    );
    mock.module(
      "../src/modules/commerce/application/order-directory",
      () => ORIGINAL_ORDERS
    );
    mock.module(
      "../src/modules/logging/application/audit-log",
      () => ORIGINAL_AUDIT
    );
  });

  test("a verified 'paid' whose gross_amount differs from the order total is recorded as amount_mismatch and never marks the order paid", async () => {
    const insertedOutcomes: string[] = [];
    let markPaidCalled = false;
    let sessionStatusWrites: string[] = [];
    let auditMessages: string[] = [];

    // A callable tagged-template fake: the SELECT total answers the order,
    // the INSERT into payment_events records its outcome and returns a row.
    const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sqlText = strings.join("?");
      if (sqlText.includes("SELECT total, order_code")) {
        return Promise.resolve([{ total: "150000.00", order_code: "ORD-1" }]);
      }
      if (sqlText.includes("INSERT INTO awcms_commerce_payment_events")) {
        insertedOutcomes.push(String(values[values.length - 1]));
        return Promise.resolve([{ id: "evt-1" }]);
      }
      return Promise.resolve([]);
    }) as unknown as Bun.SQL;

    mock.module("../src/lib/database/tenant-context", () => ({
      ...ORIGINAL_TENANT,
      withTenantOrThrow: async (
        _sql: unknown,
        _tenantId: string,
        fn: (tx: Bun.SQL) => Promise<unknown>
      ) => fn(fakeTx)
    }));
    mock.module(
      "../src/modules/commerce/application/payment-gateway-directory",
      () => ({
        ...ORIGINAL_DIRECTORY,
        findGatewaySessionByProviderRef: async () => ({
          id: "sess-1",
          orderId: "order-1",
          provider: "midtrans",
          providerRef: "ORD-1-1",
          redirectUrl: "https://x",
          status: "pending",
          expiresAt: new Date().toISOString()
        }),
        updateGatewaySessionStatus: async (
          _tx: unknown,
          _tenant: string,
          _id: string,
          status: string
        ) => {
          sessionStatusWrites.push(status);
        }
      })
    );
    mock.module("../src/modules/commerce/application/order-directory", () => ({
      ...ORIGINAL_ORDERS,
      markOrderPaidBySystem: async () => {
        markPaidCalled = true;
        return { applied: true };
      }
    }));
    mock.module("../src/modules/logging/application/audit-log", () => ({
      ...ORIGINAL_AUDIT,
      recordAuditEvent: async (_tx: unknown, event: { message: string }) => {
        auditMessages.push(event.message);
      }
    }));

    const { applyVerifiedWebhookEvent } =
      await import("../src/modules/commerce/application/payment-webhook-intake");

    const result = await applyVerifiedWebhookEvent({} as Bun.SQL, "tenant-1", {
      provider: "midtrans",
      eventKey: "ORD-1-1:200",
      providerRef: "ORD-1-1",
      status: "paid",
      grossAmount: "1000.00",
      payload: { gross_amount: "1000.00" }
    });

    expect(result.kind).toBe("amount_mismatch");
    expect(markPaidCalled).toBe(false);
    expect(insertedOutcomes).toEqual(["amount_mismatch"]);
    // A mismatched "paid" is not a terminal provider failure — the session
    // stays as it was so a later correct callback / reconcile can settle it.
    expect(sessionStatusWrites).toEqual([]);
    expect(auditMessages).toHaveLength(1);
    expect(auditMessages[0]).toContain("REJECTED");
  });
});
