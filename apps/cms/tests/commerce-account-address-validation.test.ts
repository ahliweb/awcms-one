import { describe, expect, test } from "bun:test";

import {
  validateAccountAddressInput,
  validateAddressInput
} from "../src/modules/commerce/domain/address-validation";

/**
 * `domain/address-validation.ts`'s Issue #91 additions — pure, no
 * database/I/O. Covers the two things this module changed:
 *
 *   - `validateAddressInput`'s `path: ""` mode (a bare field name, no
 *     leading dot) now that `validateAccountAddressInput` reuses it;
 *   - `validateAccountAddressInput` itself: `label` and `postalCode` are
 *     REQUIRED (unlike the order-creation address shape, where
 *     `postalCode` stays optional), and every field
 *     `validateAddressInput` already checks is still enforced.
 */
describe('validateAddressInput — path: "" (Issue #91)', () => {
  test("bare path produces bare field names, not a leading dot", () => {
    const result = validateAddressInput({}, "");
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    const fields = result.errors.map((error) => error.field);
    expect(fields).toContain("recipientName");
    expect(fields).not.toContain(".recipientName");
  });

  test('default path still prefixes with "address." (no regression for order creation)', () => {
    const result = validateAddressInput({});
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.map((error) => error.field)).toContain(
      "address.recipientName"
    );
  });
});

const VALID_BODY = {
  label: "Rumah",
  recipientName: "Budi Santoso",
  phone: "081234567890",
  provinceCode: "62",
  provinceName: "Kalimantan Tengah",
  cityCode: "6202",
  cityName: "Kotawaringin Timur",
  districtCode: "620201",
  districtName: "Baamang",
  postalCode: "74311",
  street: "Jl. Jenderal Sudirman No. 1",
  notes: null
};

describe("validateAccountAddressInput (Issue #91)", () => {
  test("accepts a fully-populated body", () => {
    const result = validateAccountAddressInput(VALID_BODY);
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid");
    expect(result.value.label).toBe("Rumah");
    expect(result.value.postalCode).toBe("74311");
    expect(result.value.recipientName).toBe("Budi Santoso");
  });

  test("rejects a missing label even when every other field is present", () => {
    const { label, ...withoutLabel } = VALID_BODY;
    void label;
    const result = validateAccountAddressInput(withoutLabel);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.map((error) => error.field)).toContain("label");
  });

  test("rejects a missing postalCode — REQUIRED here, unlike order-creation's address shape", () => {
    const { postalCode, ...withoutPostalCode } = VALID_BODY;
    void postalCode;
    const result = validateAccountAddressInput(withoutPostalCode);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.map((error) => error.field)).toContain("postalCode");
  });

  test("still enforces the base address checks (e.g. missing street)", () => {
    const { street, ...withoutStreet } = VALID_BODY;
    void street;
    const result = validateAccountAddressInput(withoutStreet);
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    expect(result.errors.map((error) => error.field)).toContain("street");
  });

  test("collects errors from BOTH the label/postalCode checks and the base shape at once", () => {
    const result = validateAccountAddressInput({});
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error("expected invalid");
    const fields = result.errors.map((error) => error.field);
    expect(fields).toContain("label");
    expect(fields).toContain("postalCode");
    expect(fields).toContain("recipientName");
  });
});
