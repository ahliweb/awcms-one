/**
 * Pure unit tests for the booking adapter's vocabulary and request validation
 * (Issue #378, ADR-0045). No database.
 */
import { describe, expect, test } from "bun:test";

import {
  BOOKING_ATTENTION_REASONS,
  isOfferingLinkable,
  quantityBasisForGranularity,
  validateCreateOfferingLinkInput,
  validateSetDepositPolicyInput,
  validateUpdateOfferingLinkInput
} from "../src/modules/commerce/domain/booking-adapter";
import { readFile } from "node:fs/promises";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const fields = (result: { valid: boolean; errors?: { field: string }[] }) =>
  (result.errors ?? []).map((e) => e.field).sort();

describe("offering link input", () => {
  test("a valid body is accepted as is", () => {
    expect(
      validateCreateOfferingLinkInput({
        offeringId: UUID_A,
        productId: UUID_B,
        quantityBasis: "nights"
      })
    ).toEqual({
      valid: true,
      value: {
        offeringId: UUID_A,
        productId: UUID_B,
        quantityBasis: "nights",
        resourceIds: []
      }
    });
  });

  test("resourceIds (Issue #437) is optional, ordered, distinct, uuid-only and bounded", () => {
    const base = {
      offeringId: UUID_A,
      productId: UUID_B,
      quantityBasis: "nights" as const
    };
    const bound = validateCreateOfferingLinkInput({
      ...base,
      resourceIds: [UUID_B, UUID_A]
    });
    expect(bound).toEqual({
      valid: true,
      value: { ...base, resourceIds: [UUID_B, UUID_A] }
    });
    for (const unbound of [undefined, null, []]) {
      const result = validateCreateOfferingLinkInput({
        ...base,
        resourceIds: unbound
      });
      expect(result.valid && result.value.resourceIds).toEqual([]);
    }
    for (const bad of [
      "not-an-array",
      [7],
      ["x"],
      [UUID_A, UUID_A],
      Array.from(
        { length: 11 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
      )
    ]) {
      const result = validateCreateOfferingLinkInput({
        ...base,
        resourceIds: bad
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(fields(result)[0]).toStartWith("resourceIds");
      }
    }
  });

  test("an id that is not a uuid, a basis that is not nights|booking, and a missing field are refused by name", () => {
    const result = validateCreateOfferingLinkInput({
      offeringId: "x",
      productId: 7,
      quantityBasis: "weeks"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(fields(result)).toEqual([
        "offeringId",
        "productId",
        "quantityBasis"
      ]);
    }
    expect(validateCreateOfferingLinkInput(null).valid).toBe(false);
    expect(validateCreateOfferingLinkInput([]).valid).toBe(false);
  });

  test("no client-supplied money or customer: a price, amount, customer or unknown field is refused by name, never ignored", () => {
    for (const forbidden of [
      "price",
      "amount",
      "expectedAmount",
      "computedRefund",
      "customerId",
      "customer",
      "tenantId",
      "status"
    ]) {
      const result = validateCreateOfferingLinkInput({
        offeringId: UUID_A,
        productId: UUID_B,
        quantityBasis: "booking",
        [forbidden]: "1.00"
      });
      expect(result.valid, forbidden).toBe(false);
      if (!result.valid) expect(fields(result)).toEqual([forbidden]);
    }
  });

  test("an update names the one legal transition", () => {
    expect(validateUpdateOfferingLinkInput({ status: "unlinked" }).valid).toBe(
      true
    );
    expect(validateUpdateOfferingLinkInput({ status: "active" }).valid).toBe(
      false
    );
    expect(validateUpdateOfferingLinkInput({}).valid).toBe(false);
    expect(
      validateUpdateOfferingLinkInput({ status: "unlinked", productId: UUID_A })
        .valid
    ).toBe(false);
  });
});

describe("offering facts", () => {
  test("the quantity basis follows the granularity (Q1)", () => {
    expect(quantityBasisForGranularity("stay")).toBe("nights");
    expect(quantityBasisForGranularity("time")).toBe("booking");
    expect(quantityBasisForGranularity("weekly")).toBeNull();
  });

  test("only an active hold-then-confirm offering can be sold (G9)", () => {
    expect(
      isOfferingLinkable({
        confirmationMode: "hold_then_confirm",
        status: "active"
      })
    ).toBe(true);
    expect(
      isOfferingLinkable({ confirmationMode: "immediate", status: "active" })
    ).toBe(false);
    expect(
      isOfferingLinkable({
        confirmationMode: "hold_then_confirm",
        status: "inactive"
      })
    ).toBe(false);
  });

  test("the attention enum is the superset the whole epic needs (G7) and matches the table CHECK", async () => {
    expect([...BOOKING_ATTENTION_REASONS].sort()).toEqual([
      "cancelled_externally_paid",
      "confirm_failed",
      "deposit_after_expiry",
      "rescheduled_externally"
    ]);
    const sql = await readFile(
      "sql/1035_awcms_commerce_booking_links_schema.sql",
      "utf8"
    );
    for (const reason of BOOKING_ATTENTION_REASONS) {
      expect(sql).toContain(`'${reason}'`);
    }
  });
});

describe("deposit policy input", () => {
  test("percent is normalised to two places and bounded to (0, 100]", () => {
    const ok = (percent: unknown) =>
      validateSetDepositPolicyInput({ kind: "percent", percent });
    expect(ok("30")).toEqual({
      valid: true,
      value: { kind: "percent", percent: "30.00" }
    });
    expect(ok("12.5")).toEqual({
      valid: true,
      value: { kind: "percent", percent: "12.50" }
    });
    expect(ok(100)).toEqual({
      valid: true,
      value: { kind: "percent", percent: "100.00" }
    });
    expect(ok(0.5)).toEqual({
      valid: true,
      value: { kind: "percent", percent: "0.50" }
    });
    for (const bad of [
      "0",
      "0.00",
      "100.01",
      "-5",
      "12.345",
      "abc",
      "",
      null,
      undefined,
      {}
    ]) {
      expect(ok(bad).valid, String(bad)).toBe(false);
    }
  });

  test("a fixed amount is a positive numeric(14,2) STRING, never a JSON number", () => {
    expect(
      validateSetDepositPolicyInput({ kind: "fixed", fixedAmount: "150000" })
    ).toEqual({
      valid: true,
      value: { kind: "fixed", fixedAmount: "150000.00" }
    });
    for (const bad of [150000, "0", "0.00", "-1.00", "1.234", "x", null]) {
      expect(
        validateSetDepositPolicyInput({ kind: "fixed", fixedAmount: bad })
          .valid,
        String(bad)
      ).toBe(false);
    }
  });

  test("full takes no value; a stray amount, price or the other kind's field is refused", () => {
    expect(validateSetDepositPolicyInput({ kind: "full" })).toEqual({
      valid: true,
      value: { kind: "full" }
    });
    for (const body of [
      { kind: "full", percent: "30" },
      { kind: "percent", percent: "30", fixedAmount: "1.00" },
      { kind: "fixed", fixedAmount: "1.00", percent: "30" },
      { kind: "fixed", fixedAmount: "1.00", amount: "1.00" },
      { kind: "percent", percent: "30", price: "1.00" },
      { kind: "weekly" },
      {}
    ]) {
      expect(
        validateSetDepositPolicyInput(body).valid,
        JSON.stringify(body)
      ).toBe(false);
    }
  });
});
