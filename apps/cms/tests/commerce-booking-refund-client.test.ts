/**
 * The pure helpers behind the refund-override dialog and the policy windows
 * editor (Issue #381, `docs/booking-ux-flows.md` 11.4 and 11.5). They are a
 * convenience only - the server re-checks every rule - but they must agree with
 * the server so the operator is never told "fine" and then refused.
 */
import { describe, expect, test } from "bun:test";

import {
  buildPolicyDraftBody,
  buildStaffCancelBody,
  centsToMoney,
  checkOverrideForm,
  hoursToNotice,
  moneyToCents,
  noticeToHours
} from "../src/lib/ui/commerce-booking-refund-client";

describe("money", () => {
  test("parses whole and two-decimal amounts, rejects the rest", () => {
    expect(moneyToCents("250000")).toBe(25_000_000n);
    expect(moneyToCents("1250.5")).toBe(125_050n);
    expect(moneyToCents(" 0.05 ")).toBe(5n);
    for (const bad of ["", "-1", "1.234", "1,5", "abc", "1e3", ".5"]) {
      expect(moneyToCents(bad)).toBeNull();
    }
  });

  test("formats cents back with two decimals", () => {
    expect(centsToMoney(125_050n)).toBe("1250.50");
    expect(centsToMoney(5n)).toBe("0.05");
    expect(centsToMoney(0n)).toBe("0.00");
  });
});

describe("checkOverrideForm", () => {
  const base = {
    amountText: "100.00",
    paidText: "300.00",
    computedText: "150.00",
    reason: "Guest had a hospital stay"
  };

  test("accepts a figure between zero and the amount paid", () => {
    expect(checkOverrideForm(base)).toEqual({
      ok: true,
      finalRefund: "100.00",
      reason: "Guest had a hospital stay"
    });
    expect(checkOverrideForm({ ...base, amountText: "0" }).ok).toBe(true);
    expect(checkOverrideForm({ ...base, amountText: "300.00" }).ok).toBe(true);
  });

  test("refuses more than paid, an unchanged figure and a malformed one", () => {
    expect(checkOverrideForm({ ...base, amountText: "300.01" })).toEqual({
      ok: false,
      problems: ["amount_above_paid"]
    });
    expect(checkOverrideForm({ ...base, amountText: "150" })).toEqual({
      ok: false,
      problems: ["amount_unchanged"]
    });
    expect(checkOverrideForm({ ...base, amountText: "x" })).toEqual({
      ok: false,
      problems: ["amount_malformed"]
    });
  });

  test("the reason is 10 to 500 characters once trimmed", () => {
    expect(checkOverrideForm({ ...base, reason: "   short   " })).toEqual({
      ok: false,
      problems: ["reason_too_short"]
    });
    expect(checkOverrideForm({ ...base, reason: "x".repeat(501) })).toEqual({
      ok: false,
      problems: ["reason_too_long"]
    });
    expect(checkOverrideForm({ ...base, reason: "x".repeat(500) }).ok).toBe(
      true
    );
  });
});

test("the staff cancel body carries an amount only inside the override object", () => {
  expect(buildStaffCancelBody("guest_request", null)).toEqual({
    reasonCode: "guest_request"
  });
  expect(
    buildStaffCancelBody("guest_request", {
      finalRefund: "10.00",
      reason: "a long enough reason"
    })
  ).toEqual({
    reasonCode: "guest_request",
    override: { finalRefund: "10.00", reason: "a long enough reason" }
  });
});

describe("notice", () => {
  test("converts to whole hours and back", () => {
    expect(noticeToHours("7", "days")).toBe(168);
    expect(noticeToHours("48", "hours")).toBe(48);
    expect(noticeToHours("1.5", "hours")).toBeNull();
    expect(noticeToHours("", "hours")).toBeNull();
    expect(noticeToHours("9999", "days")).toBeNull();
    expect(hoursToNotice(168)).toEqual({ amount: 7, unit: "days" });
    expect(hoursToNotice(36)).toEqual({ amount: 36, unit: "hours" });
    expect(hoursToNotice(0)).toEqual({ amount: 0, unit: "hours" });
  });
});

describe("buildPolicyDraftBody", () => {
  const form = {
    productId: null,
    refundBasis: "whole_stay",
    noShowRetention: "retain_deposit"
  };

  test("orders the windows by notice, longest first", () => {
    const result = buildPolicyDraftBody({
      ...form,
      rows: [
        { amount: "1", unit: "days", percent: "0" },
        { amount: "7", unit: "days", percent: "100" },
        { amount: "48", unit: "hours", percent: "50.5" }
      ]
    });
    expect(result).toEqual({
      ok: true,
      body: {
        productId: null,
        refundBasis: "whole_stay",
        noShowRetention: "retain_deposit",
        windows: [
          { minHoursBeforeStart: 168, refundablePercent: "100" },
          { minHoursBeforeStart: 48, refundablePercent: "50.5" },
          { minHoursBeforeStart: 24, refundablePercent: "0" }
        ]
      }
    });
  });

  test("names the first problem", () => {
    const row = { amount: "7", unit: "days" as const, percent: "100" };
    expect(buildPolicyDraftBody({ ...form, rows: [] })).toEqual({
      ok: false,
      row: null,
      problem: "empty"
    });
    expect(
      buildPolicyDraftBody({ ...form, rows: [{ ...row, amount: "x" }] })
    ).toEqual({ ok: false, row: 0, problem: "notice_invalid" });
    expect(
      buildPolicyDraftBody({ ...form, rows: [{ ...row, percent: "101" }] })
    ).toEqual({ ok: false, row: 0, problem: "percent_invalid" });
    expect(buildPolicyDraftBody({ ...form, rows: [row, row] })).toEqual({
      ok: false,
      row: 1,
      problem: "duplicate_notice"
    });
    expect(
      buildPolicyDraftBody({
        ...form,
        rows: [row, { amount: "1", unit: "days", percent: "100.01" }]
      }).ok
    ).toBe(false);
    expect(
      buildPolicyDraftBody({
        ...form,
        rows: [
          { amount: "7", unit: "days", percent: "20" },
          { amount: "1", unit: "days", percent: "80" }
        ]
      })
    ).toEqual({ ok: false, row: null, problem: "refund_grows" });
  });

  test("an unknown basis or retention falls back to the safe default", () => {
    const result = buildPolicyDraftBody({
      productId: "p",
      refundBasis: "weird",
      noShowRetention: "weird",
      rows: [{ amount: "1", unit: "days", percent: "100" }]
    });
    expect(result.ok && result.body.refundBasis).toBe("whole_stay");
    expect(result.ok && result.body.noShowRetention).toBe("retain_deposit");
  });
});
