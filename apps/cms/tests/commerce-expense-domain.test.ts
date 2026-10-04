/**
 * Expenses (Issue #294, epic #281, ADR-0031) - the PURE half: request
 * validation, the approval decision, the segregation-of-duties rule, the tenant
 * threshold setting, report arithmetic and the CSV. No database, no network.
 */
import { describe, expect, test } from "bun:test";

import {
  approvalSegregationViolation,
  decidePosting,
  DEFAULT_EXPENSE_APPROVAL_THRESHOLD,
  exceedsApprovalThreshold,
  expenseMovementReference,
  foldExpenseTotals,
  MAX_EXPENSE_REPORT_DAYS,
  parseCalendarDate,
  parseExpenseListFilters,
  parseExpenseReportRange,
  resolveExpenseSettings,
  validateAttachReceiptInput,
  validateCreateExpenseCategoryInput,
  validateCreateExpenseInput,
  validateExpenseApprovalThreshold,
  validateExpenseDecisionInput,
  validateKeyedInput,
  validateReverseExpenseInput,
  validateUpdateExpenseCategoryInput,
  validateUpdateExpenseInput
} from "../src/modules/commerce/domain/expense";
import {
  EXPENSE_CSV_COLUMNS,
  serializeExpenseCsv,
  type ExpenseCsvRow
} from "../src/modules/commerce/domain/expense-csv";

const NOW = new Date("2026-10-03T03:00:00.000Z");
const CATEGORY = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CREATOR = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

const validBody = () => ({
  categoryId: CATEGORY,
  amount: "25000.50",
  tenderType: "cash",
  occurredOn: "2026-10-03",
  description: "Ice for the cooler",
  payeeName: "Pak Budi",
  registerSessionId: SESSION
});

describe("validateCreateExpenseInput", () => {
  test("accepts a complete drawer expense and normalises the money", () => {
    const result = validateCreateExpenseInput(
      { ...validBody(), amount: "25000.5" },
      "key-1",
      NOW
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.amount).toBe("25000.50");
    expect(result.value.idempotencyKey).toBe("key-1");
    expect(result.value.registerSessionId).toBe(SESSION);
  });

  test("a missing Idempotency-Key is a validation error, never a silent pass", () => {
    const result = validateCreateExpenseInput(validBody(), "", NOW);
    expect(result.valid).toBe(false);
  });

  test("money must be a numeric string, never a JSON number, and positive", () => {
    for (const amount of [25000, "0", "0.00", "-5", "1e3", "12.345", ""]) {
      const result = validateCreateExpenseInput(
        { ...validBody(), amount },
        "k",
        NOW
      );
      expect(result.valid).toBe(false);
    }
  });

  test("only staff-recordable tenders; a gateway expense is refused", () => {
    for (const tenderType of ["gateway", "card", "", undefined]) {
      expect(
        validateCreateExpenseInput(
          { ...validBody(), tenderType, registerSessionId: null },
          "k",
          NOW
        ).valid
      ).toBe(false);
    }
    for (const tenderType of ["cash", "manual_qris", "manual_bank_transfer"]) {
      expect(
        validateCreateExpenseInput(
          { ...validBody(), tenderType, registerSessionId: null },
          "k",
          NOW
        ).valid
      ).toBe(true);
    }
  });

  test("a drawer expense must be paid in cash", () => {
    const result = validateCreateExpenseInput(
      { ...validBody(), tenderType: "manual_qris" },
      "k",
      NOW
    );
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.field === "tenderType")).toBe(true);
  });

  test("the date must be a real calendar date and not in the future", () => {
    for (const occurredOn of [
      "2026-02-30",
      "03-10-2026",
      "2026-13-01",
      20261003
    ]) {
      expect(
        validateCreateExpenseInput({ ...validBody(), occurredOn }, "k", NOW)
          .valid
      ).toBe(false);
    }
    // One day of slack for a client ahead of UTC; two days ahead is refused.
    expect(
      validateCreateExpenseInput(
        { ...validBody(), occurredOn: "2026-10-04" },
        "k",
        NOW
      ).valid
    ).toBe(true);
    expect(
      validateCreateExpenseInput(
        { ...validBody(), occurredOn: "2026-10-05" },
        "k",
        NOW
      ).valid
    ).toBe(false);
  });

  test("description is required and bounded; payee is optional and bounded", () => {
    expect(
      validateCreateExpenseInput(
        { ...validBody(), description: "  " },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateExpenseInput(
        { ...validBody(), description: "x".repeat(501) },
        "k",
        NOW
      ).valid
    ).toBe(false);
    const noPayee = validateCreateExpenseInput(
      { ...validBody(), payeeName: undefined },
      "k",
      NOW
    );
    expect(noPayee.valid && noPayee.value.payeeName).toBe(null);
    expect(
      validateCreateExpenseInput(
        { ...validBody(), payeeName: "x".repeat(121) },
        "k",
        NOW
      ).valid
    ).toBe(false);
  });

  test("ids must be UUIDs", () => {
    expect(
      validateCreateExpenseInput(
        { ...validBody(), categoryId: "nope" },
        "k",
        NOW
      ).valid
    ).toBe(false);
    expect(
      validateCreateExpenseInput(
        { ...validBody(), registerSessionId: "nope" },
        "k",
        NOW
      ).valid
    ).toBe(false);
  });
});

describe("validateUpdateExpenseInput", () => {
  test("an empty patch is an error; a partial patch is returned as sent", () => {
    expect(validateUpdateExpenseInput({}, NOW).valid).toBe(false);
    const result = validateUpdateExpenseInput(
      { amount: "10.00", registerSessionId: null },
      NOW
    );
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value).toEqual({ amount: "10.00", registerSessionId: null });
  });

  test("each supplied field is validated", () => {
    expect(validateUpdateExpenseInput({ amount: 5 }, NOW).valid).toBe(false);
    expect(validateUpdateExpenseInput({ occurredOn: "x" }, NOW).valid).toBe(
      false
    );
    expect(
      validateUpdateExpenseInput({ tenderType: "gateway" }, NOW).valid
    ).toBe(false);
    expect(validateUpdateExpenseInput({ description: "" }, NOW).valid).toBe(
      false
    );
  });
});

describe("posting decision and segregation of duties", () => {
  const base = {
    creatorTenantUserId: CREATOR,
    actorTenantUserId: CREATOR,
    actorCanApprove: false
  };

  test("within the threshold (inclusive) an expense is auto-approved, even by its creator", () => {
    expect(
      decidePosting({ ...base, amount: "50.00", threshold: "50.00" })
    ).toBe("auto");
    expect(
      decidePosting({ ...base, amount: "49.99", threshold: "50.00" })
    ).toBe("auto");
  });

  test("above the threshold the creator can never approve their own expense, approver or not", () => {
    expect(
      decidePosting({
        ...base,
        amount: "50.01",
        threshold: "50.00",
        actorCanApprove: true
      })
    ).toBe("pending");
    expect(
      decidePosting({
        ...base,
        amount: "50.01",
        threshold: "50.00",
        actorCanApprove: false
      })
    ).toBe("pending");
  });

  test("above the threshold a different poster who holds the approve key posts in one step", () => {
    expect(
      decidePosting({
        amount: "50.01",
        threshold: "50.00",
        creatorTenantUserId: CREATOR,
        actorTenantUserId: OTHER,
        actorCanApprove: true
      })
    ).toBe("approved");
    expect(
      decidePosting({
        amount: "50.01",
        threshold: "50.00",
        creatorTenantUserId: CREATOR,
        actorTenantUserId: OTHER,
        actorCanApprove: false
      })
    ).toBe("pending");
  });

  test("the strict default threshold (0.00) sends every expense to a second person", () => {
    expect(DEFAULT_EXPENSE_APPROVAL_THRESHOLD).toBe("0.00");
    expect(exceedsApprovalThreshold("0.01", "0.00")).toBe(true);
    expect(exceedsApprovalThreshold("0.00", "0.00")).toBe(false);
  });

  test("the amount comparison is exact cents, never floating point", () => {
    expect(exceedsApprovalThreshold("0.30", "0.10")).toBe(true);
    expect(exceedsApprovalThreshold("99999999999.99", "99999999999.98")).toBe(
      true
    );
    expect(exceedsApprovalThreshold("99999999999.98", "99999999999.98")).toBe(
      false
    );
  });

  test("an approver may be neither the creator nor the submitter", () => {
    expect(
      approvalSegregationViolation({
        creatorTenantUserId: CREATOR,
        submitterTenantUserId: OTHER,
        approverTenantUserId: CREATOR
      })
    ).toBe("creator");
    expect(
      approvalSegregationViolation({
        creatorTenantUserId: CREATOR,
        submitterTenantUserId: OTHER,
        approverTenantUserId: OTHER
      })
    ).toBe("submitter");
    expect(
      approvalSegregationViolation({
        creatorTenantUserId: CREATOR,
        submitterTenantUserId: OTHER,
        approverTenantUserId: "55555555-5555-4555-8555-555555555555"
      })
    ).toBe(null);
  });
});

describe("decision, reversal, keyed and receipt inputs", () => {
  test("a rejection needs a note; an approval does not", () => {
    expect(
      validateExpenseDecisionInput({ decision: "reject" }, "k").valid
    ).toBe(false);
    expect(
      validateExpenseDecisionInput(
        { decision: "reject", note: "no receipt" },
        "k"
      ).valid
    ).toBe(true);
    expect(
      validateExpenseDecisionInput({ decision: "approve" }, "k").valid
    ).toBe(true);
    expect(validateExpenseDecisionInput({ decision: "maybe" }, "k").valid).toBe(
      false
    );
    expect(
      validateExpenseDecisionInput({ decision: "approve" }, "").valid
    ).toBe(false);
  });

  test("a reversal needs a reason", () => {
    expect(validateReverseExpenseInput({}, "k").valid).toBe(false);
    expect(
      validateReverseExpenseInput({ reason: "entered twice" }, "k").valid
    ).toBe(true);
    expect(
      validateReverseExpenseInput({ reason: "x".repeat(501) }, "k").valid
    ).toBe(false);
  });

  test("post and cancel carry only the key", () => {
    expect(validateKeyedInput("").valid).toBe(false);
    expect(validateKeyedInput("abc").valid).toBe(true);
  });

  test("a receipt is a media object UUID", () => {
    expect(validateAttachReceiptInput({}).valid).toBe(false);
    expect(validateAttachReceiptInput({ mediaObjectId: "x" }).valid).toBe(
      false
    );
    expect(validateAttachReceiptInput({ mediaObjectId: CATEGORY }).valid).toBe(
      true
    );
  });
});

describe("categories", () => {
  test("code shape and required name", () => {
    expect(
      validateCreateExpenseCategoryInput({ code: "ICE", name: "Ice" }).valid
    ).toBe(true);
    expect(
      validateCreateExpenseCategoryInput({ code: "-bad", name: "x" }).valid
    ).toBe(false);
    expect(
      validateCreateExpenseCategoryInput({ code: "A B", name: "x" }).valid
    ).toBe(false);
    expect(validateCreateExpenseCategoryInput({ code: "ICE" }).valid).toBe(
      false
    );
  });

  test("a code never changes; an empty patch is an error", () => {
    expect(validateUpdateExpenseCategoryInput({ code: "NEW" }).valid).toBe(
      false
    );
    expect(validateUpdateExpenseCategoryInput({}).valid).toBe(false);
    expect(validateUpdateExpenseCategoryInput({ active: false }).valid).toBe(
      true
    );
    expect(validateUpdateExpenseCategoryInput({ active: "no" }).valid).toBe(
      false
    );
  });
});

describe("the tenant threshold setting", () => {
  test("defaults strict and reads a valid value", () => {
    expect(resolveExpenseSettings(undefined).approvalThreshold).toBe("0.00");
    expect(resolveExpenseSettings({}).approvalThreshold).toBe("0.00");
    expect(
      resolveExpenseSettings({ expenses: { approvalThreshold: "50000" } })
        .approvalThreshold
    ).toBe("50000.00");
  });

  test("a corrupt value falls back to the strict default (it can only make posting stricter)", () => {
    for (const approvalThreshold of [
      "-5",
      "abc",
      50000,
      null,
      "1e3",
      "1.234"
    ]) {
      expect(
        resolveExpenseSettings({ expenses: { approvalThreshold } })
          .approvalThreshold
      ).toBe("0.00");
    }
    expect(resolveExpenseSettings({ expenses: "x" }).approvalThreshold).toBe(
      "0.00"
    );
  });

  test("the admin form's value is validated before it is PATCHed", () => {
    expect(validateExpenseApprovalThreshold("100")).toBe("100.00");
    expect(validateExpenseApprovalThreshold("-1")).toBe(null);
    expect(validateExpenseApprovalThreshold(100)).toBe(null);
  });
});

describe("list and report ranges", () => {
  test("calendar dates", () => {
    expect(parseCalendarDate("2026-02-28")).not.toBe(null);
    expect(parseCalendarDate("2026-02-29")).toBe(null);
    expect(parseCalendarDate("2028-02-29")).not.toBe(null);
    expect(parseCalendarDate(null)).toBe(null);
  });

  test("list filters accept known values and reject malformed ones", () => {
    const ok = parseExpenseListFilters(
      new URLSearchParams(
        `status=posted&categoryId=${CATEGORY}&from=2026-10-01&to=2026-10-31`
      )
    );
    expect(ok.valid).toBe(true);
    expect(
      parseExpenseListFilters(new URLSearchParams("status=nope")).valid
    ).toBe(false);
    expect(
      parseExpenseListFilters(new URLSearchParams("categoryId=x")).valid
    ).toBe(false);
    expect(
      parseExpenseListFilters(
        new URLSearchParams("from=2026-10-31&to=2026-10-01")
      ).valid
    ).toBe(false);
    expect(parseExpenseListFilters(new URLSearchParams("")).valid).toBe(true);
  });

  test("a report range is required, ordered and bounded", () => {
    expect(parseExpenseReportRange(new URLSearchParams("")).valid).toBe(false);
    expect(
      parseExpenseReportRange(new URLSearchParams("from=2026-10-01")).valid
    ).toBe(false);
    expect(
      parseExpenseReportRange(
        new URLSearchParams("from=2026-10-31&to=2026-10-01")
      ).valid
    ).toBe(false);
    expect(
      parseExpenseReportRange(
        new URLSearchParams("from=2026-10-01&to=2026-10-31")
      ).valid
    ).toBe(true);
    // Exactly the cap is fine; one day more is refused.
    expect(MAX_EXPENSE_REPORT_DAYS).toBe(366);
    expect(
      parseExpenseReportRange(
        new URLSearchParams("from=2026-01-01&to=2027-01-01")
      ).valid
    ).toBe(true);
    expect(
      parseExpenseReportRange(
        new URLSearchParams("from=2026-01-01&to=2027-01-02")
      ).valid
    ).toBe(false);
  });
});

describe("report arithmetic", () => {
  test("totals fold in exact cents, posted and reversed kept apart", () => {
    const folded = foldExpenseTotals([
      {
        categoryId: "b",
        tenderType: "cash",
        status: "posted",
        amount: "0.10",
        count: 1
      },
      {
        categoryId: "b",
        tenderType: "manual_qris",
        status: "posted",
        amount: "0.20",
        count: 1
      },
      {
        categoryId: "a",
        tenderType: "cash",
        status: "posted",
        amount: "1000000000.01",
        count: 2
      },
      {
        categoryId: "a",
        tenderType: "cash",
        status: "reversed",
        amount: "5.55",
        count: 1
      }
    ]);
    // 0.1 + 0.2 is exactly 0.30 here (it is 0.30000000000000004 in floating point).
    expect(
      folded.byCategory.find((c) => c.categoryId === "b")?.postedTotal
    ).toBe("0.30");
    expect(folded.postedTotal).toBe("1000000000.31");
    expect(folded.reversedTotal).toBe("5.55");
    expect(folded.byCategory.map((c) => c.categoryId)).toEqual(["a", "b"]);
    expect(folded.byCategory[0]).toMatchObject({
      postedCount: 2,
      reversedCount: 1,
      reversedTotal: "5.55"
    });
  });

  test("the movement reference is a stable, short, non-sensitive code", () => {
    expect(
      expenseMovementReference("abcdef12-3456-4789-8abc-def012345678")
    ).toBe("EXP-ABCDEF12");
  });
});

describe("the expense CSV", () => {
  const row = (overrides: Partial<ExpenseCsvRow> = {}): ExpenseCsvRow => ({
    id: "abcdef12-3456-4789-8abc-def012345678",
    occurredOn: "2026-10-03",
    status: "posted",
    categoryCode: "ICE",
    categoryName: "Ice",
    amount: "25000.50",
    tenderType: "cash",
    registerSessionId: null,
    payeeName: null,
    description: "Ice",
    createdByTenantUserId: CREATOR,
    postedAt: "2026-10-03T03:00:00.000Z",
    decision: "auto",
    reversedAt: null,
    reversalReason: null,
    hasReceipt: false,
    ...overrides
  });

  test("header, row count and a stable column order", () => {
    const csv = serializeExpenseCsv([row(), row()]);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(EXPENSE_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(3);
  });

  test("every free-text cell is formula-neutralised; a number stays a number", () => {
    const csv = serializeExpenseCsv([
      row({
        description: '=HYPERLINK("http://evil")',
        payeeName: "+62812",
        categoryName: "@SUM(A1)",
        reversalReason: "-cmd|' /C calc'!A0",
        amount: "-12.50"
      })
    ]);
    const body = csv.split("\n")[1]!;
    expect(body).toContain("'=HYPERLINK");
    expect(body).toContain("'+62812");
    expect(body).toContain("'@SUM(A1)");
    expect(body).toContain("'-cmd");
    // A strictly numeric amount is not prefixed.
    expect(body).toContain(",-12.50,");
    // No cell begins with a live formula character.
    for (const cell of body.split(",")) {
      expect(/^[=+@]/.test(cell.replace(/^"/, ""))).toBe(false);
    }
  });

  test("a receipt is only ever a boolean - never a URL or media key", () => {
    const csv = serializeExpenseCsv([row({ hasReceipt: true })]);
    expect(csv).toContain("true");
    expect(csv).not.toContain("http");
    expect(csv).not.toContain("news-media");
  });
});
