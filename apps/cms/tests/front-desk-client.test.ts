/**
 * The pure rules of the cashier / front-desk screen (Issue #388). Asserts what
 * the screen may send (never a figure the server owns), what it previews (the
 * tender plan, in cents), why a control is unavailable, and that a retry keeps
 * its Idempotency-Key while a changed request does not.
 */
import { describe, expect, test } from "bun:test";

import {
  actionStates,
  buildBalanceBody,
  buildLookupBody,
  createAttemptKeys,
  firstTenderProblem,
  formatMoney,
  fromCents,
  isFrontDeskCard,
  isOutcomeUnknown,
  nightsBetween,
  outstandingFromDetails,
  planBalanceTenders,
  refusalKey,
  refusalReloadsCard,
  requestSignature,
  statusTone,
  tenderFieldTarget,
  toCents,
  validationFields,
  type FrontDeskCard,
  type TenderLine
} from "../src/lib/ui/front-desk-client";

function card(overrides: Partial<FrontDeskCard> = {}): FrontDeskCard {
  return {
    reservationId: "11111111-1111-4111-8111-111111111111",
    reservationNo: "BK-2026-0001",
    status: "confirmed",
    linkStatus: "active",
    startsAt: "2026-12-01T07:00:00.000Z",
    endsAt: "2026-12-03T05:00:00.000Z",
    orderId: "22222222-2222-4222-8222-222222222222",
    orderCode: "ORD-1",
    orderStatus: "paid",
    guest: {
      name: "Budi",
      phoneMasked: "+62 813 **** 2222",
      emailMasked: null
    },
    serviceLine: {
      name: "Villa",
      quantity: 2,
      unitPrice: "500000.00",
      lineTotal: "1000000.00"
    },
    settlement: {
      total: "1000000.00",
      paid: "300000.00",
      deposit: "300000.00",
      balanceDue: "700000.00",
      paymentStatus: "partial"
    },
    policy: { checkInRequiresSettlement: true },
    actions: {
      canCollectBalance: true,
      canCheckIn: false,
      checkInBlockedReason: "balance_not_settled",
      canCheckOut: false
    },
    ...overrides
  };
}

const desk = {
  canCheckIn: true,
  canCheckOut: true,
  canCollect: true,
  hasSession: true
};

describe("money in cents", () => {
  test("round-trips numeric(14,2) strings without float error", () => {
    expect(toCents("700000.00")).toBe(70000000n);
    expect(toCents("0.10")).toBe(10n);
    expect(toCents("25000")).toBe(2500000n);
    expect(toCents("1.5")).toBe(150n);
    expect(fromCents(70000050n)).toBe("700000.50");
    expect(fromCents(5n)).toBe("0.05");
    expect(fromCents(toCents("123456789012.99"))).toBe("123456789012.99");
  });

  test("a non-numeric figure prints a dash, never NaN", () => {
    expect(formatMoney("abc", "id-ID", "IDR")).toBe("—");
    expect(formatMoney("700000.00", "id-ID", "IDR")).toContain("700.000");
  });
});

describe("buildLookupBody", () => {
  test("needs the code AND a contact; names the first missing field", () => {
    expect(buildLookupBody("", "")).toEqual({
      ok: false,
      field: "code",
      problem: "code_required"
    });
    expect(buildLookupBody("BK-2026-0001", "")).toEqual({
      ok: false,
      field: "contact",
      problem: "contact_required"
    });
    expect(buildLookupBody("", "0813")).toMatchObject({ field: "code" });
  });

  test("there is no code-only, name-only or search shape to send", () => {
    const body = buildLookupBody(" bk-2026-0001 ", "081311112222");
    expect(body).toEqual({
      ok: true,
      body: { reservationNo: "BK-2026-0001", phone: "081311112222" }
    });
    if (body.ok) {
      expect(Object.keys(body.body).sort()).toEqual(["phone", "reservationNo"]);
    }
  });

  test("an @ makes it an e-mail, lower-cased; anything else is a phone", () => {
    expect(buildLookupBody("BK-2026-0001", " Budi@Tamu.Example ")).toEqual({
      ok: true,
      body: { reservationNo: "BK-2026-0001", email: "budi@tamu.example" }
    });
    expect(buildLookupBody("BK-2026-0001", "+62 813-1111-2222")).toMatchObject({
      ok: true
    });
  });

  test("refuses a malformed code and contact before any request", () => {
    for (const code of [
      "ab",
      "bk 2026",
      "bk_2026_1",
      "-BK-2026",
      "x".repeat(40)
    ]) {
      expect(buildLookupBody(code, "081311112222")).toMatchObject({
        ok: false,
        field: "code",
        problem: "code_invalid"
      });
    }
    for (const contact of ["12", "abc", "a@b", "bu di@x.id", "081 3"]) {
      expect(buildLookupBody("BK-2026-0001", contact)).toMatchObject({
        ok: false,
        field: "contact",
        problem: "contact_invalid"
      });
    }
  });
});

describe("isFrontDeskCard", () => {
  test("accepts the lookup answer and rejects anything else", () => {
    expect(isFrontDeskCard(card())).toBe(true);
    expect(isFrontDeskCard(null)).toBe(false);
    expect(isFrontDeskCard({})).toBe(false);
    expect(isFrontDeskCard({ ...card(), settlement: undefined })).toBe(false);
    expect(isFrontDeskCard({ ...card(), actions: null })).toBe(false);
  });
});

describe("dates and tones", () => {
  test("nights are UTC calendar-date arithmetic", () => {
    expect(nightsBetween("2026-12-01T07:00:00Z", "2026-12-03T05:00:00Z")).toBe(
      2
    );
    expect(nightsBetween("2026-12-01T23:59:00Z", "2026-12-02T00:01:00Z")).toBe(
      1
    );
    expect(nightsBetween("x", "2026-12-03T05:00:00Z")).toBe(0);
    expect(nightsBetween("2026-12-03T05:00:00Z", "2026-12-01T05:00:00Z")).toBe(
      0
    );
  });

  test("a status carries a tone, an unknown one is neutral", () => {
    expect(statusTone("confirmed")).toBe("success");
    expect(statusTone("held")).toBe("warning");
    expect(statusTone("no_show")).toBe("danger");
    expect(statusTone("something_new")).toBe("neutral");
  });
});

describe("actionStates - why a control is unavailable", () => {
  test("check-in follows the server's hint: blocked by the balance (R3 default)", () => {
    const states = actionStates(card(), desk);
    expect(states.checkIn).toEqual({
      enabled: false,
      reason: "balance_not_settled"
    });
    expect(states.collect).toEqual({ enabled: true, reason: null });
    expect(states.checkOut).toEqual({
      enabled: false,
      reason: "not_checked_in"
    });
  });

  test("when the tenant allows it, the same balance does not block check-in", () => {
    const allowed = card({
      policy: { checkInRequiresSettlement: false },
      actions: {
        canCollectBalance: true,
        canCheckIn: true,
        checkInBlockedReason: null,
        canCheckOut: false
      }
    });
    expect(actionStates(allowed, desk).checkIn).toEqual({
      enabled: true,
      reason: null
    });
  });

  test("there is no override: a block can only be lifted by the server's hint", () => {
    // Even with every client capability on, a blocked hint stays blocked.
    expect(
      actionStates(card(), { ...desk, canCheckIn: true }).checkIn.enabled
    ).toBe(false);
  });

  test("a settled confirmed reservation can be checked in", () => {
    const settled = card({
      settlement: {
        total: "1000000.00",
        paid: "1000000.00",
        deposit: "300000.00",
        balanceDue: "0.00",
        paymentStatus: "paid"
      },
      actions: {
        canCollectBalance: false,
        canCheckIn: true,
        checkInBlockedReason: null,
        canCheckOut: false
      }
    });
    const states = actionStates(settled, desk);
    expect(states.checkIn.enabled).toBe(true);
    expect(states.collect).toEqual({ enabled: false, reason: "nothing_owed" });
  });

  test("a checked-in guest can be checked out, nobody else", () => {
    const inHouse = card({
      status: "checked_in",
      actions: {
        canCollectBalance: true,
        canCheckIn: false,
        checkInBlockedReason: null,
        canCheckOut: true
      }
    });
    expect(actionStates(inHouse, desk).checkOut.enabled).toBe(true);
    expect(actionStates(inHouse, desk).checkIn).toEqual({
      enabled: false,
      reason: "not_confirmed"
    });
  });

  test("no permission wins over everything; no session is named when the rest is fine", () => {
    const states = actionStates(card(), {
      canCheckIn: false,
      canCheckOut: false,
      canCollect: false,
      hasSession: false
    });
    expect(states.checkIn.reason).toBe("no_permission");
    expect(states.checkOut.reason).toBe("no_permission");
    expect(states.collect.reason).toBe("no_permission");
    expect(
      actionStates(card(), { ...desk, hasSession: false }).collect
    ).toEqual({ enabled: false, reason: "no_session" });
  });

  test("a released link cannot take a payment", () => {
    const gone = card({
      status: "cancelled",
      actions: {
        canCollectBalance: false,
        canCheckIn: false,
        checkInBlockedReason: null,
        canCheckOut: false
      }
    });
    expect(actionStates(gone, desk).collect).toEqual({
      enabled: false,
      reason: "not_payable"
    });
  });
});

describe("planBalanceTenders - the preview mirrors planTenders", () => {
  const cash = (amount: string): TenderLine => ({ type: "cash", amount });
  const qris = (amount: string): TenderLine => ({
    type: "manual_qris",
    amount
  });

  test("cash above the balance is change", () => {
    const plan = planBalanceTenders("700000.00", [cash("1000000.00")]);
    expect(plan.appliedCashCents).toBe(70000000n);
    expect(plan.changeCents).toBe(30000000n);
    expect(plan.remainingCents).toBe(0n);
    expect(firstTenderProblem(plan)).toBeNull();
  });

  test("split tenders: non-cash first, cash takes the rest", () => {
    const plan = planBalanceTenders("700000.00", [
      qris("200000"),
      cash("600000")
    ]);
    expect(plan.nonCashCents).toBe(20000000n);
    expect(plan.appliedCashCents).toBe(50000000n);
    expect(plan.changeCents).toBe(10000000n);
    expect(firstTenderProblem(plan)).toBeNull();
  });

  test("a part payment leaves the rest owed and is allowed", () => {
    const plan = planBalanceTenders("700000.00", [cash("100000")]);
    expect(plan.remainingCents).toBe(60000000n);
    expect(firstTenderProblem(plan)).toBeNull();
  });

  test("non-cash above the balance is refused as an overpayment", () => {
    const plan = planBalanceTenders("700000.00", [qris("700000.01")]);
    expect(plan.overpaid).toBe(true);
    expect(firstTenderProblem(plan)).toEqual({
      problem: "overpayment",
      index: null
    });
  });

  test("problems come with the line they are about", () => {
    expect(firstTenderProblem(planBalanceTenders("10.00", []))).toEqual({
      problem: "no_tender",
      index: null
    });
    expect(
      firstTenderProblem(planBalanceTenders("10.00", [cash(""), cash("0")]))
    ).toEqual({ problem: "bad_amount", index: 1 });
    expect(
      firstTenderProblem(planBalanceTenders("10.00", [cash("1.234")]))
    ).toEqual({ problem: "bad_amount", index: 0 });
    expect(
      firstTenderProblem(planBalanceTenders("10.00", [cash("5"), cash("5")]))
    ).toEqual({ problem: "two_cash", index: null });
    expect(
      firstTenderProblem(
        planBalanceTenders("10.00", [
          { type: "gift_card", amount: "5", code: " " }
        ])
      )
    ).toEqual({ problem: "code_required", index: 0 });
  });
});

describe("buildBalanceBody - nothing the server owns", () => {
  test("carries the register and the tenders and nothing else", () => {
    const body = buildBalanceBody("33333333-3333-4333-8333-333333333333", [
      { type: "cash", amount: "700000", reference: "ignored" },
      { type: "manual_qris", amount: " 25000.5 ", reference: " QR-9 " },
      { type: "gift_card", amount: "10", code: " GC-1 ", reference: "x" },
      { type: "cash", amount: "  " }
    ]);
    expect(Object.keys(body).sort()).toEqual(["registerId", "tenders"]);
    expect(body.tenders).toEqual([
      { tenderType: "cash", amount: "700000.00", reference: null },
      { tenderType: "manual_qris", amount: "25000.50", reference: "QR-9" },
      {
        tenderType: "gift_card",
        amount: "10.00",
        reference: null,
        storedValueCode: "GC-1"
      }
    ]);
    const text = JSON.stringify(body);
    for (const forbidden of [
      "balance",
      "price",
      "orderId",
      "customer",
      "total",
      "status"
    ]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

describe("createAttemptKeys - one key per attempt", () => {
  test("a retry of the same request keeps its key; a changed request gets a new one", () => {
    let n = 0;
    const keys = createAttemptKeys(() => `key-${++n}`);
    const a = requestSignature(["collect", "r1", { tenders: [1] }]);
    const b = requestSignature(["collect", "r1", { tenders: [2] }]);
    expect(keys.keyFor(a)).toBe("key-1");
    expect(keys.keyFor(a)).toBe("key-1");
    expect(keys.keyFor(b)).toBe("key-2");
    expect(keys.keyFor(a)).toBe("key-3");
  });

  test("a settled attempt starts the next one fresh", () => {
    let n = 0;
    const keys = createAttemptKeys(() => `key-${++n}`);
    const sig = requestSignature(["check-in", "r1", "reg"]);
    expect(keys.keyFor(sig)).toBe("key-1");
    keys.settle();
    expect(keys.keyFor(sig)).toBe("key-2");
  });

  test("the default generator yields distinct uuids", () => {
    const keys = createAttemptKeys();
    const first = keys.keyFor("a");
    keys.settle();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys.keyFor("a")).not.toBe(first);
  });
});

describe("server refusals", () => {
  test("every till refusal has its own sentence, the rest are generic", () => {
    expect(refusalKey("REGISTER_SESSION_REQUIRED")).toBe("msgSessionRequired");
    expect(refusalKey("BALANCE_NOT_SETTLED")).toBe("msgBalanceNotSettled");
    expect(refusalKey("NOT_SESSION_CASHIER")).toBe("msgNotSessionCashier");
    expect(refusalKey("CHECK_IN_TOO_EARLY")).toBe("msgTooEarly");
    expect(refusalKey("STORED_VALUE_NOT_FOUND")).toBe("msgSvNotFound");
    expect(refusalKey("SOMETHING_ELSE")).toBe("msgGeneric");
    expect(refusalKey(null)).toBe("msgGeneric");
  });

  test("a changed reservation reloads the card; a typo does not", () => {
    expect(refusalReloadsCard("INVALID_STATE")).toBe(true);
    expect(refusalReloadsCard("BALANCE_NOT_SETTLED")).toBe(true);
    expect(refusalReloadsCard("OVERPAYMENT")).toBe(true);
    expect(refusalReloadsCard("VALIDATION_ERROR")).toBe(false);
    expect(refusalReloadsCard("REGISTER_SESSION_REQUIRED")).toBe(false);
  });

  test("outstanding is read only when it is a money string", () => {
    expect(outstandingFromDetails({ outstanding: "700000.00" })).toBe(
      "700000.00"
    );
    expect(outstandingFromDetails({ outstanding: "<b>" })).toBeNull();
    expect(outstandingFromDetails({ outstanding: 5 })).toBeNull();
    expect(outstandingFromDetails(null)).toBeNull();
    expect(outstandingFromDetails("x")).toBeNull();
  });
});

describe("validation refusals land on the right line", () => {
  test("the refused field names are read from details, in order", () => {
    expect(
      validationFields([
        { field: "tenders[1].amount", message: "x" },
        { field: "registerId", message: "y" },
        { message: "no field" },
        null
      ])
    ).toEqual(["tenders[1].amount", "registerId"]);
    expect(validationFields("nope")).toEqual([]);
    expect(validationFields(undefined)).toEqual([]);
  });

  test("a tender field maps to its line and part", () => {
    expect(tenderFieldTarget("tenders[0].storedValueCode")).toEqual({
      index: 0,
      part: "code"
    });
    expect(tenderFieldTarget("tenders[12].amount")).toEqual({
      index: 12,
      part: "amount"
    });
    expect(tenderFieldTarget("tenders[2].tenderType")).toEqual({
      index: 2,
      part: "other"
    });
    expect(tenderFieldTarget("registerId")).toBeNull();
    expect(tenderFieldTarget("tenders")).toBeNull();
  });
});

describe("isOutcomeUnknown - when a write keeps its Idempotency-Key", () => {
  test("a dropped connection and a reply without an error envelope are unknown", () => {
    expect(isOutcomeUnknown({ ok: false, errorCode: "NETWORK_ERROR" })).toBe(
      true
    );
    // A proxy's 502/504 page or a truncated 200 body: not JSON, so no code.
    expect(isOutcomeUnknown({ ok: false, errorCode: null })).toBe(true);
  });

  test("a coded refusal and a success are definite outcomes", () => {
    expect(isOutcomeUnknown({ ok: false, errorCode: "VALIDATION_ERROR" })).toBe(
      false
    );
    expect(
      isOutcomeUnknown({ ok: false, errorCode: "BALANCE_NOT_SETTLED" })
    ).toBe(false);
    expect(isOutcomeUnknown({ ok: true, errorCode: null })).toBe(false);
  });
});
