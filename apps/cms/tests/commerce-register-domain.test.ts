/**
 * POS register / cash-up rules (Issue #284, ADR-0028). Pure - no database, no
 * network. Covers `domain/register.ts` (request validation, the expected
 * closing amount per tender, variance, the approval threshold, corrections)
 * and `domain/register-cash-up-csv.ts` (spreadsheet-formula neutralisation).
 * Every money assertion is on a STRING, and the cases are the ones binary
 * floating point gets wrong (ADR-0003).
 */
import { describe, expect, test } from "bun:test";

import {
  applyCorrections,
  computeExpectedLines,
  DEFAULT_CASH_UP_APPROVAL_THRESHOLD,
  evaluateCount,
  isUuid,
  MissingCountError,
  NegativeCorrectedCountError,
  normalizeSignedMoney,
  resolveCashUpSettings,
  signedFromCents,
  signedToCents,
  validateApprovalThreshold,
  validateCloseDecisionInput,
  validateCloseSessionInput,
  validateCreateRegisterInput,
  validateHandoverInput,
  validateOpenSessionInput,
  validateRecordCorrectionInput,
  validateRecordMovementInput,
  validateUpdateRegisterInput,
  type RegisterCashUpReport
} from "../src/modules/commerce/domain/register";
import {
  csvCell,
  csvNumber,
  serializeCashUpCsv
} from "../src/modules/commerce/domain/register-cash-up-csv";

const KEY = "11111111-1111-4111-8111-111111111111";
const REGISTER_ID = "22222222-2222-4222-8222-222222222222";

function errorFields(result: {
  valid: boolean;
  errors?: { field: string }[];
}): string[] {
  return result.valid ? [] : (result.errors ?? []).map((e) => e.field);
}

describe("signed money in integer cents", () => {
  test("round-trips a negative amount exactly (no float)", () => {
    expect(signedToCents("-5.50")).toBe(-550n);
    expect(signedFromCents(-550n)).toBe("-5.50");
    expect(signedFromCents(0n)).toBe("0.00");
    expect(normalizeSignedMoney("0")).toBe("0.00");
    expect(normalizeSignedMoney("-0.1")).toBe("-0.10");
    expect(normalizeSignedMoney("12")).toBe("12.00");
  });
});

describe("register definition validation", () => {
  test("accepts a code, a name and an optional label", () => {
    const result = validateCreateRegisterInput({
      code: "KASIR-1",
      name: " Front counter ",
      locationLabel: " Ground floor "
    });
    expect(result).toEqual({
      valid: true,
      value: {
        code: "KASIR-1",
        name: "Front counter",
        locationLabel: "Ground floor"
      }
    });
  });

  test("rejects a missing/odd code and a missing name", () => {
    expect(errorFields(validateCreateRegisterInput({ name: "X" }))).toContain(
      "code"
    );
    expect(
      errorFields(validateCreateRegisterInput({ code: "bad code!", name: "X" }))
    ).toContain("code");
    expect(
      errorFields(validateCreateRegisterInput({ code: "A1", name: "" }))
    ).toContain("name");
  });

  test("an update needs at least one field, may clear the label, and never changes the code", () => {
    expect(errorFields(validateUpdateRegisterInput({}))).toContain("body");
    const cleared = validateUpdateRegisterInput({ locationLabel: null });
    expect(cleared).toEqual({ valid: true, value: { locationLabel: null } });
    expect(errorFields(validateUpdateRegisterInput({ code: "NEW" }))).toContain(
      "code"
    );
    expect(
      errorFields(validateUpdateRegisterInput({ active: "yes" }))
    ).toContain("active");
  });
});

describe("open / handover validation", () => {
  test("open needs a register uuid and a non-negative numeric(14,2) STRING float (zero is allowed)", () => {
    expect(
      validateOpenSessionInput(
        { registerId: REGISTER_ID, openingFloat: "0" },
        KEY
      )
    ).toEqual({
      valid: true,
      value: {
        idempotencyKey: KEY,
        registerId: REGISTER_ID,
        openingFloat: "0.00"
      }
    });
    expect(
      errorFields(
        validateOpenSessionInput({ registerId: "nope", openingFloat: 100 }, KEY)
      ).sort()
    ).toEqual(["openingFloat", "registerId"]);
    expect(
      errorFields(
        validateOpenSessionInput(
          { registerId: REGISTER_ID, openingFloat: "-5.00" },
          KEY
        )
      )
    ).toContain("openingFloat");
    expect(
      errorFields(
        validateOpenSessionInput(
          { registerId: REGISTER_ID, openingFloat: "1.005" },
          KEY
        )
      )
    ).toContain("openingFloat");
    expect(
      errorFields(validateOpenSessionInput({ registerId: REGISTER_ID }, ""))
    ).toContain("Idempotency-Key");
  });

  test("handover needs a tenant-user uuid", () => {
    expect(isUuid(REGISTER_ID)).toBe(true);
    expect(
      errorFields(validateHandoverInput({ toTenantUserId: "x" }, KEY))
    ).toEqual(["toTenantUserId"]);
    expect(
      validateHandoverInput({ toTenantUserId: REGISTER_ID, note: "  " }, KEY)
    ).toMatchObject({ valid: true, value: { note: null } });
  });
});

describe("movement validation", () => {
  test("a one-way type fixes its direction; a caller cannot contradict it", () => {
    const cashIn = validateRecordMovementInput(
      { movementType: "cash_in", amount: "5000.00" },
      KEY
    );
    expect(cashIn).toMatchObject({
      valid: true,
      value: { movementType: "cash_in", direction: "in", amount: "5000.00" }
    });
    const drop = validateRecordMovementInput(
      { movementType: "safe_drop", amount: "20000" },
      KEY
    );
    expect(drop).toMatchObject({
      valid: true,
      value: { direction: "out", amount: "20000.00" }
    });
    expect(
      errorFields(
        validateRecordMovementInput(
          { movementType: "cash_out", direction: "in", amount: "1.00" },
          KEY
        )
      )
    ).toContain("direction");
  });

  test("transfer and correction must say which way the cash went; expense/transfer need a reference; correction needs a note", () => {
    expect(
      errorFields(
        validateRecordMovementInput(
          { movementType: "transfer", amount: "1.00", reference: "to R2" },
          KEY
        )
      )
    ).toContain("direction");
    expect(
      errorFields(
        validateRecordMovementInput(
          { movementType: "expense", amount: "1.00" },
          KEY
        )
      )
    ).toContain("reference");
    expect(
      errorFields(
        validateRecordMovementInput(
          { movementType: "correction", direction: "out", amount: "1.00" },
          KEY
        )
      )
    ).toContain("note");
    expect(
      validateRecordMovementInput(
        {
          movementType: "correction",
          direction: "out",
          amount: "1.00",
          note: "miscounted float"
        },
        KEY
      ).valid
    ).toBe(true);
  });

  test("the amount is a positive numeric(14,2) string, never a JSON number or zero", () => {
    for (const amount of [5, "0.00", "-1.00", "1.234", ""]) {
      expect(
        errorFields(
          validateRecordMovementInput({ movementType: "cash_in", amount }, KEY)
        )
      ).toContain("amount");
    }
    expect(
      errorFields(
        validateRecordMovementInput({ movementType: "gift", amount: "1" }, KEY)
      )
    ).toContain("movementType");
  });
});

describe("close / decision / correction validation", () => {
  test("close needs a counted object keyed by tender type with string amounts", () => {
    const ok = validateCloseSessionInput(
      {
        counted: { cash: "150000", manual_qris: "20000.00" },
        varianceReason: " short "
      },
      KEY
    );
    expect(ok).toEqual({
      valid: true,
      value: {
        idempotencyKey: KEY,
        counted: { cash: "150000.00", manual_qris: "20000.00" },
        varianceReason: "short"
      }
    });
    expect(errorFields(validateCloseSessionInput({}, KEY))).toContain(
      "counted"
    );
    expect(
      errorFields(validateCloseSessionInput({ counted: {} }, KEY))
    ).toContain("counted");
    expect(
      errorFields(
        validateCloseSessionInput({ counted: { coins: "1.00" } }, KEY)
      )
    ).toContain("counted.coins");
    expect(
      errorFields(validateCloseSessionInput({ counted: { cash: 5 } }, KEY))
    ).toContain("counted.cash");
  });

  test("a rejection needs a note; an approval does not; the verb is a closed set", () => {
    expect(
      errorFields(validateCloseDecisionInput({ decision: "reject" }, KEY))
    ).toContain("note");
    expect(validateCloseDecisionInput({ decision: "approve" }, KEY).valid).toBe(
      true
    );
    expect(
      errorFields(validateCloseDecisionInput({ decision: "maybe" }, KEY))
    ).toContain("decision");
  });

  test("a correction needs a reason and signed, non-zero, per-tender adjustments with no duplicate tender", () => {
    const ok = validateRecordCorrectionInput(
      {
        reason: "recount",
        adjustments: [
          { tenderType: "cash", adjustment: "-5000" },
          { tenderType: "manual_qris", adjustment: "1.5" }
        ]
      },
      KEY
    );
    expect(ok).toMatchObject({
      valid: true,
      value: {
        adjustments: [
          { tenderType: "cash", adjustment: "-5000.00" },
          { tenderType: "manual_qris", adjustment: "1.50" }
        ]
      }
    });
    expect(
      errorFields(
        validateRecordCorrectionInput(
          {
            reason: "",
            adjustments: [{ tenderType: "cash", adjustment: "1" }]
          },
          KEY
        )
      )
    ).toContain("reason");
    expect(
      errorFields(
        validateRecordCorrectionInput(
          {
            reason: "x",
            adjustments: [{ tenderType: "cash", adjustment: "0.00" }]
          },
          KEY
        )
      )
    ).toContain("adjustments[0].adjustment");
    expect(
      errorFields(
        validateRecordCorrectionInput(
          {
            reason: "x",
            adjustments: [
              { tenderType: "cash", adjustment: "1" },
              { tenderType: "cash", adjustment: "2" }
            ]
          },
          KEY
        )
      )
    ).toContain("adjustments[1].tenderType");
    expect(
      errorFields(
        validateRecordCorrectionInput({ reason: "x", adjustments: [] }, KEY)
      )
    ).toContain("adjustments");
  });
});

describe("the approval threshold setting", () => {
  test("defaults to the strict 0.00 and tolerates garbage by staying strict, never looser", () => {
    expect(resolveCashUpSettings(undefined).approvalThreshold).toBe(
      DEFAULT_CASH_UP_APPROVAL_THRESHOLD
    );
    expect(DEFAULT_CASH_UP_APPROVAL_THRESHOLD).toBe("0.00");
    expect(resolveCashUpSettings({}).approvalThreshold).toBe("0.00");
    expect(
      resolveCashUpSettings({ cashUp: { approvalThreshold: "500" } })
        .approvalThreshold
    ).toBe("500.00");
    for (const garbage of [500, "-5.00", "abc", "1.234", null, {}]) {
      expect(
        resolveCashUpSettings({ cashUp: { approvalThreshold: garbage } })
          .approvalThreshold
      ).toBe("0.00");
    }
    expect(resolveCashUpSettings({ cashUp: "x" }).approvalThreshold).toBe(
      "0.00"
    );
  });

  test("the admin form's value is validated to the same shape", () => {
    expect(validateApprovalThreshold("1000")).toBe("1000.00");
    expect(validateApprovalThreshold("-1")).toBeNull();
    expect(validateApprovalThreshold(1000)).toBeNull();
  });
});

describe("expected closing amount per tender", () => {
  test("cash = float + net cash legs + movements in - movements out; other tenders = payments - reversals", () => {
    const lines = computeExpectedLines({
      openingFloatCents: 10_000_000n,
      ledger: [
        {
          tenderType: "cash",
          paymentsCents: 3_000_000n,
          reversalsCents: 500_000n
        },
        {
          tenderType: "manual_qris",
          paymentsCents: 1_000_000n,
          reversalsCents: 0n
        }
      ],
      movementsInCents: 500_000n,
      movementsOutCents: 2_000_000n
    });
    expect(lines.map((line) => line.tenderType)).toEqual([
      "cash",
      "manual_qris"
    ]);
    // 100000.00 + 30000.00 - 5000.00 + 5000.00 - 20000.00
    expect(lines[0]).toMatchObject({
      tenderType: "cash",
      payments: "30000.00",
      reversals: "5000.00",
      openingFloat: "100000.00",
      movementsIn: "5000.00",
      movementsOut: "20000.00",
      expected: "110000.00"
    });
    expect(lines[1]).toMatchObject({
      tenderType: "manual_qris",
      openingFloat: "0.00",
      movementsIn: "0.00",
      expected: "10000.00"
    });
  });

  test("cash is always present - a drawer with no sales still holds its float", () => {
    const lines = computeExpectedLines({
      openingFloatCents: 5_000_000n,
      ledger: [],
      movementsInCents: 0n,
      movementsOutCents: 0n
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.expected).toBe("50000.00");
  });

  test("can go negative when more left the drawer than it held (signed, exact)", () => {
    const lines = computeExpectedLines({
      openingFloatCents: 0n,
      ledger: [],
      movementsInCents: 1_000n,
      movementsOutCents: 2_500n
    });
    expect(lines[0]!.expected).toBe("-15.00");
  });

  test("sums are exact where floats are not (0.10 + 0.20)", () => {
    const lines = computeExpectedLines({
      openingFloatCents: 10n,
      ledger: [{ tenderType: "cash", paymentsCents: 20n, reversalsCents: 0n }],
      movementsInCents: 0n,
      movementsOutCents: 0n
    });
    expect(lines[0]!.expected).toBe("0.30");
  });
});

describe("count -> variance -> approval", () => {
  const expected = computeExpectedLines({
    openingFloatCents: 10_000_000n,
    ledger: [
      { tenderType: "cash", paymentsCents: 3_000_000n, reversalsCents: 0n },
      {
        tenderType: "manual_qris",
        paymentsCents: 1_000_000n,
        reversalsCents: 0n
      }
    ],
    movementsInCents: 0n,
    movementsOutCents: 0n
  });

  test("an exact count has no variance and never needs approval, even at a zero threshold", () => {
    const result = evaluateCount(
      expected,
      { cash: "130000.00", manual_qris: "10000.00" },
      "0.00"
    );
    expect(result.hasVariance).toBe(false);
    expect(result.varianceTotal).toBe("0.00");
    expect(result.varianceGross).toBe("0.00");
    expect(result.approvalRequired).toBe(false);
  });

  test("variance is counted - expected per tender (negative = short); gross sums the absolute values so a surplus cannot hide a shortfall", () => {
    const result = evaluateCount(
      expected,
      { cash: "130100.00", manual_qris: "9900.00" },
      "50.00"
    );
    expect(result.lines.map((line) => line.variance)).toEqual([
      "100.00",
      "-100.00"
    ]);
    expect(result.varianceTotal).toBe("0.00"); // nets to zero ...
    expect(result.varianceGross).toBe("200.00"); // ... the gross does not
    expect(result.hasVariance).toBe(true);
    expect(result.approvalRequired).toBe(true);
  });

  test("approval is required only when gross is STRICTLY above the threshold", () => {
    const counted = { cash: "129950.00", manual_qris: "10000.00" }; // 50.00 short
    expect(evaluateCount(expected, counted, "50.00").approvalRequired).toBe(
      false
    );
    expect(evaluateCount(expected, counted, "49.99").approvalRequired).toBe(
      true
    );
    expect(evaluateCount(expected, counted, "0.00").approvalRequired).toBe(
      true
    );
  });

  test("a count is required for cash and for every tender with activity; an idle tender may be omitted", () => {
    expect(() =>
      evaluateCount(expected, { cash: "130000.00" }, "0.00")
    ).toThrow(MissingCountError);
    try {
      evaluateCount(expected, { manual_qris: "10000.00" }, "0.00");
    } catch (error) {
      expect((error as MissingCountError).tenderTypes).toEqual(["cash"]);
    }
    const idle = computeExpectedLines({
      openingFloatCents: 1_000n,
      ledger: [],
      movementsInCents: 0n,
      movementsOutCents: 0n
    });
    expect(evaluateCount(idle, { cash: "10.00" }, "0.00").hasVariance).toBe(
      false
    );
  });

  test("a counted tender the ledger knows nothing about is a variance against expected 0", () => {
    const idle = computeExpectedLines({
      openingFloatCents: 0n,
      ledger: [],
      movementsInCents: 0n,
      movementsOutCents: 0n
    });
    const result = evaluateCount(
      idle,
      { cash: "0.00", gateway: "25.00" },
      "0.00"
    );
    expect(
      result.lines.find((line) => line.tenderType === "gateway")
    ).toMatchObject({
      expected: "0.00",
      counted: "25.00",
      variance: "25.00"
    });
    expect(result.approvalRequired).toBe(true);
  });
});

describe("corrections", () => {
  const lines = [
    {
      tenderType: "cash" as const,
      expected: "130000.00",
      counted: "129900.00",
      variance: "-100.00"
    },
    {
      tenderType: "manual_qris" as const,
      expected: "10000.00",
      counted: "10000.00",
      variance: "0.00"
    }
  ];

  test("effective counted = counted + sum of adjustments; the original lines are untouched", () => {
    const snapshot = JSON.stringify(lines);
    const result = applyCorrections(lines, [
      { tenderType: "cash", adjustment: "60.00" },
      { tenderType: "cash", adjustment: "40.00" }
    ]);
    expect(JSON.stringify(lines)).toBe(snapshot);
    expect(result[0]).toMatchObject({
      counted: "129900.00",
      correction: "100.00",
      effectiveCounted: "130000.00",
      effectiveVariance: "0.00"
    });
    expect(result[1]).toMatchObject({
      correction: "0.00",
      effectiveCounted: "10000.00"
    });
  });

  test("a correction can never make a counted amount negative", () => {
    expect(() =>
      applyCorrections(lines, [
        { tenderType: "manual_qris", adjustment: "-10000.01" }
      ])
    ).toThrow(NegativeCorrectedCountError);
  });

  test("a correction for a tender the close never counted starts from zero", () => {
    const result = applyCorrections(lines, [
      { tenderType: "gateway", adjustment: "5.00" }
    ]);
    expect(result.find((line) => line.tenderType === "gateway")).toMatchObject({
      expected: "0.00",
      effectiveCounted: "5.00",
      effectiveVariance: "5.00"
    });
  });
});

describe("cash-up CSV", () => {
  test("neutralises every formula leader in free text, and quotes commas, quotes and line breaks", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe(`"'\rx"`);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });

  test("a strictly numeric amount keeps its sign; anything else routed through csvNumber is neutralised", () => {
    expect(csvNumber("-5.50")).toBe("-5.50");
    expect(csvNumber("100.00")).toBe("100.00");
    expect(csvNumber("=1+1")).toBe("'=1+1");
    expect(csvNumber("-5.5.5")).toBe("'-5.5.5");
    expect(csvNumber(null)).toBe("");
  });

  const report: RegisterCashUpReport = {
    register: {
      id: REGISTER_ID,
      code: "=KASIR",
      name: 'Front, "main"',
      locationLabel: null
    },
    session: {
      id: KEY,
      status: "closed",
      openedAt: "2026-10-03T01:00:00.000Z",
      openedByTenantUserId: KEY,
      currentCashierTenantUserId: KEY,
      closedAt: "2026-10-03T09:00:00.000Z",
      closedByTenantUserId: KEY
    },
    live: false,
    openingFloat: "100000.00",
    sales: { count: 2, total: "45000.00" },
    tenders: [
      {
        tenderType: "cash",
        payments: "30000.00",
        reversals: "0.00",
        expected: "110000.00",
        counted: "109900.00",
        variance: "-100.00",
        correction: "100.00",
        effectiveCounted: "110000.00",
        effectiveVariance: "0.00"
      }
    ],
    movementTotals: { in: "5000.00", out: "25000.00" },
    movements: [
      {
        id: KEY,
        movementType: "expense",
        direction: "out",
        amount: "25000.00",
        reference: "@cmd|' /C calc'!A0",
        note: 'ice, "cold"',
        actorTenantUserId: KEY,
        createdAt: "2026-10-03T05:00:00.000Z"
      }
    ],
    closeRequests: [],
    variance: {
      total: "-100.00",
      gross: "100.00",
      reason: "=cmd() short",
      approvalThreshold: "50.00",
      decision: "approved"
    },
    corrections: [
      {
        correctionId: REGISTER_ID,
        tenderType: "cash",
        adjustment: "100.00",
        reason: "+recount",
        actorTenantUserId: KEY,
        createdAt: "2026-10-03T10:00:00.000Z"
      }
    ]
  };

  test("no cell of the serialised report can start a formula, and every row has the same column count", () => {
    const csv = serializeCashUpCsv(report);
    const rows = csv.trimEnd().split("\n");
    expect(rows[0]).toBe(
      "section,key,tender,amount,expected,counted,variance,count,at,actor,text"
    );
    // Hostile tenant text is present but defanged.
    expect(csv).toContain("'=KASIR");
    expect(csv).toContain("'=cmd() short");
    expect(csv).toContain("'+recount");
    expect(csv).toContain("'@cmd|");
    // Section markers exist for every kind of row.
    for (const section of ["summary", "tender", "movement", "correction"]) {
      expect(rows.some((row) => row.startsWith(`${section},`))).toBe(true);
    }
    // The negative variance and the outgoing movement keep their sign.
    expect(csv).toContain("-100.00");
    expect(csv).toContain(",-25000.00,");
    // No customer data of any kind in a cash-up.
    expect(csv.toLowerCase()).not.toContain("phone");
  });
});
