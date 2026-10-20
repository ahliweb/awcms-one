/**
 * Gateway deposit sessions (Issue #379, ADR-0041, threat-model control C-07) -
 * the pure rules. No database: the same properties are proven against a real
 * Postgres in `tests/integration/commerce-gateway-deposit.integration.test.ts`.
 *
 *   - which purposes an order's state admits, and the expected amount the
 *     server computes for a deposit / balance (integer cents);
 *   - the amount guard against the SESSION's expected amount: a lower and a
 *     higher figure are each a mismatch, a `full` session keeps checking the
 *     order total too, an unparseable figure never passes;
 *   - when settlement reached the total (`deriveSettledAt`);
 *   - the migration freezes what a session was meant to collect.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  allowedGatewayPurposes,
  decideGatewayPurpose,
  isDepositOrder,
  parseGatewaySessionPurpose
} from "../src/modules/commerce/domain/gateway-deposit";
import { checkSessionPaymentAmount } from "../src/modules/commerce/domain/payment-amount-guard";
import { deriveSettledAt } from "../src/modules/commerce/domain/payment-allocation";

const DP_ORDER = {
  status: "pending_payment" as const,
  total: "100000.00",
  paymentMethod: "dp",
  dpAmount: "30000.00"
};
const WHOLE_TOTAL_ORDER = {
  status: "pending_payment" as const,
  total: "100000.00",
  paymentMethod: "gateway",
  dpAmount: null
};

describe("purpose parsing", () => {
  test("absent is full; a known value is itself; anything else is rejected", () => {
    expect(parseGatewaySessionPurpose(undefined)).toBe("full");
    expect(parseGatewaySessionPurpose(null)).toBe("full");
    expect(parseGatewaySessionPurpose("deposit")).toBe("deposit");
    expect(parseGatewaySessionPurpose("balance")).toBe("balance");
    expect(parseGatewaySessionPurpose("partial")).toBeNull();
    expect(parseGatewaySessionPurpose(30000)).toBeNull();
  });
});

describe("isDepositOrder", () => {
  test("only a dp order with a positive dp_amount below the total", () => {
    expect(isDepositOrder(DP_ORDER)).toBe(true);
    expect(isDepositOrder(WHOLE_TOTAL_ORDER)).toBe(false);
    expect(isDepositOrder({ ...DP_ORDER, dpAmount: null })).toBe(false);
    expect(isDepositOrder({ ...DP_ORDER, dpAmount: "100000.00" })).toBe(false);
    expect(isDepositOrder({ ...DP_ORDER, dpAmount: "0.00" })).toBe(false);
    expect(isDepositOrder({ ...DP_ORDER, paymentMethod: "manual_bank" })).toBe(
      false
    );
  });
});

describe("allowed purposes (ADR-0041 D1, D3)", () => {
  test("a whole-total gateway order admits only full, and only while nothing is settled", () => {
    expect(allowedGatewayPurposes(WHOLE_TOTAL_ORDER, 0n)).toEqual(["full"]);
    expect(allowedGatewayPurposes(WHOLE_TOTAL_ORDER, 1n)).toEqual([]);
    expect(
      allowedGatewayPurposes({ ...WHOLE_TOTAL_ORDER, status: "paid" }, 0n)
    ).toEqual([]);
  });

  test("a whole-total order can never obtain a deposit or a balance by any request", () => {
    for (const settled of [0n, 5_000_00n, 100_000_00n]) {
      expect(
        decideGatewayPurpose(WHOLE_TOTAL_ORDER, settled, "deposit").ok
      ).toBe(false);
      expect(
        decideGatewayPurpose(WHOLE_TOTAL_ORDER, settled, "balance").ok
      ).toBe(false);
    }
    // ... nor can an order with no deposit policy at all.
    const noPolicy = { ...DP_ORDER, dpAmount: null };
    expect(decideGatewayPurpose(noPolicy, 0n, "deposit").ok).toBe(false);
  });

  test("a deposit order admits deposit below the threshold, balance from it up to the total, nothing after", () => {
    expect(allowedGatewayPurposes(DP_ORDER, 0n)).toEqual(["deposit"]);
    expect(allowedGatewayPurposes(DP_ORDER, 29_999_99n)).toEqual(["deposit"]);
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "paid" }, 30_000_00n)
    ).toEqual(["balance"]);
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "processing" }, 99_999_99n)
    ).toEqual(["balance"]);
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "completed" }, 100_000_00n)
    ).toEqual([]);
    // Overpaid is not "owing".
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "paid" }, 120_000_00n)
    ).toEqual([]);
  });

  test("a dead-end order admits nothing; a deposit needs a payable order", () => {
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "cancelled" }, 0n)
    ).toEqual([]);
    expect(
      allowedGatewayPurposes({ ...DP_ORDER, status: "expired" }, 30_000_00n)
    ).toEqual([]);
    expect(allowedGatewayPurposes({ ...DP_ORDER, status: "paid" }, 0n)).toEqual(
      []
    );
  });

  test("a refusal lists what the order does admit instead", () => {
    const refused = decideGatewayPurpose(DP_ORDER, 0n, "balance");
    expect(refused).toEqual({ ok: false, allowed: ["deposit"] });
  });
});

describe("the server-computed expected amount (ADR-0041 D1)", () => {
  test("a deposit is the release threshold minus what is settled, in exact cents", () => {
    const first = decideGatewayPurpose(DP_ORDER, 0n, "deposit");
    expect(first).toMatchObject({ ok: true, expectedAmount: "30000.00" });

    // A part-paid deposit asks for exactly what remains of it.
    const rest = decideGatewayPurpose(DP_ORDER, 10_000_01n, "deposit");
    expect(rest).toMatchObject({ ok: true, expectedAmount: "19999.99" });
  });

  test("a balance is the total minus what is settled", () => {
    const balance = decideGatewayPurpose(
      { ...DP_ORDER, status: "paid" },
      30_000_00n,
      "balance"
    );
    expect(balance).toMatchObject({
      ok: true,
      purpose: "balance",
      expectedAmount: "70000.00"
    });
    expect(balance.ok && balance.expectedCents).toBe(70_000_00n);
  });

  test("no float anywhere: 0.1 + 0.2 style figures stay exact", () => {
    const order = {
      ...DP_ORDER,
      total: "0.30",
      dpAmount: "0.10"
    };
    expect(decideGatewayPurpose(order, 0n, "deposit")).toMatchObject({
      ok: true,
      expectedAmount: "0.10"
    });
    expect(
      decideGatewayPurpose({ ...order, status: "paid" }, 10n, "balance")
    ).toMatchObject({ ok: true, expectedAmount: "0.20" });
  });
});

describe("the amount guard against the session (ADR-0041 D2, C-07)", () => {
  const deposit = { purpose: "deposit", expectedAmount: "30000.00" };

  test("a deposit session accepts exactly its own expected amount, ignoring the order total", () => {
    expect(checkSessionPaymentAmount("30000.00", deposit, "100000.00").ok).toBe(
      true
    );
    expect(checkSessionPaymentAmount("30000", deposit, "100000.00").ok).toBe(
      true
    );
  });

  test("mismatch is rejected in BOTH directions, down to one cent", () => {
    for (const reported of ["29999.99", "30000.01", "1.00", "100000.00"]) {
      const result = checkSessionPaymentAmount(reported, deposit, "100000.00");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("mismatch");
        expect(result.expected).toBe("30000.00");
      }
    }
  });

  test("the whole total is NOT a valid report for a deposit session", () => {
    // The whole-total figure an ordinary order would accept must not credit a
    // deposit session: the expected amount is the only reference.
    expect(
      checkSessionPaymentAmount("100000.00", deposit, "100000.00").ok
    ).toBe(false);
  });

  test("an unparseable report or a missing/zero expected amount fails closed", () => {
    for (const bad of ["", "abc", "-30000", "3e4", "30000.001"]) {
      const result = checkSessionPaymentAmount(bad, deposit, "100000.00");
      expect(result.ok).toBe(false);
    }
    expect(
      checkSessionPaymentAmount(
        "30000.00",
        { purpose: "deposit", expectedAmount: null },
        "100000.00"
      ).ok
    ).toBe(false);
    expect(
      checkSessionPaymentAmount(
        "0.00",
        { purpose: "balance", expectedAmount: "0.00" },
        "100000.00"
      ).ok
    ).toBe(false);
  });

  test("a full session keeps the order-total check: legacy rows and amended totals still mismatch", () => {
    const legacy = { purpose: "full", expectedAmount: null };
    expect(checkSessionPaymentAmount("100000.00", legacy, "100000.00").ok).toBe(
      true
    );
    expect(checkSessionPaymentAmount("99999.99", legacy, "100000.00").ok).toBe(
      false
    );

    const full = { purpose: "full", expectedAmount: "100000.00" };
    expect(checkSessionPaymentAmount("100000.00", full, "100000.00").ok).toBe(
      true
    );
    // The order was amended after the session: a stale callback mismatches.
    expect(checkSessionPaymentAmount("100000.00", full, "120000.00").ok).toBe(
      false
    );
    // ... and so does a figure that matches the (new) total but not the session.
    expect(checkSessionPaymentAmount("120000.00", full, "120000.00").ok).toBe(
      false
    );
  });
});

describe("deriveSettledAt (ADR-0041 D6)", () => {
  const leg = (
    kind: "payment" | "reversal",
    amount: string,
    settledAt: string | null,
    status: "succeeded" | "pending" | "failed" = "succeeded"
  ) => ({ kind, amount, settledAt, status });

  test("null while anything is owed, and for an empty ledger or a free order", () => {
    expect(deriveSettledAt("100.00", [])).toBeNull();
    expect(
      deriveSettledAt("100.00", [
        leg("payment", "30.00", "2026-10-01T10:00:00Z")
      ])
    ).toBeNull();
    expect(deriveSettledAt("0.00", [])).toBeNull();
  });

  test("the time of the leg that took the balance to zero (deposit, then balance)", () => {
    expect(
      deriveSettledAt("100.00", [
        leg("payment", "30.00", "2026-10-01T10:00:00Z"),
        leg("payment", "70.00", "2026-10-08T15:30:00Z")
      ])
    ).toBe("2026-10-08T15:30:00Z");
  });

  test("a pending or failed leg never counts", () => {
    expect(
      deriveSettledAt("100.00", [
        leg("payment", "30.00", "2026-10-01T10:00:00Z"),
        leg("payment", "70.00", null, "pending"),
        leg("payment", "70.00", "2026-10-09T00:00:00Z", "failed")
      ])
    ).toBeNull();
  });

  test("replayed by settled time, not by ledger order (a gateway leg resolves after a later cash leg)", () => {
    expect(
      deriveSettledAt("100.00", [
        // Created first but settled last.
        leg("payment", "30.00", "2026-10-08T12:00:00Z"),
        leg("payment", "70.00", "2026-10-05T09:00:00Z")
      ])
    ).toBe("2026-10-08T12:00:00Z");
  });

  test("a reversal that reopens the balance clears it; the later payment that closes it again sets it", () => {
    const rows = [
      leg("payment", "100.00", "2026-10-01T10:00:00Z"),
      leg("reversal", "40.00", "2026-10-02T10:00:00Z")
    ];
    expect(deriveSettledAt("100.00", rows)).toBeNull();
    expect(
      deriveSettledAt("100.00", [
        ...rows,
        leg("payment", "40.00", "2026-10-03T10:00:00Z")
      ])
    ).toBe("2026-10-03T10:00:00Z");
  });

  test("an overpaid order settled at the leg that first reached the total", () => {
    expect(
      deriveSettledAt("100.00", [
        leg("payment", "100.00", "2026-10-01T10:00:00Z"),
        leg("payment", "30.00", "2026-10-02T10:00:00Z")
      ])
    ).toBe("2026-10-01T10:00:00Z");
  });
});

describe("migration sql/1025", () => {
  const sql = readFileSync(
    join(
      import.meta.dir,
      "../sql/1025_awcms_commerce_gateway_deposit_sessions.sql"
    ),
    "utf8"
  );

  test("adds the two columns, constrains them, and freezes them with a trigger", () => {
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'full'"
    );
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS expected_amount numeric(14, 2)"
    );
    expect(sql).toContain("CHECK (purpose IN ('full', 'deposit', 'balance'))");
    expect(sql).toContain("purpose = 'full' OR expected_amount IS NOT NULL");
    expect(sql).toContain(
      "BEFORE UPDATE ON awcms_commerce_payment_gateway_sessions"
    );
    expect(sql).toContain(
      "NEW.expected_amount IS DISTINCT FROM OLD.expected_amount"
    );
    expect(sql).toContain("NEW.purpose IS DISTINCT FROM OLD.purpose");
  });

  test("never touches an existing migration's table definition or grants", () => {
    const statements = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/DROP TABLE/i);
    expect(statements).not.toMatch(/\bGRANT\b/i);
  });
});
