/**
 * Pure unit tests for the booking cancellation rules (Issue #381, ADR-0045
 * D6/D8, threat controls C-10, C-37, C-40). No database: the quote arithmetic
 * with its edges (window boundaries, a start in the past, zero paid,
 * deposit-only, per-night, rounding), the policy draft validation, the strict
 * cancel schemas (a guest can never send `final_refund` or `amount`) and the
 * refusal mapping.
 */
import { describe, expect, test } from "bun:test";

import type { BookingRefusal } from "../src/modules/_shared/ports/booking-port";
import {
  CANCELLATION_POLICY_MAX_WINDOWS,
  basisPointsToPercent,
  cancelRefusalHttp,
  computeCancellationRefund,
  decisionSourceKey,
  hoursBeforeStart,
  matchWindow,
  percentToBasisPoints,
  shareOfCents,
  splitCents,
  triggerKindFor,
  validateCustomerCancelRequest,
  validatePolicyDraftInput,
  validateStaffCancelRequest,
  windowsAreMonotone,
  type CancellationRules
} from "../src/modules/commerce/domain/booking-cancellation";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 18, 3, 0, 0);

const STANDARD: CancellationRules = {
  refundBasis: "whole_stay",
  windows: [
    { minHoursBeforeStart: 168, refundableBp: 10_000 }, // 7 days: 100%
    { minHoursBeforeStart: 48, refundableBp: 5_000 } // 2 days: 50%
  ]
};

function refund(
  paidCents: number,
  hoursAhead: number,
  rules: CancellationRules | null = STANDARD,
  nights = 1
) {
  return computeCancellationRefund({
    amountPaidCents: BigInt(paidCents),
    startsAtMs: NOW + hoursAhead * HOUR,
    nowMs: NOW,
    rules,
    nights
  });
}

describe("percent and cents helpers", () => {
  test("percent <-> basis points is exact and closed", () => {
    expect(percentToBasisPoints("0")).toBe(0);
    expect(percentToBasisPoints("100")).toBe(10_000);
    expect(percentToBasisPoints("100.00")).toBe(10_000);
    expect(percentToBasisPoints("33.33")).toBe(3_333);
    expect(percentToBasisPoints("5.5")).toBe(550);
    expect(percentToBasisPoints("100.01")).toBeNull();
    expect(percentToBasisPoints("101")).toBeNull();
    expect(percentToBasisPoints("-1")).toBeNull();
    expect(percentToBasisPoints("1.234")).toBeNull();
    expect(percentToBasisPoints("abc")).toBeNull();
    expect(basisPointsToPercent(3_333)).toBe("33.33");
    expect(basisPointsToPercent(10_000)).toBe("100.00");
    expect(basisPointsToPercent(5)).toBe("0.05");
  });

  test("a share rounds half up to the cent and never exceeds the amount", () => {
    expect(shareOfCents(1_000n, 5_000)).toBe(500n);
    expect(shareOfCents(1n, 5_000)).toBe(1n); // 0.5 -> 1
    expect(shareOfCents(1n, 4_999)).toBe(0n);
    expect(shareOfCents(10_001n, 10_000)).toBe(10_001n);
    expect(shareOfCents(0n, 10_000)).toBe(0n);
  });

  test("splitCents adds up exactly however it is split", () => {
    for (const [total, parts] of [
      [100n, 3],
      [1n, 5],
      [999_999n, 7],
      [0n, 4],
      [50_000_000n, 13]
    ] as const) {
      const split = splitCents(total, parts);
      expect(split).toHaveLength(parts);
      expect(split.reduce((a, b) => a + b, 0n)).toBe(total);
      // The first parts carry the odd cents: no part differs from another by more than one.
      expect(split[0]! - split[parts - 1]!).toBeLessThanOrEqual(1n);
    }
  });
});

describe("hours before start and the window match (the boundaries)", () => {
  test("whole hours, floored; negative after the start", () => {
    expect(hoursBeforeStart(NOW + 5 * HOUR, NOW)).toBe(5);
    expect(hoursBeforeStart(NOW + 5 * HOUR - 1, NOW)).toBe(4);
    expect(hoursBeforeStart(NOW, NOW)).toBe(0);
    expect(hoursBeforeStart(NOW - 1, NOW)).toBe(-1);
    expect(hoursBeforeStart(NOW - 2 * HOUR, NOW)).toBe(-2);
  });

  test("the first window the notice satisfies applies; exactly the minimum matches", () => {
    expect(matchWindow(STANDARD.windows, 168)?.refundableBp).toBe(10_000);
    expect(matchWindow(STANDARD.windows, 167)?.refundableBp).toBe(5_000);
    expect(matchWindow(STANDARD.windows, 48)?.refundableBp).toBe(5_000);
    expect(matchWindow(STANDARD.windows, 47)).toBeNull();
    expect(matchWindow(STANDARD.windows, 100_000)?.refundableBp).toBe(10_000);
  });

  test("window order in the input does not matter", () => {
    const reversed = [...STANDARD.windows].reverse();
    expect(matchWindow(reversed, 60)?.refundableBp).toBe(5_000);
    expect(matchWindow(reversed, 200)?.refundableBp).toBe(10_000);
  });

  test("a zero-hour window matches every cancellation up to the start, but not after it", () => {
    const windows = [{ minHoursBeforeStart: 0, refundableBp: 2_500 }];
    expect(matchWindow(windows, 0)?.refundableBp).toBe(2_500);
    expect(matchWindow(windows, 30)?.refundableBp).toBe(2_500);
    expect(matchWindow(windows, -1)).toBeNull();
  });
});

describe("the refund quote", () => {
  test("the share of what was paid, by the window the notice falls in", () => {
    expect(refund(100_000, 200).computedCents).toBe(100_000n); // 100%
    expect(refund(100_000, 100).computedCents).toBe(50_000n); // 50%
    expect(refund(100_000, 10).computedCents).toBe(0n); // closer than the smallest window
    expect(refund(100_000, 100).refundableBp).toBe(5_000);
    expect(refund(100_000, 100).hoursBeforeStart).toBe(100);
  });

  test("window boundaries: one hour either side of 168 and 48", () => {
    expect(refund(100_000, 168).computedCents).toBe(100_000n);
    expect(refund(100_000, 167).computedCents).toBe(50_000n);
    expect(refund(100_000, 48).computedCents).toBe(50_000n);
    expect(refund(100_000, 47).computedCents).toBe(0n);
  });

  test("a start in the past refunds nothing (negative hours), whatever the policy", () => {
    const past = refund(100_000, -3);
    expect(past.hoursBeforeStart).toBe(-3);
    expect(past.computedCents).toBe(0n);
    expect(past.refundableBp).toBe(0);
    // Even a generous policy with a zero-hour window: after arrival there is no notice.
    expect(
      refund(100_000, -1, {
        refundBasis: "whole_stay",
        windows: [{ minHoursBeforeStart: 0, refundableBp: 10_000 }]
      }).computedCents
    ).toBe(0n);
  });

  test("zero paid: a zero refund and the matched share is still reported", () => {
    const zero = refund(0, 200);
    expect(zero.computedCents).toBe(0n);
    expect(zero.refundableBp).toBe(10_000);
    // A negative figure is clamped, never a negative refund.
    expect(refund(-5, 200).computedCents).toBe(0n);
  });

  test("deposit-only: the policy applies to what was paid, not to the total", () => {
    // Total 1,000,000 with a 30% deposit paid: 300,000 -> 50% of the deposit.
    expect(refund(30_000_000, 100).computedCents).toBe(15_000_000n);
    // A fully paid 1,000,000 under the same notice refunds 500,000.
    expect(refund(100_000_000, 100).computedCents).toBe(50_000_000n);
  });

  test("no policy (rules null) or no windows: refund 0 and share 0 (ADR-0045 D6)", () => {
    expect(refund(100_000, 500, null)).toEqual({
      hoursBeforeStart: 500,
      refundableBp: 0,
      computedCents: 0n
    });
    expect(
      refund(100_000, 500, { refundBasis: "whole_stay", windows: [] })
        .computedCents
    ).toBe(0n);
  });

  test("the refund is cent-exact and never above the amount paid", () => {
    // 33.33% of 1,00 rupiah-cents amounts.
    const rules: CancellationRules = {
      refundBasis: "whole_stay",
      windows: [{ minHoursBeforeStart: 0, refundableBp: 3_333 }]
    };
    expect(refund(101, 10, rules).computedCents).toBe(34n); // 33.6633 -> 34
    expect(refund(100, 10, rules).computedCents).toBe(33n);
    for (const paid of [1, 2, 3, 99, 100, 12_345, 999_999_999]) {
      const result = refund(paid, 10, {
        refundBasis: "whole_stay",
        windows: [{ minHoursBeforeStart: 0, refundableBp: 10_000 }]
      });
      expect(result.computedCents).toBe(BigInt(paid));
    }
  });
});

describe("per-night basis", () => {
  const perNight: CancellationRules = {
    refundBasis: "per_night",
    windows: [
      { minHoursBeforeStart: 72, refundableBp: 10_000 },
      { minHoursBeforeStart: 24, refundableBp: 5_000 }
    ]
  };

  test("each night is judged by the notice before ITS OWN start", () => {
    // 3 nights, 30,000 paid = 10,000 each. 30 hours before arrival:
    // night 1 (30h) -> 50%, night 2 (54h) -> 50%, night 3 (78h) -> 100%.
    const result = refund(3_000_000, 30, perNight, 3);
    expect(result.computedCents).toBe(500_000n + 500_000n + 1_000_000n);
    // The whole-stay reading of the same policy judges all of it at 30h: 50%.
    expect(
      refund(3_000_000, 30, { ...perNight, refundBasis: "whole_stay" }, 3)
        .computedCents
    ).toBe(1_500_000n);
  });

  test("the effective share is reported and the parts add up to a cent-exact total", () => {
    const result = refund(1_000_001, 30, perNight, 3);
    expect(result.computedCents <= 1_000_001n).toBe(true);
    expect(result.refundableBp).toBeGreaterThan(5_000);
    expect(result.refundableBp).toBeLessThanOrEqual(10_000);
    // With ample notice for every night the refund is the whole amount.
    expect(refund(1_000_001, 500, perNight, 3).computedCents).toBe(1_000_001n);
  });

  test("a single night (or a slot) is the whole-stay reading", () => {
    expect(refund(100_000, 30, perNight, 1).computedCents).toBe(50_000n);
  });

  test("after arrival, the later nights may still be ahead of the clock, but the first is not refunded", () => {
    // 2 nights, arrival 1 hour ago: night 2 starts in 23 hours (< 24: no window).
    expect(refund(200_000, -1, perNight, 2).computedCents).toBe(0n);
    // 5 nights, arrival 1 hour ago: night 4 starts in 71 hours (50%), night 5 in 95 (100%).
    const result = refund(500_000, -1, perNight, 5);
    expect(result.computedCents).toBe(0n + 0n + 50_000n + 50_000n + 100_000n);
  });
});

describe("window monotonicity", () => {
  test("more notice never refunds less than less notice", () => {
    expect(windowsAreMonotone(STANDARD.windows)).toBe(true);
    expect(
      windowsAreMonotone([
        { minHoursBeforeStart: 100, refundableBp: 2_000 },
        { minHoursBeforeStart: 10, refundableBp: 3_000 }
      ])
    ).toBe(false);
    expect(
      windowsAreMonotone([
        { minHoursBeforeStart: 100, refundableBp: 2_000 },
        { minHoursBeforeStart: 10, refundableBp: 2_000 }
      ])
    ).toBe(true);
    expect(windowsAreMonotone([])).toBe(true);
  });
});

describe("policy draft validation", () => {
  const PRODUCT = "11111111-1111-4111-8111-111111111111";
  const valid = {
    productId: PRODUCT,
    refundBasis: "per_night",
    noShowRetention: "retain_all",
    windows: [
      { minHoursBeforeStart: 48, refundablePercent: "50" },
      { minHoursBeforeStart: 168, refundablePercent: 100 }
    ]
  };

  test("a valid draft is normalised: percents are two-decimal text, windows greatest notice first", () => {
    const result = validatePolicyDraftInput(valid);
    expect(result).toEqual({
      valid: true,
      value: {
        productId: PRODUCT,
        refundBasis: "per_night",
        noShowRetention: "retain_all",
        windows: [
          { minHoursBeforeStart: 168, refundablePercent: "100.00" },
          { minHoursBeforeStart: 48, refundablePercent: "50.00" }
        ]
      }
    });
  });

  test("defaults: the tenant default scope, whole stay, retain the deposit", () => {
    const result = validatePolicyDraftInput({
      windows: [{ minHoursBeforeStart: 0, refundablePercent: "0" }]
    });
    expect(result).toEqual({
      valid: true,
      value: {
        productId: null,
        refundBasis: "whole_stay",
        noShowRetention: "retain_deposit",
        windows: [{ minHoursBeforeStart: 0, refundablePercent: "0.00" }]
      }
    });
  });

  test("a refund that grows as the notice shrinks is refused", () => {
    const result = validatePolicyDraftInput({
      windows: [
        { minHoursBeforeStart: 100, refundablePercent: "20" },
        { minHoursBeforeStart: 10, refundablePercent: "30" }
      ]
    });
    expect(result.valid).toBe(false);
  });

  test("each malformed part is named", () => {
    const named = (body: unknown) =>
      (validatePolicyDraftInput(body) as { errors: { field: string }[] }).errors
        .map((e) => e.field)
        .sort();
    expect(named({})).toEqual(["windows"]);
    expect(named({ windows: [] })).toEqual(["windows"]);
    expect(
      named({
        windows: Array.from(
          { length: CANCELLATION_POLICY_MAX_WINDOWS + 1 },
          (_, i) => ({ minHoursBeforeStart: i, refundablePercent: "0" })
        )
      })
    ).toEqual(["windows"]);
    expect(
      named({
        windows: [{ minHoursBeforeStart: 1.5, refundablePercent: "10" }]
      })
    ).toEqual(["windows[0].minHoursBeforeStart"]);
    expect(
      named({
        windows: [{ minHoursBeforeStart: 5, refundablePercent: "101" }]
      })
    ).toEqual(["windows[0].refundablePercent"]);
    expect(
      named({
        windows: [
          { minHoursBeforeStart: 5, refundablePercent: "10" },
          { minHoursBeforeStart: 5, refundablePercent: "5" }
        ]
      })
    ).toEqual(["windows[1].minHoursBeforeStart"]);
    expect(
      named({
        productId: "nope",
        refundBasis: "x",
        noShowRetention: "y",
        extra: 1,
        windows: [{ minHoursBeforeStart: 5, refundablePercent: "10" }]
      })
    ).toEqual(["extra", "noShowRetention", "productId", "refundBasis"]);
  });
});

describe("the staff cancel schema", () => {
  test("a plain cancel carries only a closed reason code", () => {
    expect(validateStaffCancelRequest({ reasonCode: "guest_request" })).toEqual(
      {
        valid: true,
        value: { reasonCode: "guest_request", override: null }
      }
    );
  });

  test("the reason code is a short closed code, never free text", () => {
    for (const bad of [
      "",
      "Guest asked to leave",
      "a",
      "X_UPPER",
      "x".repeat(41),
      "has space",
      7
    ]) {
      expect(validateStaffCancelRequest({ reasonCode: bad }).valid).toBe(false);
    }
  });

  test("an override needs a numeric(14,2) string and a 10 to 500 character reason", () => {
    const ok = validateStaffCancelRequest({
      reasonCode: "goodwill",
      override: {
        finalRefund: "250000",
        reason: "  Owner approved a goodwill refund  "
      }
    });
    expect(ok).toEqual({
      valid: true,
      value: {
        reasonCode: "goodwill",
        override: {
          finalRefund: "250000.00",
          reason: "Owner approved a goodwill refund"
        }
      }
    });
    const fieldsOf = (override: unknown) =>
      (
        validateStaffCancelRequest({ reasonCode: "goodwill", override }) as {
          errors: { field: string }[];
        }
      ).errors.map((e) => e.field);
    expect(
      fieldsOf({ finalRefund: 250000, reason: "a long enough reason" })
    ).toEqual(["override.finalRefund"]);
    expect(
      fieldsOf({ finalRefund: "1.234", reason: "a long enough reason" })
    ).toEqual(["override.finalRefund"]);
    expect(
      fieldsOf({ finalRefund: "-1", reason: "a long enough reason" })
    ).toEqual(["override.finalRefund"]);
    expect(fieldsOf({ finalRefund: "10.00", reason: "too short" })).toEqual([
      "override.reason"
    ]);
    expect(fieldsOf({ finalRefund: "10.00" })).toEqual(["override.reason"]);
    expect(fieldsOf({ finalRefund: "10.00", reason: "x".repeat(501) })).toEqual(
      ["override.reason"]
    );
    expect(
      fieldsOf({
        finalRefund: "10.00",
        reason: "a long enough reason",
        actor: "x"
      })
    ).toEqual(["override.actor"]);
    expect(fieldsOf("nope")).toEqual(["override"]);
  });

  test("a top-level amount is refused by name - only the override object can carry a figure", () => {
    for (const key of ["amount", "final_refund", "finalRefund", "refund"]) {
      const result = validateStaffCancelRequest({
        reasonCode: "goodwill",
        [key]: "100000"
      });
      expect(result.valid, key).toBe(false);
      expect(
        (result as { errors: { field: string; message: string }[] }).errors[0]
      ).toEqual({
        field: key,
        message: `${key} is not accepted: the server computes the refund.`
      });
    }
  });
});

describe("the guest / customer cancel schema (control C-10)", () => {
  test("it carries the figure the shopper saw and, optionally, the order's phone", () => {
    expect(validateCustomerCancelRequest({ acknowledgedRefund: "0" })).toEqual({
      valid: true,
      value: { acknowledgedRefund: "0.00", phone: null }
    });
    expect(
      validateCustomerCancelRequest({
        acknowledgedRefund: "150000.5",
        phone: " 0813 "
      })
    ).toEqual({
      valid: true,
      value: { acknowledgedRefund: "150000.50", phone: "0813" }
    });
  });

  test("a guest can NEVER send final_refund or amount (or any other figure, or an override)", () => {
    for (const key of [
      "final_refund",
      "finalRefund",
      "amount",
      "refund",
      "refundAmount",
      "computedRefund",
      "computed_refund",
      "amountPaid",
      "amount_paid",
      "total",
      "price",
      "override",
      "reason",
      "reasonCode",
      "orderId",
      "customerId"
    ]) {
      const value =
        key === "override"
          ? { finalRefund: "1.00", reason: "long enough reason" }
          : "1.00";
      const result = validateCustomerCancelRequest({
        acknowledgedRefund: "0.00",
        [key]: value
      });
      expect(result.valid, key).toBe(false);
      expect(
        (result as { errors: { field: string }[] }).errors.map((e) => e.field),
        key
      ).toEqual([key]);
    }
  });

  test("the acknowledged figure is required and must be a numeric(14,2) string, never a JSON number", () => {
    expect(validateCustomerCancelRequest({}).valid).toBe(false);
    expect(
      validateCustomerCancelRequest({ acknowledgedRefund: 100 }).valid
    ).toBe(false);
    expect(
      validateCustomerCancelRequest({ acknowledgedRefund: "-5" }).valid
    ).toBe(false);
    expect(
      validateCustomerCancelRequest({ acknowledgedRefund: "1.234" }).valid
    ).toBe(false);
    expect(validateCustomerCancelRequest(null).valid).toBe(false);
    expect(validateCustomerCancelRequest("x").valid).toBe(false);
  });
});

describe("refusals and keys", () => {
  test("each refusal has a stable status and code; QUOTE_CHANGED and REFUND_EXCEEDS_PAID carry their figure", () => {
    expect(cancelRefusalHttp({ code: "RESERVATION_NOT_FOUND" })).toMatchObject({
      status: 404,
      code: "RESOURCE_NOT_FOUND"
    });
    expect(
      cancelRefusalHttp({ code: "QUOTE_CHANGED", computedRefund: "10.00" })
    ).toMatchObject({
      status: 409,
      code: "QUOTE_CHANGED",
      details: { computedRefund: "10.00" }
    });
    expect(
      cancelRefusalHttp({ code: "REFUND_EXCEEDS_PAID", amountPaid: "5.00" })
    ).toMatchObject({
      status: 409,
      code: "REFUND_EXCEEDS_PAID",
      details: { amountPaid: "5.00" }
    });
    expect(
      cancelRefusalHttp({ code: "INVALID_STATE", reason: "completed" })
    ).toMatchObject({ status: 409, code: "INVALID_STATE" });
    expect(cancelRefusalHttp({ code: "IDEMPOTENCY_CONFLICT" })).toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_CONFLICT"
    });
    expect(
      cancelRefusalHttp({ code: "SERVICE_ACTOR_NOT_CONFIGURED" })
    ).toMatchObject({
      status: 409,
      code: "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED"
    });
    expect(
      cancelRefusalHttp({
        code: "OVERRIDE_NOT_A_CHANGE",
        computedRefund: "1.00"
      }).status
    ).toBe(400);
  });

  test("every BookingRefusal of the port maps to an HTTP status, including the codes upstream added with BookingPort 1.1.0", () => {
    // The union is exhaustive here on purpose: a code added to the port makes
    // this object a compile error until it is listed (and thereby considered).
    const all: Record<BookingRefusal, true> = {
      SLOT_UNAVAILABLE: true,
      OUTSIDE_SCHEDULE: true,
      LEAD_TIME_VIOLATION: true,
      HORIZON_EXCEEDED: true,
      PARTY_SIZE_OUT_OF_RANGE: true,
      QUANTITY_EXCEEDS_UNITS: true,
      BOOKING_MODE_MISMATCH: true,
      MIN_STAY_VIOLATION: true,
      MAX_STAY_EXCEEDED: true,
      STAY_DATES_INVALID: true,
      STAY_POOL_INCONSISTENT: true,
      STAFF_UNAVAILABLE: true,
      HOLD_EXPIRED: true,
      HOLD_LIMIT_EXCEEDED: true,
      CONTENTION_RETRY: true,
      EXTERNAL_REF_IN_USE: true,
      RESOURCE_NOT_FOUND: true,
      OFFERING_NOT_FOUND: true,
      RESERVATION_NOT_FOUND: true,
      RESOURCE_REQUIRED: true,
      CHECK_IN_TOO_EARLY: true,
      NO_SHOW_TOO_EARLY: true,
      INVALID_STATE: true,
      IDEMPOTENCY_CONFLICT: true,
      PAYMENT_FIELD_NOT_ACCEPTED: true,
      VALIDATION_ERROR: true
    };
    for (const reason of Object.keys(all) as BookingRefusal[]) {
      const mapped = cancelRefusalHttp({ code: "BOOKING", reason });
      expect(mapped.status, reason).toBeGreaterThanOrEqual(400);
      expect(mapped.status, reason).toBeLessThan(500);
      expect(mapped.code.length, reason).toBeGreaterThan(0);
    }
    // The two upstream added with BookingPort 1.1.0 keep their own code under 409.
    expect(
      cancelRefusalHttp({ code: "BOOKING", reason: "CHECK_IN_TOO_EARLY" })
    ).toMatchObject({ status: 409, code: "CHECK_IN_TOO_EARLY" });
    expect(
      cancelRefusalHttp({ code: "BOOKING", reason: "NO_SHOW_TOO_EARLY" })
    ).toMatchObject({ status: 409, code: "NO_SHOW_TOO_EARLY" });
    expect(
      cancelRefusalHttp({ code: "BOOKING", reason: "INVALID_STATE" })
    ).toMatchObject({ status: 409, code: "INVALID_STATE" });
  });

  test("the decision source key is per Booking reservation; the trigger kind follows the actor", () => {
    expect(decisionSourceKey("abc")).toBe("booking-cancel:abc");
    expect(triggerKindFor("customer")).toBe("customer_cancel");
    expect(triggerKindFor("staff")).toBe("staff_cancel");
  });
});
