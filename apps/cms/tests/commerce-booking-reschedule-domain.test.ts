/**
 * The pure rules of the booking reschedule and no-show (Issue #382, ADR-0045 D7
 * and D15; threat controls C-37, C-39, C-41) - no database. What must not rot:
 *
 *   - a reschedule body is exactly one of `startsAt` and `stay`, an optional
 *     resource and a closed reason code, and NEVER a price, a difference, a
 *     refund, an order or a payment method (every one of those names is refused,
 *     with a message that says the server prices the difference);
 *   - the direction is the sign of the night difference and nothing else;
 *   - a chain of reductions is valued CUMULATIVELY (`floor(total * n / sold)`),
 *     so the values add up to the share of the nights removed in all, never to
 *     more, whatever the split and however the cents fall;
 *   - the partial cancellation judges the trailing nights (`firstNightOffset`)
 *     by the notice before THEIR own start, and `whole_stay` ignores the offset;
 *   - the no-show retention for each rule, never above the amount paid, and no
 *     rule ever yields a refund;
 *   - every refusal maps to the HTTP status and code the contract names, and
 *     Booking's two timing refusals keep their own codes.
 */
import { describe, expect, test } from "bun:test";

import {
  computeCancellationRefund,
  type CancellationRules
} from "../src/modules/commerce/domain/booking-cancellation";
import { holdRefusalHttp } from "../src/modules/commerce/domain/booking-hold-to-order";
import {
  computeNoShowRetention,
  DEFAULT_NO_SHOW_REASON_CODE,
  noShowDecisionSourceKey,
  validateNoShowRequest
} from "../src/modules/commerce/domain/booking-no-show";
import {
  DEFAULT_RESCHEDULE_REASON_CODE,
  differenceDirection,
  nightsValueCents,
  reductionRoom,
  requestedNights,
  rescheduleRefusalHttp,
  rescheduleRequestFingerprint,
  validateRescheduleQuoteQuery,
  validateRescheduleRequest,
  type RescheduleRefusal
} from "../src/modules/commerce/domain/booking-reschedule";

const STAY = { checkInDate: "2026-12-01", checkOutDate: "2026-12-03" };

describe("the reschedule request", () => {
  test("exactly one of startsAt and stay, with the defaults", () => {
    const slot = validateRescheduleRequest({
      startsAt: "2026-12-01T09:00:00Z"
    });
    expect(slot).toEqual({
      valid: true,
      value: {
        startsAt: "2026-12-01T09:00:00Z",
        stay: null,
        resourceId: null,
        reasonCode: DEFAULT_RESCHEDULE_REASON_CODE
      }
    });
    const stay = validateRescheduleRequest({
      stay: STAY,
      resourceId: "11111111-1111-4111-8111-111111111111",
      reasonCode: "guest_request"
    });
    expect(stay).toEqual({
      valid: true,
      value: {
        startsAt: null,
        stay: STAY,
        resourceId: "11111111-1111-4111-8111-111111111111",
        reasonCode: "guest_request"
      }
    });
    for (const bad of [
      {},
      null,
      "x",
      { startsAt: "2026-12-01T09:00:00Z", stay: STAY },
      { startsAt: "2026-12-01 09:00" },
      { startsAt: "2026-12-01T09:00:00+07:00" },
      { stay: "2026-12-01" },
      { stay: { checkInDate: "2026-12-03", checkOutDate: "2026-12-01" } },
      { stay: { checkInDate: "2026-12-01", checkOutDate: "2026-12-01" } },
      { stay: { checkInDate: "2026-02-30", checkOutDate: "2026-03-02" } },
      { stay: { ...STAY, extra: 1 } },
      { stay: STAY, resourceId: "not-a-uuid" },
      { stay: STAY, reasonCode: "Free Text Reason!" },
      { stay: STAY, reasonCode: "x" }
    ]) {
      expect(validateRescheduleRequest(bad).valid, JSON.stringify(bad)).toBe(
        false
      );
    }
  });

  test("a body can never carry money: every price-like key is refused with the reason", () => {
    for (const key of [
      "amount",
      "price",
      "total",
      "difference",
      "priceDifference",
      "pricedAmount",
      "refund",
      "refundAmount",
      "finalRefund",
      "final_refund",
      "supplement",
      "supplementOrder",
      "orderId",
      "orderCode",
      "paymentMethod",
      "deposit"
    ]) {
      const result = validateRescheduleRequest({ stay: STAY, [key]: "1" });
      expect(result.valid, key).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]!.field).toBe(key);
        expect(result.errors[0]!.message).toContain("server prices");
      }
    }
    // An unknown, non-money key is refused as unknown, not with the price message.
    const unknown = validateRescheduleRequest({ stay: STAY, colour: "red" });
    expect(unknown.valid).toBe(false);
    if (!unknown.valid) {
      expect(unknown.errors[0]!.message).toContain("not a known field");
    }
  });

  test("the quote query is the same shape from the URL, and never a price", () => {
    const ok = validateRescheduleQuoteQuery(
      new URLSearchParams("checkInDate=2026-12-01&checkOutDate=2026-12-03")
    );
    expect(ok).toEqual({
      valid: true,
      value: { startsAt: null, stay: STAY, resourceId: null }
    });
    const withResource = validateRescheduleQuoteQuery(
      new URLSearchParams(
        "startsAt=2026-12-01T09:00:00Z&resourceId=11111111-1111-4111-8111-111111111111"
      )
    );
    expect(withResource.valid).toBe(true);
    for (const query of [
      "",
      "checkInDate=2026-12-01",
      "startsAt=2026-12-01T09:00:00Z&checkInDate=2026-12-01&checkOutDate=2026-12-03",
      "checkInDate=2026-12-01&checkOutDate=2026-12-03&amount=1",
      "checkInDate=2026-12-01&checkOutDate=2026-12-03&price=1",
      "checkInDate=2026-12-01&checkOutDate=2026-12-03&unknown=1",
      "checkInDate=2026-12-01&checkOutDate=2026-12-03&resourceId=x"
    ]) {
      expect(
        validateRescheduleQuoteQuery(new URLSearchParams(query)).valid,
        query
      ).toBe(false);
    }
  });
});

describe("the night difference", () => {
  test("the direction is the sign of the difference and nothing else", () => {
    expect(differenceDirection(2, 2)).toBe("none");
    expect(differenceDirection(2, 3)).toBe("charge");
    expect(differenceDirection(3, 2)).toBe("refund");
    expect(differenceDirection(1, 30)).toBe("charge");
    expect(differenceDirection(30, 1)).toBe("refund");
  });

  test("a request asks for its stay's nights, a slot for one", () => {
    expect(requestedNights({ startsAt: null, stay: STAY })).toBe(2);
    expect(
      requestedNights({ startsAt: "2026-12-01T09:00:00Z", stay: null })
    ).toBe(1);
    expect(requestedNights({ startsAt: null, stay: null })).toBeNull();
  });

  test("an order keeps at least one night: the room for a reduction", () => {
    expect(reductionRoom(3, 0)).toBe(2);
    expect(reductionRoom(3, 1)).toBe(1);
    expect(reductionRoom(3, 2)).toBe(0);
    expect(reductionRoom(1, 0)).toBe(0);
    expect(reductionRoom(2, 5)).toBe(0);
  });

  test("reductions are valued cumulatively: the cents add up to the share of the nights removed in all", () => {
    // 3 nights at 333,333.33 = 99,999,999 cents - not divisible by three.
    const total = 99_999_999n;
    const first = nightsValueCents(total, 3, 0, 1);
    const second = nightsValueCents(total, 3, 1, 1);
    expect(first).toBe(33_333_333n);
    expect(second).toBe(33_333_333n);
    // Two of three removed in all: floor(total * 2 / 3), and one step does the same.
    expect(first + second).toBe((total * 2n) / 3n);
    expect(nightsValueCents(total, 3, 0, 2)).toBe(first + second);

    // The last night carries the rest of the cents, never more than the total.
    const third = nightsValueCents(total, 3, 2, 1);
    expect(first + second + third).toBe(total);

    // 10 cents over 3 nights: 3 + 3 + 4, never 3 * 3 = 9 lost or 12 invented.
    expect(
      [0, 1, 2].reduce(
        (sum, removed) => sum + nightsValueCents(10n, 3, removed, 1),
        0n
      )
    ).toBe(10n);
  });

  test("degenerate input is worth nothing, and never above the order", () => {
    expect(nightsValueCents(0n, 3, 0, 1)).toBe(0n);
    expect(nightsValueCents(-5n, 3, 0, 1)).toBe(0n);
    expect(nightsValueCents(100n, 0, 0, 1)).toBe(0n);
    expect(nightsValueCents(100n, 3, 0, 0)).toBe(0n);
    expect(nightsValueCents(100n, 3, -1, 1)).toBe(0n);
    // More nights than were sold is capped at the order total.
    expect(nightsValueCents(100n, 3, 0, 10)).toBe(100n);
    expect(nightsValueCents(100n, 3, 5, 1)).toBe(0n);
  });
});

describe("a partial cancellation judges the trailing nights (C-37)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const perNight: CancellationRules = {
    refundBasis: "per_night",
    windows: [
      { minHoursBeforeStart: 72, refundableBp: 10_000 },
      { minHoursBeforeStart: 24, refundableBp: 5_000 }
    ]
  };
  const startsAtMs = Date.parse("2026-12-10T00:00:00Z");

  test("per_night: each removed night is judged by the notice before its OWN start", () => {
    // 80 hours before arrival. Night 0 starts in 80 h (100%), night 1 in 104 h
    // (100%), night 2 in 128 h (100%): a far-off arrival refunds all of them.
    const far = computeCancellationRefund({
      amountPaidCents: 300n,
      startsAtMs,
      nowMs: startsAtMs - 80 * HOUR,
      rules: perNight,
      nights: 1,
      firstNightOffset: 2
    });
    expect(far.computedCents).toBe(300n);

    // 20 hours before arrival: night 0 (20 h, nothing), night 1 (44 h, 50%),
    // night 2 (68 h, 50%). Removing the LAST night (offset 2) is judged by 68 h.
    const near = computeCancellationRefund({
      amountPaidCents: 300n,
      startsAtMs,
      nowMs: startsAtMs - 20 * HOUR,
      rules: perNight,
      nights: 1,
      firstNightOffset: 2
    });
    expect(near.computedCents).toBe(150n);
    // The first night would have got nothing: the offset is what makes the difference.
    const firstNight = computeCancellationRefund({
      amountPaidCents: 300n,
      startsAtMs,
      nowMs: startsAtMs - 20 * HOUR,
      rules: perNight,
      nights: 1,
      firstNightOffset: 0
    });
    expect(firstNight.computedCents).toBe(0n);
  });

  test("whole_stay judges the whole amount by the notice before arrival, whatever the offset", () => {
    const wholeStay: CancellationRules = {
      ...perNight,
      refundBasis: "whole_stay"
    };
    const a = computeCancellationRefund({
      amountPaidCents: 1_000n,
      startsAtMs,
      nowMs: startsAtMs - 30 * HOUR,
      rules: wholeStay,
      nights: 1,
      firstNightOffset: 0
    });
    const b = computeCancellationRefund({
      amountPaidCents: 1_000n,
      startsAtMs,
      nowMs: startsAtMs - 30 * HOUR,
      rules: wholeStay,
      nights: 1,
      firstNightOffset: 5
    });
    expect(a.computedCents).toBe(500n);
    expect(b.computedCents).toBe(500n);
    expect(startsAtMs).toBeGreaterThan(DAY);
  });

  test("no policy refunds nothing, and the refund never exceeds what was paid", () => {
    expect(
      computeCancellationRefund({
        amountPaidCents: 500n,
        startsAtMs,
        nowMs: startsAtMs - 500 * HOUR,
        rules: null,
        nights: 1,
        firstNightOffset: 1
      }).computedCents
    ).toBe(0n);
    const capped = computeCancellationRefund({
      amountPaidCents: 7n,
      startsAtMs,
      nowMs: startsAtMs - 500 * HOUR,
      rules: perNight,
      nights: 3,
      firstNightOffset: 0
    });
    expect(capped.computedCents <= 7n).toBe(true);
  });
});

describe("the no-show retention (C-41)", () => {
  const base = {
    amountPaidCents: 1_000_000n,
    thresholdCents: 300_000n,
    windowRefundCents: 0n
  };

  test("retain_deposit keeps the deposit; the rest is reported, not refunded", () => {
    expect(computeNoShowRetention({ ...base, rule: "retain_deposit" })).toEqual(
      {
        retainedCents: 300_000n,
        notRetainedCents: 700_000n
      }
    );
    // Less paid than the deposit: only what was paid is kept.
    expect(
      computeNoShowRetention({
        ...base,
        rule: "retain_deposit",
        amountPaidCents: 100_000n
      })
    ).toEqual({ retainedCents: 100_000n, notRetainedCents: 0n });
    // A non-deposit order: the threshold IS the total.
    expect(
      computeNoShowRetention({
        ...base,
        rule: "retain_deposit",
        thresholdCents: 1_000_000n
      }).retainedCents
    ).toBe(1_000_000n);
  });

  test("retain_all and no policy keep everything paid", () => {
    for (const rule of ["retain_all", "none"] as const) {
      expect(computeNoShowRetention({ ...base, rule })).toEqual({
        retainedCents: 1_000_000n,
        notRetainedCents: 0n
      });
    }
  });

  test("refund_per_windows keeps what the windows do not give back, capped at what was paid", () => {
    expect(
      computeNoShowRetention({ ...base, rule: "refund_per_windows" })
    ).toEqual({ retainedCents: 1_000_000n, notRetainedCents: 0n });
    expect(
      computeNoShowRetention({
        ...base,
        rule: "refund_per_windows",
        windowRefundCents: 400_000n
      })
    ).toEqual({ retainedCents: 600_000n, notRetainedCents: 400_000n });
    expect(
      computeNoShowRetention({
        ...base,
        rule: "refund_per_windows",
        windowRefundCents: 9_000_000n
      }).retainedCents
    ).toBe(0n);
  });

  test("the retained amount is never above the amount paid and never negative, for every rule", () => {
    for (const rule of [
      "retain_deposit",
      "retain_all",
      "refund_per_windows",
      "none"
    ] as const) {
      for (const paid of [-5n, 0n, 1n, 999n, 1_000_000n]) {
        const result = computeNoShowRetention({
          rule,
          amountPaidCents: paid,
          thresholdCents: 500n,
          windowRefundCents: 250n
        });
        expect(result.retainedCents >= 0n, `${rule} ${paid}`).toBe(true);
        expect(result.notRetainedCents >= 0n, `${rule} ${paid}`).toBe(true);
        const bound = paid > 0n ? paid : 0n;
        expect(result.retainedCents <= bound, `${rule} ${paid}`).toBe(true);
        expect(result.retainedCents + result.notRetainedCents).toBe(bound);
      }
    }
  });

  test("the body is a closed reason code and nothing else - never an amount", () => {
    expect(validateNoShowRequest({})).toEqual({
      valid: true,
      value: { reasonCode: DEFAULT_NO_SHOW_REASON_CODE }
    });
    expect(validateNoShowRequest(undefined).valid).toBe(true);
    expect(validateNoShowRequest({ reasonCode: "no_contact" })).toEqual({
      valid: true,
      value: { reasonCode: "no_contact" }
    });
    for (const bad of [
      { amount: "1" },
      { finalRefund: "1" },
      { refund: "1" },
      { retained: "1" },
      { reasonCode: "Free text" },
      { reasonCode: 5 }
    ]) {
      expect(validateNoShowRequest(bad).valid, JSON.stringify(bad)).toBe(false);
    }
  });

  test("a no-show shares the cancel's decision keyspace: one decision per Booking reservation", () => {
    expect(noShowDecisionSourceKey("abc")).toBe(noShowDecisionSourceKey("abc"));
    expect(noShowDecisionSourceKey("abc")).not.toBe(
      noShowDecisionSourceKey("abd")
    );
  });
});

describe("the refusals as HTTP", () => {
  test("every refusal code maps to a status and a code the contract names", () => {
    const table: [RescheduleRefusal, number, string][] = [
      [{ code: "FEATURE_DISABLED" }, 409, "FEATURE_DISABLED"],
      [{ code: "RESERVATION_NOT_FOUND" }, 404, "RESOURCE_NOT_FOUND"],
      [
        { code: "SERVICE_ACTOR_NOT_CONFIGURED" },
        409,
        "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED"
      ],
      [{ code: "INVALID_STATE", reason: "held" }, 409, "INVALID_STATE"],
      [{ code: "IDEMPOTENCY_CONFLICT" }, 409, "IDEMPOTENCY_CONFLICT"],
      [{ code: "QUANTITY_BASIS_MISMATCH" }, 409, "QUANTITY_BASIS_MISMATCH"],
      [{ code: "NOT_A_CHANGE" }, 409, "RESCHEDULE_NOT_A_CHANGE"],
      [{ code: "REFERENCE_MISMATCH" }, 409, "BOOKING_REFERENCE_MISMATCH"],
      [
        { code: "BALANCE_OUTSTANDING", outstanding: "1.00" },
        409,
        "BALANCE_OUTSTANDING"
      ],
      [
        { code: "REDUCTION_NOT_SUPPORTED", roomNights: 1 },
        409,
        "REDUCTION_NOT_SUPPORTED"
      ],
      [{ code: "SUPPLEMENT_UNAVAILABLE" }, 409, "SUPPLEMENT_ORDER_UNAVAILABLE"],
      [
        { code: "BOOKING", reason: "SLOT_UNAVAILABLE" },
        409,
        "SLOT_UNAVAILABLE"
      ],
      [
        { code: "BOOKING", reason: "NO_SHOW_TOO_EARLY" },
        409,
        "NO_SHOW_TOO_EARLY"
      ]
    ];
    for (const [refusal, status, code] of table) {
      const mapped = rescheduleRefusalHttp(refusal);
      expect(mapped.status, refusal.code).toBe(status);
      expect(mapped.code, refusal.code).toBe(code);
      expect(mapped.message.length).toBeGreaterThan(10);
    }
    expect(
      rescheduleRefusalHttp({
        code: "BALANCE_OUTSTANDING",
        outstanding: "5.00"
      }).details
    ).toEqual({ outstanding: "5.00" });
    expect(
      rescheduleRefusalHttp({ code: "REDUCTION_NOT_SUPPORTED", roomNights: 2 })
        .details
    ).toEqual({ reducibleNights: 2 });
  });

  test("Booking's two timing refusals keep their own code with a message that says what to wait for", () => {
    const early = holdRefusalHttp({
      code: "BOOKING",
      reason: "NO_SHOW_TOO_EARLY"
    });
    expect(early).toMatchObject({ status: 409, code: "NO_SHOW_TOO_EARLY" });
    expect(early.message).toContain("grace");
    const checkIn = holdRefusalHttp({
      code: "BOOKING",
      reason: "CHECK_IN_TOO_EARLY"
    });
    expect(checkIn).toMatchObject({ status: 409, code: "CHECK_IN_TOO_EARLY" });
  });
});

describe("the request fingerprint", () => {
  const request = {
    startsAt: null,
    stay: STAY,
    resourceId: null,
    reasonCode: "guest_request"
  };

  test("binds the actor, the link and every field of the request", () => {
    const base = rescheduleRequestFingerprint("staff:a", "link-1", request);
    expect(base).toEqual({
      scope: "commerce.booking_reservations.reschedule",
      actor: "staff:a",
      linkId: "link-1",
      startsAt: null,
      stay: STAY,
      resourceId: null,
      reasonCode: "guest_request"
    });
    expect(
      rescheduleRequestFingerprint("staff:b", "link-1", request)
    ).not.toEqual(base);
    expect(
      rescheduleRequestFingerprint("staff:a", "link-2", request)
    ).not.toEqual(base);
    expect(
      rescheduleRequestFingerprint("staff:a", "link-1", {
        ...request,
        stay: { ...STAY, checkOutDate: "2026-12-04" }
      })
    ).not.toEqual(base);
  });
});
