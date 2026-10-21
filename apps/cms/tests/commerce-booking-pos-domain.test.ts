/**
 * Pure rules of the POS side of the booking adapter (Issue #383, ADR-0045 D19;
 * threat controls C-34, C-35, C-36) - no database. The DB-backed evidence for
 * the same controls is `tests/integration/commerce-booking-pos.integration.test.ts`.
 *
 *   - the lookup request is the full code plus exactly one identifier and
 *     nothing else (C-34: no partial search, no name search);
 *   - the register-bound bodies carry no balance, price, order or customer
 *     (C-36), and the balance body needs explicit tenders;
 *   - the D19 rule is fail-closed by default and gates on the balance only;
 *   - the card hints follow the status, the balance and the policy;
 *   - every refusal maps to its HTTP code; `CHECK_IN_TOO_EARLY` is a 409.
 */
import { describe, expect, test } from "bun:test";

import {
  BALANCE_COLLECTABLE_STATUSES,
  checkInBlockedByBalance,
  DEFAULT_CHECK_IN_REQUIRES_SETTLEMENT,
  posBookingRefusalHttp,
  posCardActions,
  RESERVATION_NO_PATTERN,
  validatePosBalancePaymentRequest,
  validatePosLookupRequest,
  validatePosRegisterRequest
} from "../src/modules/commerce/domain/booking-pos";

const REGISTER = "11111111-1111-4111-8111-111111111111";

function valid<T>(
  result: { valid: true; value: T } | { valid: false; errors: unknown[] }
): T {
  if (!result.valid) throw new Error(JSON.stringify(result.errors));
  return result.value;
}
function invalidFields(result: {
  valid: boolean;
  errors?: { field: string }[];
}): string[] {
  expect(result.valid).toBe(false);
  return (result.errors ?? []).map((error) => error.field);
}

describe("lookup request (C-34)", () => {
  test("the full code plus a phone or an e-mail, normalised", () => {
    expect(
      valid(
        validatePosLookupRequest({
          reservationNo: " rsv-2026-0001 ",
          phone: "0813-1111-2222"
        })
      )
    ).toEqual({
      reservationNo: "RSV-2026-0001",
      identifier: { kind: "phone", value: "+6281311112222" }
    });
    expect(
      valid(
        validatePosLookupRequest({
          reservationNo: "RSV-2026-0001",
          email: " Budi@Tamu.Example "
        })
      )
    ).toEqual({
      reservationNo: "RSV-2026-0001",
      identifier: { kind: "email", value: "budi@tamu.example" }
    });
  });

  test("a code alone, an identifier alone, both identifiers and a search key are refused", () => {
    const code = "RSV-2026-0001";
    expect(
      invalidFields(validatePosLookupRequest({ reservationNo: code }))
    ).toContain("phone");
    expect(
      invalidFields(validatePosLookupRequest({ phone: "081311112222" }))
    ).toContain("reservationNo");
    expect(
      invalidFields(
        validatePosLookupRequest({
          reservationNo: code,
          phone: "081311112222",
          email: "a@b.co"
        })
      )
    ).toContain("phone");
    for (const key of ["name", "q", "search", "date", "prefix", "customerId"]) {
      expect(
        invalidFields(
          validatePosLookupRequest({
            reservationNo: code,
            phone: "081311112222",
            [key]: "x"
          })
        )
      ).toContain(key);
    }
  });

  test("a wildcard, a prefix-length or a non-string code is refused; the pattern is Booking's", () => {
    for (const reservationNo of ["RSV%", "RSV-*", "R", "", "ab", 12345, null]) {
      expect(
        invalidFields(
          validatePosLookupRequest({ reservationNo, phone: "081311112222" })
        )
      ).toContain("reservationNo");
    }
    expect(RESERVATION_NO_PATTERN.test("RSV-2026-0001")).toBe(true);
    expect(RESERVATION_NO_PATTERN.test("rsv")).toBe(false);
    for (const email of [
      "%@x.co",
      "a b@x.co",
      "plain",
      "a@b",
      `${"a".repeat(260)}@x.co`
    ]) {
      expect(
        invalidFields(
          validatePosLookupRequest({ reservationNo: "RSV-2026-0001", email })
        )
      ).toContain("email");
    }
    expect(
      invalidFields(
        validatePosLookupRequest({
          reservationNo: "RSV-2026-0001",
          phone: "12345"
        })
      )
    ).toContain("phone");
  });
});

describe("register-bound bodies (C-35, C-36)", () => {
  test("check-in and check-out carry the register only", () => {
    expect(valid(validatePosRegisterRequest({ registerId: REGISTER }))).toEqual(
      {
        registerId: REGISTER
      }
    );
    expect(invalidFields(validatePosRegisterRequest({}))).toEqual([
      "registerId"
    ]);
    expect(
      invalidFields(validatePosRegisterRequest({ registerId: "nope" }))
    ).toEqual(["registerId"]);
    for (const key of [
      "balanceDue",
      "status",
      "orderId",
      "reservationId",
      "customerId",
      "registerSessionId"
    ]) {
      expect(
        invalidFields(
          validatePosRegisterRequest({ registerId: REGISTER, [key]: "x" })
        )
      ).toContain(key);
    }
  });

  test("a balance payment is the register and explicit tenders; never a balance, a price, an order or a customer", () => {
    const ok = valid(
      validatePosBalancePaymentRequest({
        registerId: REGISTER,
        tenders: [
          { tenderType: "manual_qris", amount: "200000.00", reference: "QR-1" },
          { tenderType: "cash", amount: "500000.00" }
        ]
      })
    );
    expect(ok.registerId).toBe(REGISTER);
    expect(ok.tenders.map((t) => [t.tenderType, t.amount])).toEqual([
      ["manual_qris", "200000.00"],
      ["cash", "500000.00"]
    ]);
    const base = {
      registerId: REGISTER,
      tenders: [{ tenderType: "cash", amount: "1.00" }]
    };
    for (const key of [
      "balance",
      "balanceDue",
      "outstanding",
      "price",
      "unitPrice",
      "lineTotal",
      "total",
      "paid",
      "settlement",
      "orderId",
      "customerId",
      "customer",
      "discount",
      "change"
    ]) {
      const fields = invalidFields(
        validatePosBalancePaymentRequest({ ...base, [key]: "1.00" })
      );
      expect(fields, key).toContain(key);
    }
    const message = (
      validatePosBalancePaymentRequest({ ...base, balance: "1.00" }) as {
        errors: { message: string }[];
      }
    ).errors[0]!.message;
    expect(message).toContain("the server reads the balance and the price");
    expect(
      invalidFields(validatePosBalancePaymentRequest({ registerId: REGISTER }))
    ).toContain("tenders");
    expect(
      invalidFields(
        validatePosBalancePaymentRequest({ registerId: REGISTER, tenders: [] })
      )
    ).toContain("tenders");
    expect(
      invalidFields(
        validatePosBalancePaymentRequest({
          registerId: REGISTER,
          tenders: [{ tenderType: "gateway", amount: "1.00" }]
        })
      )
    ).toContain("tenders[0].tenderType");
    expect(
      invalidFields(
        validatePosBalancePaymentRequest({
          registerId: REGISTER,
          tenders: [{ tenderType: "cash", amount: 1000 }]
        })
      )
    ).toContain("tenders[0].amount");
  });
});

describe("D19 and the card hints", () => {
  test("the default is fail-closed, and only a balance blocks", () => {
    expect(DEFAULT_CHECK_IN_REQUIRES_SETTLEMENT).toBe(true);
    expect(
      checkInBlockedByBalance({
        requiresSettlement: true,
        outstandingCents: 1n
      })
    ).toBe(true);
    expect(
      checkInBlockedByBalance({
        requiresSettlement: true,
        outstandingCents: 0n
      })
    ).toBe(false);
    expect(
      checkInBlockedByBalance({
        requiresSettlement: false,
        outstandingCents: 70_000_000n
      })
    ).toBe(false);
  });

  const hints = (over: Partial<Parameters<typeof posCardActions>[0]>) =>
    posCardActions({
      linkStatus: "active",
      reservationStatus: "confirmed",
      orderStatus: "paid",
      outstandingCents: 70_000_000n,
      requiresSettlement: true,
      ...over
    });

  test("a confirmed guest with a balance: collect yes, check in blocked with the reason", () => {
    expect(hints({})).toEqual({
      canCollectBalance: true,
      canCheckIn: false,
      checkInBlockedReason: "balance_not_settled",
      canCheckOut: false
    });
  });

  test("paid up, or the policy off: check in is offered", () => {
    expect(hints({ outstandingCents: 0n })).toMatchObject({
      canCollectBalance: false,
      canCheckIn: true,
      checkInBlockedReason: null
    });
    expect(hints({ requiresSettlement: false })).toMatchObject({
      canCollectBalance: true,
      canCheckIn: true,
      checkInBlockedReason: null
    });
  });

  test("checked in: only check out and the balance; cancelled, expired, no-show or a moved link: nothing", () => {
    expect(hints({ reservationStatus: "checked_in" })).toEqual({
      canCollectBalance: true,
      canCheckIn: false,
      checkInBlockedReason: null,
      canCheckOut: true
    });
    for (const reservationStatus of [
      "cancelled",
      "expired",
      "no_show",
      "rescheduled"
    ]) {
      expect(hints({ reservationStatus })).toEqual({
        canCollectBalance: false,
        canCheckIn: false,
        checkInBlockedReason: null,
        canCheckOut: false
      });
    }
    expect(hints({ linkStatus: "superseded" })).toEqual({
      canCollectBalance: false,
      canCheckIn: false,
      checkInBlockedReason: null,
      canCheckOut: false
    });
    // A cancelled order cannot take a payment even when Booking still says confirmed.
    expect(hints({ orderStatus: "cancelled" }).canCollectBalance).toBe(false);
    expect([...BALANCE_COLLECTABLE_STATUSES].sort()).toEqual([
      "checked_in",
      "completed",
      "confirmed",
      "held"
    ]);
  });
});

describe("refusals as HTTP codes", () => {
  test("each refusal has its code; CHECK_IN_TOO_EARLY is a 409; Booking's own code passes through", () => {
    const cases: [
      Parameters<typeof posBookingRefusalHttp>[0],
      number,
      string
    ][] = [
      [{ code: "REGISTER_NOT_FOUND" }, 404, "RESOURCE_NOT_FOUND"],
      [{ code: "REGISTER_SESSION_REQUIRED" }, 409, "REGISTER_SESSION_REQUIRED"],
      [{ code: "REGISTER_SESSION_CLOSING" }, 409, "REGISTER_SESSION_CLOSING"],
      [{ code: "NOT_SESSION_CASHIER" }, 409, "NOT_SESSION_CASHIER"],
      [{ code: "RESERVATION_NOT_FOUND" }, 404, "RESOURCE_NOT_FOUND"],
      [{ code: "INVALID_STATE", reason: "cancelled" }, 409, "INVALID_STATE"],
      [{ code: "IDEMPOTENCY_CONFLICT" }, 409, "IDEMPOTENCY_CONFLICT"],
      [
        { code: "BALANCE_NOT_SETTLED", outstanding: "700000.00" },
        409,
        "BALANCE_NOT_SETTLED"
      ],
      [{ code: "NO_BALANCE_DUE" }, 409, "NO_BALANCE_DUE"],
      [
        { code: "ORDER_NOT_PAYABLE", orderStatus: "cancelled" },
        409,
        "ORDER_NOT_PAYABLE"
      ],
      [
        { code: "BOOKING", reason: "CHECK_IN_TOO_EARLY" },
        409,
        "CHECK_IN_TOO_EARLY"
      ],
      [{ code: "BOOKING", reason: "INVALID_STATE" }, 409, "INVALID_STATE"]
    ];
    for (const [refusal, status, code] of cases) {
      const mapped = posBookingRefusalHttp(refusal);
      expect([mapped.status, mapped.code], JSON.stringify(refusal)).toEqual([
        status,
        code
      ]);
    }
    expect(
      posBookingRefusalHttp({
        code: "BALANCE_NOT_SETTLED",
        outstanding: "700000.00"
      }).details
    ).toEqual({ outstanding: "700000.00" });
    // A foreign register and an unknown reservation say nothing about which.
    expect(
      posBookingRefusalHttp({ code: "RESERVATION_NOT_FOUND" }).message
    ).toBe("Reservation not found.");
  });
});
