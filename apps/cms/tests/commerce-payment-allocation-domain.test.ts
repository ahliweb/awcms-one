/**
 * Payment-allocation ledger rules (Issue #285, ADR-0025). Pure — no database,
 * no network. Covers `domain/payment-allocation.ts`: settlement derivation,
 * the derived payment status (including the down-payment release threshold),
 * tender planning (exact-cent split settlement, under/overpayment, change
 * computed from the cash leg only, the explicit due balance) and the two
 * owner-side request validators. Every money assertion is on a STRING, and
 * the cases below are exactly the ones binary floating point gets wrong
 * (ADR-0003).
 */
import { describe, expect, test } from "bun:test";

import {
  computeSettlement,
  confirmationMethodToTender,
  derivePaymentStatus,
  hasReachedRelease,
  InsufficientTenderError,
  InvalidTenderPlanError,
  OverpaymentError,
  planTenders,
  releaseThresholdCents,
  orderPaymentMethodToTender,
  tenderToOrderPaymentMethod,
  toSettlementView,
  validatePosTenders,
  validateRecordPaymentInput,
  validateRecordReversalInput,
  type LedgerRow
} from "../src/modules/commerce/domain/payment-allocation";
import type { ValidationError } from "../src/modules/commerce/domain/payment-allocation";

const KEY = "11111111-1111-4111-8111-111111111111";

const pay = (amount: string, status: LedgerRow["status"] = "succeeded") =>
  ({ kind: "payment", status, amount }) satisfies LedgerRow;
const reversal = (amount: string) =>
  ({ kind: "reversal", status: "succeeded", amount }) satisfies LedgerRow;

const PLAIN: { paymentMethod: string; dpAmount: string | null } = {
  paymentMethod: "manual_bank",
  dpAmount: null
};

// ---------------------------------------------------------------------------
// computeSettlement
// ---------------------------------------------------------------------------

describe("computeSettlement — derived, exact to the cent", () => {
  test("sums succeeded payments minus succeeded reversals; pending/failed never count", () => {
    const settlement = computeSettlement("100.00", [
      pay("60.00"),
      pay("25.50"),
      pay("14.50", "pending"),
      pay("99.00", "failed"),
      reversal("10.00")
    ]);
    expect(settlement.paidCents).toBe(8550n);
    expect(settlement.reversedCents).toBe(1000n);
    expect(settlement.settledCents).toBe(7550n);
    expect(settlement.outstandingCents).toBe(2450n);
    expect(settlement.overpaidCents).toBe(0n);
  });

  test("0.10 + 0.20 settles 0.30 exactly (the float trap)", () => {
    const settlement = computeSettlement("0.30", [pay("0.10"), pay("0.20")]);
    expect(settlement.outstandingCents).toBe(0n);
    expect(toSettlementView(settlement, "paid").paid).toBe("0.30");
  });

  test("overpayment is reported as overpaid, outstanding floors at zero", () => {
    const settlement = computeSettlement("50.00", [pay("50.00"), pay("5.25")]);
    expect(settlement.outstandingCents).toBe(0n);
    expect(settlement.overpaidCents).toBe(525n);
    const view = toSettlementView(settlement, "paid");
    expect(view.outstanding).toBe("0.00");
    expect(view.overpaid).toBe("5.25");
  });

  test("an empty ledger owes the whole total", () => {
    const settlement = computeSettlement("12.34", []);
    expect(settlement.outstandingCents).toBe(1234n);
    expect(toSettlementView(settlement, "unpaid").outstanding).toBe("12.34");
  });

  test("a reversal that takes settled back to zero is exactly zero outstanding-wise", () => {
    const settlement = computeSettlement("40.00", [
      pay("40.00"),
      reversal("40.00")
    ]);
    expect(settlement.settledCents).toBe(0n);
    expect(settlement.outstandingCents).toBe(4000n);
    expect(toSettlementView(settlement, "refunded").settled).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// derivePaymentStatus / release threshold
// ---------------------------------------------------------------------------

describe("derivePaymentStatus — a pure function of the ledger", () => {
  const status = (total: string, rows: LedgerRow[], order = PLAIN) =>
    derivePaymentStatus(computeSettlement(total, rows), { total, ...order });

  test("unpaid -> partially_paid -> paid", () => {
    expect(status("100.00", [])).toBe("unpaid");
    expect(status("100.00", [pay("0.01")])).toBe("partially_paid");
    expect(status("100.00", [pay("99.99")])).toBe("partially_paid");
    expect(status("100.00", [pay("100.00")])).toBe("paid");
    expect(status("100.00", [pay("100.01")])).toBe("paid");
  });

  test("money that came in and went all the way back is refunded; a partial reversal is partially_paid", () => {
    expect(status("100.00", [pay("100.00"), reversal("100.00")])).toBe(
      "refunded"
    );
    expect(status("100.00", [pay("100.00"), reversal("30.00")])).toBe(
      "partially_paid"
    );
  });

  test("a pending leg does not make an order partially paid", () => {
    expect(status("100.00", [pay("100.00", "pending")])).toBe("unpaid");
  });

  test("a zero-total order owes nothing and is paid by definition", () => {
    expect(status("0.00", [])).toBe("paid");
  });

  test("a down-payment order is dp_paid between its down payment and its total", () => {
    const dp = { paymentMethod: "dp", dpAmount: "30.00" };
    expect(status("100.00", [pay("29.99")], dp)).toBe("partially_paid");
    expect(status("100.00", [pay("30.00")], dp)).toBe("dp_paid");
    expect(status("100.00", [pay("99.99")], dp)).toBe("dp_paid");
    expect(status("100.00", [pay("100.00")], dp)).toBe("paid");
  });
});

describe("release threshold — when the order lifecycle may reach paid", () => {
  test("normally the whole total", () => {
    expect(
      releaseThresholdCents({
        total: "100.00",
        paymentMethod: "manual_bank",
        dpAmount: null
      })
    ).toBe(10000n);
    // A `dp_amount` on a non-dp order is informational only.
    expect(
      releaseThresholdCents({
        total: "100.00",
        paymentMethod: "manual_bank",
        dpAmount: "30.00"
      })
    ).toBe(10000n);
  });

  test("a down-payment order is released on its down payment", () => {
    const order = { total: "100.00", paymentMethod: "dp", dpAmount: "30.00" };
    expect(releaseThresholdCents(order)).toBe(3000n);
    expect(
      hasReachedRelease(computeSettlement("100.00", [pay("29.99")]), order)
    ).toBe(false);
    expect(
      hasReachedRelease(computeSettlement("100.00", [pay("30.00")]), order)
    ).toBe(true);
  });

  test("a nonsensical dp (0, or not below the total) falls back to the total", () => {
    for (const dpAmount of ["0.00", "100.00", "150.00"]) {
      expect(
        releaseThresholdCents({
          total: "100.00",
          paymentMethod: "dp",
          dpAmount
        })
      ).toBe(10000n);
    }
  });

  test("a reversal can take an order back below its release point", () => {
    const order = { total: "100.00", paymentMethod: "x", dpAmount: null };
    const settlement = computeSettlement("100.00", [
      pay("100.00"),
      reversal("1.00")
    ]);
    expect(hasReachedRelease(settlement, order)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planTenders
// ---------------------------------------------------------------------------

describe("planTenders — split settlement", () => {
  test("a single cash tender: change = handed over - total", () => {
    const plan = planTenders(
      "37500.00",
      [{ tenderType: "cash", amount: "50000.00", reference: null }],
      { allowDue: false }
    );
    expect(plan.legs).toEqual([
      {
        tenderType: "cash",
        amount: "37500.00",
        tenderedAmount: "50000.00",
        changeAmount: "12500.00",
        reference: null
      }
    ]);
    expect(plan.changeAmount).toBe("12500.00");
    expect(plan.cashTendered).toBe("50000.00");
    expect(plan.dueAmount).toBe("0.00");
  });

  test("exact split: QRIS + cash settle to the cent, no change", () => {
    const plan = planTenders(
      "100000.00",
      [
        { tenderType: "manual_qris", amount: "60000.00", reference: "RRN-1" },
        { tenderType: "cash", amount: "40000.00", reference: null }
      ],
      { allowDue: false }
    );
    expect(plan.legs.map((l) => [l.tenderType, l.amount])).toEqual([
      ["manual_qris", "60000.00"],
      ["cash", "40000.00"]
    ]);
    expect(plan.legs[0]!.reference).toBe("RRN-1");
    expect(plan.changeAmount).toBe("0.00");
    expect(plan.dueAmount).toBe("0.00");
  });

  test("change is computed from the cash leg ONLY, after every non-cash leg", () => {
    // 100.00 owed; 70.00 by transfer leaves 30.00 for cash; 50.00 handed over -> 20.00 change.
    const plan = planTenders(
      "100.00",
      [
        { tenderType: "cash", amount: "50.00", reference: null },
        { tenderType: "manual_bank_transfer", amount: "70.00", reference: null }
      ],
      { allowDue: false }
    );
    const cash = plan.legs.find((l) => l.tenderType === "cash")!;
    expect(cash.amount).toBe("30.00");
    expect(cash.tenderedAmount).toBe("50.00");
    expect(cash.changeAmount).toBe("20.00");
    expect(plan.changeAmount).toBe("20.00");
    // Cash last, regardless of the order the cashier typed them.
    expect(plan.legs[plan.legs.length - 1]!.tenderType).toBe("cash");
  });

  test("non-cash tenders may repeat", () => {
    const plan = planTenders(
      "30.00",
      [
        { tenderType: "manual_qris", amount: "10.10", reference: null },
        { tenderType: "manual_qris", amount: "10.20", reference: null },
        { tenderType: "manual_bank_transfer", amount: "9.70", reference: null }
      ],
      { allowDue: false }
    );
    expect(plan.legs).toHaveLength(3);
    expect(plan.dueAmount).toBe("0.00");
  });

  test("a legacy QRIS payload (no amount) pays exactly the whole bill", () => {
    const plan = planTenders(
      "99999.99",
      [{ tenderType: "manual_qris", amount: null, reference: null }],
      { allowDue: false }
    );
    expect(plan.legs[0]!.amount).toBe("99999.99");
    expect(plan.changeAmount).toBeNull();
    expect(plan.cashTendered).toBeNull();
  });

  test("a null amount is only valid as the sole tender", () => {
    expect(() =>
      planTenders(
        "10.00",
        [
          { tenderType: "manual_qris", amount: null, reference: null },
          { tenderType: "cash", amount: "5.00", reference: null }
        ],
        { allowDue: false }
      )
    ).toThrow(InvalidTenderPlanError);
  });
});

describe("planTenders — under- and overpayment", () => {
  test("a short cash tender is InsufficientTenderError carrying the exact shortfall", () => {
    let caught: unknown;
    try {
      planTenders(
        "20000.01",
        [{ tenderType: "cash", amount: "20000.00", reference: null }],
        { allowDue: false }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientTenderError);
    expect((caught as InsufficientTenderError).shortfall).toBe("0.01");
  });

  test("a shortfall on a non-cash tender is NOT hidden by cash change arithmetic", () => {
    // 100.00 owed; QRIS 30.00 + cash 60.00 = 90.00 -> 10.00 short, change 0.
    let caught: unknown;
    try {
      planTenders(
        "100.00",
        [
          { tenderType: "manual_qris", amount: "30.00", reference: null },
          { tenderType: "cash", amount: "60.00", reference: null }
        ],
        { allowDue: false }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientTenderError);
    expect((caught as InsufficientTenderError).shortfall).toBe("10.00");
  });

  test("non-cash tenders above the total are OverpaymentError — only cash may exceed, as change", () => {
    let caught: unknown;
    try {
      planTenders(
        "100.00",
        [
          { tenderType: "manual_qris", amount: "60.00", reference: null },
          {
            tenderType: "manual_bank_transfer",
            amount: "40.01",
            reference: null
          }
        ],
        { allowDue: false }
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OverpaymentError);
    expect((caught as OverpaymentError).outstanding).toBe("100.00");
    expect((caught as OverpaymentError).attempted).toBe("100.01");
  });

  test("a cash tender when non-cash already covered the total would only manufacture change — refused", () => {
    expect(() =>
      planTenders(
        "100.00",
        [
          { tenderType: "manual_qris", amount: "100.00", reference: null },
          { tenderType: "cash", amount: "20.00", reference: null }
        ],
        { allowDue: false }
      )
    ).toThrow(InvalidTenderPlanError);
  });

  test("at most one cash tender", () => {
    expect(() =>
      planTenders(
        "100.00",
        [
          { tenderType: "cash", amount: "50.00", reference: null },
          { tenderType: "cash", amount: "50.00", reference: null }
        ],
        { allowDue: false }
      )
    ).toThrow(InvalidTenderPlanError);
  });

  test("zero and malformed tender amounts are refused", () => {
    expect(() =>
      planTenders(
        "10.00",
        [{ tenderType: "manual_qris", amount: "0.00", reference: null }],
        { allowDue: false }
      )
    ).toThrow(InvalidTenderPlanError);
    expect(() =>
      planTenders(
        "10.00",
        [{ tenderType: "manual_qris", amount: "1,00", reference: null }],
        { allowDue: false }
      )
    ).toThrow(RangeError);
    expect(() =>
      planTenders(
        "10.00",
        [{ tenderType: "cash", amount: "1.000", reference: null }],
        { allowDue: false }
      )
    ).toThrow(RangeError);
  });
});

describe("planTenders — explicit due balance", () => {
  test("allowDue lets a partial cash payment finalize with the balance due", () => {
    const plan = planTenders(
      "100.00",
      [{ tenderType: "cash", amount: "40.00", reference: null }],
      { allowDue: true }
    );
    expect(plan.legs[0]!.amount).toBe("40.00");
    expect(plan.legs[0]!.changeAmount).toBe("0.00");
    expect(plan.dueAmount).toBe("60.00");
  });

  test("allowDue with no tenders at all is a sale entirely on account", () => {
    const plan = planTenders("100.00", [], { allowDue: true });
    expect(plan.legs).toEqual([]);
    expect(plan.dueAmount).toBe("100.00");
    expect(plan.changeAmount).toBeNull();
  });

  test("allowDue does not excuse overpayment", () => {
    expect(() =>
      planTenders(
        "10.00",
        [{ tenderType: "manual_qris", amount: "10.01", reference: null }],
        { allowDue: true }
      )
    ).toThrow(OverpaymentError);
  });

  test("a fully covered sale has no due balance even when allowDue is set", () => {
    const plan = planTenders(
      "10.00",
      [{ tenderType: "cash", amount: "10.00", reference: null }],
      { allowDue: true }
    );
    expect(plan.dueAmount).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// validators
// ---------------------------------------------------------------------------

describe("validateRecordPaymentInput", () => {
  test("accepts a staff-recordable tender with a numeric(14,2) string", () => {
    const result = validateRecordPaymentInput(
      {
        tenderType: "manual_bank_transfer",
        amount: "50000",
        reference: "  TRX-9  ",
        note: ""
      },
      `  ${KEY}  `
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).toEqual({
      idempotencyKey: KEY,
      tenderType: "manual_bank_transfer",
      amount: "50000.00",
      reference: "TRX-9",
      note: null
    });
  });

  test("a gateway tender cannot be typed by staff, and neither can an unknown one (store_credit / gift_card joined the recordable tenders with Issue #288 and need a code)", () => {
    for (const tenderType of ["gateway", "voucher", "", 5, undefined]) {
      const result = validateRecordPaymentInput(
        { tenderType, amount: "1.00" },
        KEY
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((e: ValidationError) => e.field)).toContain(
          "tenderType"
        );
      }
    }
  });

  test("amount must be a positive numeric(14,2) STRING — never a JSON number", () => {
    for (const amount of [
      100,
      "0",
      "0.00",
      "-5.00",
      "1.234",
      "abc",
      "",
      null
    ]) {
      const result = validateRecordPaymentInput(
        { tenderType: "cash", amount },
        KEY
      );
      expect(result.valid).toBe(false);
    }
  });

  test("the Idempotency-Key is required and bounded", () => {
    expect(
      validateRecordPaymentInput({ tenderType: "cash", amount: "1.00" }, "")
        .valid
    ).toBe(false);
    expect(
      validateRecordPaymentInput(
        { tenderType: "cash", amount: "1.00" },
        "k".repeat(201)
      ).valid
    ).toBe(false);
  });

  test("reference and note are length-bounded", () => {
    expect(
      validateRecordPaymentInput(
        { tenderType: "cash", amount: "1.00", reference: "r".repeat(101) },
        KEY
      ).valid
    ).toBe(false);
    expect(
      validateRecordPaymentInput(
        { tenderType: "cash", amount: "1.00", note: "n".repeat(501) },
        KEY
      ).valid
    ).toBe(false);
  });
});

describe("validateRecordReversalInput", () => {
  test("the reason is mandatory; the amount is optional (null = everything reversible)", () => {
    const ok = validateRecordReversalInput(
      { note: "  customer returned goods " },
      KEY
    );
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.value.amount).toBeNull();
      expect(ok.value.note).toBe("customer returned goods");
    }

    for (const body of [{}, { note: "" }, { note: "   " }, { note: 5 }]) {
      const result = validateRecordReversalInput(body, KEY);
      expect(result.valid).toBe(false);
    }
  });

  test("a given amount must be a positive numeric(14,2) string", () => {
    const ok = validateRecordReversalInput(
      { amount: "10.5", note: "why" },
      KEY
    );
    expect(ok.valid).toBe(true);
    if (ok.valid) expect(ok.value.amount).toBe("10.50");
    for (const amount of [10, "0.00", "-1", "1.001"]) {
      expect(
        validateRecordReversalInput({ amount, note: "why" }, KEY).valid
      ).toBe(false);
    }
  });
});

describe("validatePosTenders", () => {
  test("accepts the explicit tenders[] shape and normalises amounts", () => {
    const errors: ValidationError[] = [];
    const tenders = validatePosTenders(
      [
        { tenderType: "manual_qris", amount: "60000", reference: " RRN " },
        { tenderType: "cash", amount: "40000.5" }
      ],
      errors
    );
    expect(errors).toEqual([]);
    expect(tenders).toEqual([
      { tenderType: "manual_qris", amount: "60000.00", reference: "RRN" },
      { tenderType: "cash", amount: "40000.50", reference: null }
    ]);
  });

  test("rejects non-arrays, bad tenders, JSON-number amounts and more than ten entries", () => {
    const run = (value: unknown) => {
      const errors: ValidationError[] = [];
      validatePosTenders(value, errors);
      return errors;
    };
    expect(run("cash").length).toBeGreaterThan(0);
    expect(run([null]).length).toBeGreaterThan(0);
    expect(
      run([{ tenderType: "gateway", amount: "1.00" }]).length
    ).toBeGreaterThan(0);
    expect(run([{ tenderType: "cash", amount: 5 }]).length).toBeGreaterThan(0);
    expect(
      run(
        Array.from({ length: 11 }, () => ({
          tenderType: "cash",
          amount: "1.00"
        }))
      ).length
    ).toBeGreaterThan(0);
  });
});

describe("small mappers", () => {
  test("the legacy payment_method hint for each tender", () => {
    expect(tenderToOrderPaymentMethod("cash")).toBe("cash");
    expect(tenderToOrderPaymentMethod("manual_qris")).toBe("manual_qris");
    expect(tenderToOrderPaymentMethod("manual_bank_transfer")).toBe(
      "manual_bank"
    );
    expect(tenderToOrderPaymentMethod("gateway")).toBe("gateway");
  });

  test("a storefront confirmation maps onto a ledger tender", () => {
    expect(confirmationMethodToTender("manual_qris")).toBe("manual_qris");
    expect(confirmationMethodToTender("manual_bank")).toBe(
      "manual_bank_transfer"
    );
  });
});

describe("orderPaymentMethodToTender (manual mark-paid, ADR-0025 review fix)", () => {
  test("maps each order payment method to the ledger tender that fits it", () => {
    expect(orderPaymentMethodToTender("cash")).toBe("cash");
    expect(orderPaymentMethodToTender("manual_qris")).toBe("manual_qris");
    expect(orderPaymentMethodToTender("gateway")).toBe("gateway");
    expect(orderPaymentMethodToTender("manual_bank")).toBe(
      "manual_bank_transfer"
    );
    expect(orderPaymentMethodToTender("dp")).toBe("manual_bank_transfer");
  });
});
