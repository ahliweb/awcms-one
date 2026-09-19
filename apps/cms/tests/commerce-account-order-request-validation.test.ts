import { describe, expect, test } from "bun:test";

import { validateCreateOrderInput } from "../src/modules/commerce/domain/order-request-validation";

const MINIMAL_VALID_BODY = {
  idempotencyKey: "11111111-1111-1111-1111-111111111111",
  customer: { name: "Budi", phone: "081234567890", email: null },
  shipping: { method: "self_pickup" },
  lines: [
    { productId: "p1", variantId: null, quantity: 1, serviceFormValues: null }
  ],
  payment: { method: "manual_qris" },
  voucherCode: null,
  insurance: false,
  notes: null
};

/** `affiliateCode` (Issue #91) — shape-validated only, never resolved against anything (issue #92's job). */
describe("validateCreateOrderInput — affiliateCode (Issue #91)", () => {
  test("defaults to null when absent", () => {
    const result = validateCreateOrderInput(MINIMAL_VALID_BODY);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.value.affiliateCode).toBeNull();
  });

  test("accepts null explicitly", () => {
    const result = validateCreateOrderInput({
      ...MINIMAL_VALID_BODY,
      affiliateCode: null
    });
    expect(result.valid).toBe(true);
  });

  test("accepts a string, trimmed and capped at 50 characters", () => {
    const result = validateCreateOrderInput({
      ...MINIMAL_VALID_BODY,
      affiliateCode: `  ${"a".repeat(60)}  `
    });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.value.affiliateCode).toHaveLength(50);
  });

  test("rejects a non-string affiliateCode", () => {
    const result = validateCreateOrderInput({
      ...MINIMAL_VALID_BODY,
      affiliateCode: 12345
    });
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.map((error) => error.field)).toContain(
      "affiliateCode"
    );
  });
});
