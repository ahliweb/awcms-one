/**
 * The pure helpers behind the reschedule dialog and the no-show control (Issue
 * #382, `docs/booking-ux-flows.md` 11.6). They are a convenience only - the
 * server prices the difference, decides whether the dates are free and whether
 * the grace has elapsed - but they must agree with the server so the operator is
 * never told "fine" and then refused, and they must never put a figure in a
 * request.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  addNights,
  buildNoShowBody,
  buildRescheduleBody,
  buildRescheduleQuoteQuery,
  checkRescheduleForm,
  earliestDate,
  fetchRescheduleQuote,
  localDateTimeToInstant,
  nightsBetween,
  NO_SHOW_REASON_CODES,
  readQuote,
  RESCHEDULE_REASON_CODES,
  summarizeQuote
} from "../src/lib/ui/commerce-booking-reschedule-client";
import { validateRescheduleRequest } from "../src/modules/commerce/domain/booking-reschedule";
import { validateNoShowRequest } from "../src/modules/commerce/domain/booking-no-show";

describe("dates", () => {
  test("nights between two real local dates, forward only", () => {
    expect(nightsBetween("2026-12-01", "2026-12-03")).toBe(2);
    expect(nightsBetween("2026-12-31", "2027-01-02")).toBe(2);
    expect(nightsBetween("2026-02-28", "2026-03-01")).toBe(1);
    for (const [a, b] of [
      ["2026-12-03", "2026-12-01"],
      ["2026-12-01", "2026-12-01"],
      ["2026-02-30", "2026-03-02"],
      ["2026-12-01", "tomorrow"],
      ["", ""]
    ] as const) {
      expect(nightsBetween(a, b), `${a} ${b}`).toBeNull();
    }
  });

  test("adds nights across month ends", () => {
    expect(addNights("2026-12-30", 3)).toBe("2027-01-02");
    expect(addNights("nope", 1)).toBeNull();
  });

  test("the earliest date comes from the SERVER's instant, less one day for a resource zone behind UTC", () => {
    expect(earliestDate("2026-10-19T01:30:00.000Z")).toBe("2026-10-18");
    expect(earliestDate("2026-01-01T00:00:00Z")).toBe("2025-12-31");
    expect(earliestDate("garbage")).toBeNull();
  });

  test("a datetime-local value is read as UTC and sent as an RFC 3339 instant the server accepts", () => {
    expect(localDateTimeToInstant("2026-12-01T09:30")).toBe(
      "2026-12-01T09:30:00Z"
    );
    expect(localDateTimeToInstant("2026-12-01T09:30:15")).toBe(
      "2026-12-01T09:30:15Z"
    );
    for (const bad of [
      "",
      "2026-12-01",
      "2026-12-01T25:00",
      "2026-02-30T10:00"
    ]) {
      expect(localDateTimeToInstant(bad), bad).toBeNull();
    }
    // The server's own validator accepts what this produces.
    const instant = localDateTimeToInstant("2026-12-01T09:30")!;
    expect(validateRescheduleRequest({ startsAt: instant }).valid).toBe(true);
  });
});

describe("checkRescheduleForm - stay", () => {
  const base = {
    mode: "stay" as const,
    current: { checkInDate: "2026-12-10", checkOutDate: "2026-12-12" },
    earliest: "2026-10-18"
  };

  test("accepts forward real dates and reports the nights asked for", () => {
    const result = checkRescheduleForm({
      ...base,
      checkInDate: "2026-12-20",
      checkOutDate: "2026-12-23"
    });
    expect(result).toEqual({
      ok: true,
      when: {
        stay: { checkInDate: "2026-12-20", checkOutDate: "2026-12-23" }
      },
      nights: 3
    });
  });

  test("names the first problem, the way the server would refuse", () => {
    const problem = (checkInDate: string, checkOutDate: string) => {
      const result = checkRescheduleForm({
        ...base,
        checkInDate,
        checkOutDate
      });
      return result.ok ? "ok" : result.problems[0];
    };
    expect(problem("", "")).toBe("dates_missing");
    expect(problem("2026-12-20", "")).toBe("dates_missing");
    expect(problem("2026-02-30", "2026-03-02")).toBe("dates_invalid");
    expect(problem("2026-12-23", "2026-12-20")).toBe("checkout_not_after");
    expect(problem("2026-12-20", "2026-12-20")).toBe("checkout_not_after");
    expect(problem("2026-10-01", "2026-10-03")).toBe("in_the_past");
    expect(problem("2026-12-10", "2026-12-12")).toBe("unchanged");
    // A day earlier than "today in UTC" is still allowed (a zone behind UTC).
    expect(problem("2026-10-18", "2026-10-20")).toBe("ok");
  });

  test("everything it accepts, the server's validator accepts too", () => {
    const check = checkRescheduleForm({
      ...base,
      checkInDate: "2026-12-20",
      checkOutDate: "2026-12-23"
    });
    if (!check.ok) throw new Error("expected ok");
    const body = buildRescheduleBody(check, RESCHEDULE_REASON_CODES[0]);
    expect(validateRescheduleRequest(body).valid).toBe(true);
  });
});

describe("checkRescheduleForm - slot", () => {
  const base = {
    mode: "slot" as const,
    current: { startsAt: "2026-12-10T09:00:00Z" },
    earliest: "2026-10-18"
  };

  test("a slot is one night, read as UTC", () => {
    expect(
      checkRescheduleForm({ ...base, startsAtLocal: "2026-12-11T10:00" })
    ).toEqual({
      ok: true,
      when: { startsAt: "2026-12-11T10:00:00Z" },
      nights: 1
    });
  });

  test("missing, malformed, past and unchanged are named", () => {
    const problem = (startsAtLocal: string) => {
      const result = checkRescheduleForm({ ...base, startsAtLocal });
      return result.ok ? "ok" : result.problems[0];
    };
    expect(problem("")).toBe("start_missing");
    expect(problem("tomorrow")).toBe("start_invalid");
    expect(problem("2026-09-01T10:00")).toBe("in_the_past");
    expect(problem("2026-12-10T09:00")).toBe("unchanged");
  });
});

describe("the requests carry dates and a code, never money", () => {
  test("the POST body is the time and a closed reason - nothing about price, refund or order", () => {
    const stay = checkRescheduleForm({
      mode: "stay",
      checkInDate: "2026-12-20",
      checkOutDate: "2026-12-23",
      current: null,
      earliest: null
    });
    if (!stay.ok) throw new Error("expected ok");
    const body = buildRescheduleBody(stay, "guest_request");
    expect(Object.keys(body).sort()).toEqual(["reasonCode", "stay"]);

    const slot = checkRescheduleForm({
      mode: "slot",
      startsAtLocal: "2026-12-11T10:00",
      current: null,
      earliest: null
    });
    if (!slot.ok) throw new Error("expected ok");
    expect(Object.keys(buildRescheduleBody(slot, "other")).sort()).toEqual([
      "reasonCode",
      "startsAt"
    ]);
  });

  test("the quote query is the dates only", () => {
    const stay = checkRescheduleForm({
      mode: "stay",
      checkInDate: "2026-12-20",
      checkOutDate: "2026-12-23",
      current: null,
      earliest: null
    });
    if (!stay.ok) throw new Error("expected ok");
    expect(buildRescheduleQuoteQuery(stay)).toBe(
      "?checkInDate=2026-12-20&checkOutDate=2026-12-23"
    );
    const slot = checkRescheduleForm({
      mode: "slot",
      startsAtLocal: "2026-12-11T10:00",
      current: null,
      earliest: null
    });
    if (!slot.ok) throw new Error("expected ok");
    expect(buildRescheduleQuoteQuery(slot)).toBe(
      "?startsAt=2026-12-11T10%3A00%3A00Z"
    );
  });

  test("the no-show body is a reason code and nothing else, and the server accepts every offered code", () => {
    for (const code of NO_SHOW_REASON_CODES) {
      const body = buildNoShowBody(code);
      expect(Object.keys(body)).toEqual(["reasonCode"]);
      expect(validateNoShowRequest(body).valid, code).toBe(true);
    }
    for (const code of RESCHEDULE_REASON_CODES) {
      const result = validateRescheduleRequest({
        stay: { checkInDate: "2026-12-20", checkOutDate: "2026-12-21" },
        reasonCode: code
      });
      expect(result.valid, code).toBe(true);
    }
  });
});

describe("the server's quote as a sentence", () => {
  const quote = {
    currentNights: 3,
    newNights: 2,
    pricedAmount: "500000.00",
    refundAmount: "250000.00"
  };

  test("each outcome has its own kind", () => {
    expect(
      summarizeQuote({
        ...quote,
        newNights: 3,
        direction: "none",
        pricedAmount: "0.00",
        refundAmount: "0.00"
      }).kind
    ).toBe("none");
    expect(
      summarizeQuote({
        ...quote,
        newNights: 4,
        direction: "charge",
        refundAmount: "0.00"
      }).kind
    ).toBe("charge");
    expect(summarizeQuote({ ...quote, direction: "refund" }).kind).toBe(
      "refund_some"
    );
    expect(
      summarizeQuote({ ...quote, direction: "refund", refundAmount: "0.00" })
        .kind
    ).toBe("refund_none");
    expect(
      summarizeQuote({
        ...quote,
        direction: "refund",
        refundAmount: "0.00",
        policySource: "none"
      }).kind
    ).toBe("refund_policy_none");
  });

  test("an answer that is not the quote shape is refused, not guessed at", () => {
    expect(readQuote(null)).toBeNull();
    expect(readQuote("x")).toBeNull();
    expect(readQuote({ direction: "none" })).toBeNull();
    const ok = readQuote({
      currentNights: 2,
      newNights: 3,
      direction: "charge",
      pricedAmount: "500000.00",
      refundAmount: "0.00",
      policySource: null,
      availability: { available: true, freeUnits: 2 }
    });
    expect(ok).toMatchObject({
      direction: "charge",
      availability: { available: true, freeUnits: 2 }
    });
    expect(
      readQuote({
        currentNights: 2,
        newNights: 3,
        direction: "charge",
        pricedAmount: "1",
        refundAmount: "0",
        availability: { available: "yes" }
      })!.availability
    ).toBeNull();
  });
});

describe("fetchRescheduleQuote", () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
  });

  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;

  test("returns the narrowed quote on success, the error code on a refusal, never throws", async () => {
    globalThis.fetch = answer(200, {
      success: true,
      data: {
        currentNights: 2,
        newNights: 3,
        direction: "charge",
        pricedAmount: "500000.00",
        refundAmount: "0.00"
      }
    });
    const ok = await fetchRescheduleQuote("/x");
    expect(ok.ok).toBe(true);

    globalThis.fetch = answer(409, {
      success: false,
      error: { code: "BALANCE_OUTSTANDING" }
    });
    expect(await fetchRescheduleQuote("/x")).toEqual({
      ok: false,
      errorCode: "BALANCE_OUTSTANDING"
    });

    globalThis.fetch = answer(200, { success: true, data: { nope: 1 } });
    expect(await fetchRescheduleQuote("/x")).toEqual({
      ok: false,
      errorCode: "BAD_RESPONSE"
    });

    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRescheduleQuote("/x")).toEqual({
      ok: false,
      errorCode: "NETWORK_ERROR"
    });
  });
});
