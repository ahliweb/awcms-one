/**
 * POS domain tests (Issue #116, epic #33 C7, contract #106 D6). Pure — no
 * database, no network. Covers `domain/pos-order-validation.ts` (line /
 * customer / payment shape validation, the header-carried idempotency key),
 * the string-based change arithmetic (ADR-0003 — every money assertion is
 * on a STRING, and the cases below are exactly the ones binary floating
 * point gets wrong), and the storefront's own refusal of `cash`
 * (`domain/order-request-validation.ts` must NOT widen with the
 * `PaymentMethod` union).
 */
import { describe, expect, test } from "bun:test";

import {
  computeChange,
  InsufficientTenderError,
  POS_PAYMENT_METHODS,
  POS_WALK_IN_CUSTOMER_NAME,
  validateCreatePosOrderInput
} from "../src/modules/commerce/domain/pos-order-validation";
import { validateCreateOrderInput } from "../src/modules/commerce/domain/order-request-validation";
import {
  normalizePhoneNumber,
  POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
} from "../src/modules/commerce/domain/phone-normalisation";

const KEY = "11111111-1111-4111-8111-111111111111";

const VALID_BODY = {
  customer: { name: "Budi", phone: "081234567890" },
  lines: [
    { productId: "product-1", variantId: null, quantity: 2 },
    { productId: "product-2", variantId: "variant-9", quantity: 1 }
  ],
  payment: { method: "cash", amountTendered: "50000.00" },
  notes: "Bawa sendiri"
};

// ---------------------------------------------------------------------------
// validateCreatePosOrderInput
// ---------------------------------------------------------------------------

describe("pos-order-validation — shape", () => {
  test("accepts a complete cash sale and trims/normalises what it keeps", () => {
    const result = validateCreatePosOrderInput(VALID_BODY, `  ${KEY}  `);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.value.idempotencyKey).toBe(KEY);
    expect(result.value.customer).toEqual({
      name: "Budi",
      phone: "081234567890"
    });
    expect(result.value.lines).toEqual([
      { productId: "product-1", variantId: null, quantity: 2 },
      { productId: "product-2", variantId: "variant-9", quantity: 1 }
    ]);
    expect(result.value.payment).toEqual({
      method: "cash",
      amountTendered: "50000.00"
    });
    expect(result.value.notes).toBe("Bawa sendiri");
  });

  test("the idempotency key comes from the header argument, never the body", () => {
    const withBodyKey = validateCreatePosOrderInput(
      { ...VALID_BODY, idempotencyKey: "body-key" },
      KEY
    );
    expect(withBodyKey.valid).toBe(true);
    if (withBodyKey.valid) expect(withBodyKey.value.idempotencyKey).toBe(KEY);

    const missing = validateCreatePosOrderInput(VALID_BODY, "");
    expect(missing.valid).toBe(false);
    if (!missing.valid) {
      expect(missing.errors.map((e) => e.field)).toContain("Idempotency-Key");
    }
  });

  test("customer is optional in full — omitted, null, or blank fields all mean walk-in", () => {
    for (const customer of [undefined, null, {}, { name: "  ", phone: "" }]) {
      const result = validateCreatePosOrderInput(
        { ...VALID_BODY, customer },
        KEY
      );
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.value.customer).toEqual({ name: null, phone: null });
      }
    }
    expect(POS_WALK_IN_CUSTOMER_NAME.length).toBeGreaterThan(0);
  });

  test("customer must be an object and its fields strings", () => {
    const notObject = validateCreatePosOrderInput(
      { ...VALID_BODY, customer: "Budi" },
      KEY
    );
    expect(notObject.valid).toBe(false);

    const badPhone = validateCreatePosOrderInput(
      { ...VALID_BODY, customer: { name: "Budi", phone: 81234567890 } },
      KEY
    );
    expect(badPhone.valid).toBe(false);
    if (!badPhone.valid) {
      expect(badPhone.errors.map((e) => e.field)).toContain("customer.phone");
    }

    const badName = validateCreatePosOrderInput(
      { ...VALID_BODY, customer: { name: 42, phone: null } },
      KEY
    );
    expect(badName.valid).toBe(false);
  });

  test("lines: non-empty array, productId required, integer quantity 1..10000, variantId string|null", () => {
    expect(
      validateCreatePosOrderInput({ ...VALID_BODY, lines: [] }, KEY).valid
    ).toBe(false);
    expect(
      validateCreatePosOrderInput({ ...VALID_BODY, lines: "x" }, KEY).valid
    ).toBe(false);

    const noProduct = validateCreatePosOrderInput(
      { ...VALID_BODY, lines: [{ quantity: 1 }] },
      KEY
    );
    expect(noProduct.valid).toBe(false);
    if (!noProduct.valid) {
      expect(noProduct.errors.map((e) => e.field)).toContain(
        "lines[0].productId"
      );
    }

    for (const quantity of [0, -1, 1.5, "2", 10001, null]) {
      const result = validateCreatePosOrderInput(
        { ...VALID_BODY, lines: [{ productId: "p", quantity }] },
        KEY
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((e) => e.field)).toContain(
          "lines[0].quantity"
        );
      }
    }

    const badVariant = validateCreatePosOrderInput(
      { ...VALID_BODY, lines: [{ productId: "p", variantId: 7, quantity: 1 }] },
      KEY
    );
    expect(badVariant.valid).toBe(false);

    const nonObjectLine = validateCreatePosOrderInput(
      { ...VALID_BODY, lines: ["p"] },
      KEY
    );
    expect(nonObjectLine.valid).toBe(false);
  });

  test("payment.method must be cash or manual_qris — never the storefront-only methods", () => {
    expect([...POS_PAYMENT_METHODS].sort()).toEqual(["cash", "manual_qris"]);
    for (const method of ["manual_bank", "dp", "gateway", "bitcoin", "", 1]) {
      const result = validateCreatePosOrderInput(
        { ...VALID_BODY, payment: { method, amountTendered: "1.00" } },
        KEY
      );
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((e) => e.field)).toContain("payment.method");
      }
    }
    expect(
      validateCreatePosOrderInput({ ...VALID_BODY, payment: null }, KEY).valid
    ).toBe(false);
  });

  test("cash requires amountTendered as a numeric(14,2) STRING", () => {
    const missing = validateCreatePosOrderInput(
      { ...VALID_BODY, payment: { method: "cash" } },
      KEY
    );
    expect(missing.valid).toBe(false);
    if (!missing.valid) {
      expect(missing.errors.map((e) => e.field)).toContain(
        "payment.amountTendered"
      );
    }

    // A JSON number is the ADR-0003 violation this validator exists to stop.
    for (const amountTendered of [
      50000,
      "50,000",
      "50000.123",
      "-1.00",
      "abc",
      ""
    ]) {
      const result = validateCreatePosOrderInput(
        { ...VALID_BODY, payment: { method: "cash", amountTendered } },
        KEY
      );
      expect(result.valid).toBe(false);
    }

    for (const amountTendered of ["0", "7", "50000", "50000.5", "50000.50"]) {
      const result = validateCreatePosOrderInput(
        { ...VALID_BODY, payment: { method: "cash", amountTendered } },
        KEY
      );
      expect(result.valid).toBe(true);
    }
  });

  test("manual_qris needs no tendered amount and drops one if sent", () => {
    const plain = validateCreatePosOrderInput(
      { ...VALID_BODY, payment: { method: "manual_qris" } },
      KEY
    );
    expect(plain.valid).toBe(true);
    if (plain.valid) expect(plain.value.payment.amountTendered).toBeNull();

    const withTender = validateCreatePosOrderInput(
      {
        ...VALID_BODY,
        payment: { method: "manual_qris", amountTendered: "9.00" }
      },
      KEY
    );
    expect(withTender.valid).toBe(true);
    if (withTender.valid) {
      expect(withTender.value.payment.amountTendered).toBeNull();
    }
  });

  test("notes: optional string, trimmed, blank → null", () => {
    const blank = validateCreatePosOrderInput(
      { ...VALID_BODY, notes: "   " },
      KEY
    );
    expect(blank.valid).toBe(true);
    if (blank.valid) expect(blank.value.notes).toBeNull();
    expect(
      validateCreatePosOrderInput({ ...VALID_BODY, notes: 5 }, KEY).valid
    ).toBe(false);
  });

  test("a non-object body reports every required field at once", () => {
    const result = validateCreatePosOrderInput(null, KEY);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain("lines");
      expect(fields).toContain("payment");
    }
  });
});

// ---------------------------------------------------------------------------
// computeChange — string/decimal arithmetic (ADR-0003)
// ---------------------------------------------------------------------------

describe("pos-order-validation — computeChange", () => {
  test('exact payment yields "0.00"', () => {
    expect(computeChange("25000.00", "25000.00")).toBe("0.00");
    expect(computeChange("25000", "25000.00")).toBe("0.00");
    expect(computeChange("0.10", "0.1")).toBe("0.00");
  });

  test("overpayment yields the difference, always with two decimals", () => {
    expect(computeChange("50000.00", "37500.00")).toBe("12500.00");
    expect(computeChange("100000", "99999.99")).toBe("0.01");
    expect(computeChange("1", "0.05")).toBe("0.95");
    expect(computeChange("20000.50", "19999.5")).toBe("1.00");
  });

  test("the cases binary floating point gets wrong are exact here", () => {
    // 0.3 - 0.1 = 0.19999999999999998 in IEEE 754.
    expect(computeChange("0.30", "0.10")).toBe("0.20");
    // 1.1 - 0.2 = 0.9000000000000001 in IEEE 754.
    expect(computeChange("1.10", "0.20")).toBe("0.90");
    // 2.3 - 1.1 = 1.1999999999999997 in IEEE 754.
    expect(computeChange("2.30", "1.10")).toBe("1.20");
    // Twelve integer digits — beyond Number.MAX_SAFE_INTEGER once scaled to
    // cents (10^14 > 2^53), so this is exact only because it is BigInt.
    expect(computeChange("999999999999.99", "0.01")).toBe("999999999999.98");
    expect(computeChange("999999999999.99", "999999999999.98")).toBe("0.01");
  });

  test("a short tender throws InsufficientTenderError carrying the shortfall", () => {
    let caught: unknown;
    try {
      computeChange("20000.00", "20000.01");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InsufficientTenderError);
    expect((caught as InsufficientTenderError).shortfall).toBe("0.01");

    expect(() => computeChange("0", "1.00")).toThrow(InsufficientTenderError);
  });

  test("a malformed money string is a RangeError, never a NaN result", () => {
    expect(() => computeChange("abc", "1.00")).toThrow(RangeError);
    expect(() => computeChange("1.00", "1,00")).toThrow(RangeError);
    expect(() => computeChange("1.000", "1.00")).toThrow(RangeError);
    expect(() => computeChange("-5.00", "1.00")).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Storefront must refuse `cash`
// ---------------------------------------------------------------------------

describe("storefront order-request-validation refuses the POS-only method", () => {
  const STOREFRONT_BODY = {
    idempotencyKey: KEY,
    customer: { name: "Siti", phone: "081234567890", email: null },
    address: null,
    lines: [
      {
        productId: "product-1",
        variantId: null,
        quantity: 1,
        serviceFormValues: null
      }
    ],
    shipping: { method: "self_pickup" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null
  };

  test("manual_qris is still accepted (control)", () => {
    expect(validateCreateOrderInput(STOREFRONT_BODY).valid).toBe(true);
  });

  test("cash is refused with a payment.method error", () => {
    const result = validateCreateOrderInput({
      ...STOREFRONT_BODY,
      payment: { method: "cash" }
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.field === "payment.method")).toBe(
        true
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Walk-in sentinel
// ---------------------------------------------------------------------------

describe("walk-in sentinel phone", () => {
  test("is already normalised and round-trips through normalizePhoneNumber unchanged", () => {
    const result = normalizePhoneNumber(POS_WALK_IN_CUSTOMER_SENTINEL_PHONE);
    expect(result).toEqual({
      valid: true,
      value: POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
    });
  });

  test("is not a plausible subscriber number (national part is all zeros)", () => {
    expect(POS_WALK_IN_CUSTOMER_SENTINEL_PHONE).toMatch(/^\+620+$/);
  });
});
