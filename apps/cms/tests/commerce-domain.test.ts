/**
 * `commerce` domain tests (Issue #4, extended to full product-model parity by
 * Issue #23). Pure — no database, no network, no import that carries either.
 * Covers `domain/product-type.ts`, `domain/product-status.ts`,
 * `domain/product-validation.ts`, `domain/category-validation.ts`,
 * `domain/price-calculation.ts`, `domain/size-chart.ts`,
 * `domain/subscription-period.ts`, `domain/product-sort.ts`,
 * `domain/service-form-validation.ts`,
 * `domain/variant-attributes-validation.ts`,
 * `domain/product-image-validation.ts`, and
 * `domain/product-variant-validation.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  isProductType,
  PRODUCT_TYPES
} from "../src/modules/commerce/domain/product-type";
import {
  applyProductStatus,
  isProductStatus,
  LEGAL_TRANSITIONS,
  PRODUCT_STATUSES,
  type ProductStatus
} from "../src/modules/commerce/domain/product-status";
import {
  validateCreateProductInput,
  validateUpdateProductInput
} from "../src/modules/commerce/domain/product-validation";
import {
  validateCreateCategoryInput,
  validateUpdateCategoryInput
} from "../src/modules/commerce/domain/category-validation";
import { computeFinalPrice } from "../src/modules/commerce/domain/price-calculation";
import {
  isSizeChartType,
  reconcileSizeChart,
  SIZE_CHART_TYPES
} from "../src/modules/commerce/domain/size-chart";
import {
  isSubscriptionPeriod,
  SUBSCRIPTION_PERIODS
} from "../src/modules/commerce/domain/subscription-period";
import {
  isProductSort,
  PRODUCT_SORTS
} from "../src/modules/commerce/domain/product-sort";
import { validateServiceForm } from "../src/modules/commerce/domain/service-form-validation";
import { validateVariantAttributes } from "../src/modules/commerce/domain/variant-attributes-validation";
import {
  validateCreateProductImageInput,
  validateUpdateProductImageInput
} from "../src/modules/commerce/domain/product-image-validation";
import {
  validateCreateProductVariantInput,
  validateUpdateProductVariantInput
} from "../src/modules/commerce/domain/product-variant-validation";

describe("isProductType", () => {
  test("accepts every declared type", () => {
    for (const type of PRODUCT_TYPES) {
      expect(isProductType(type)).toBe(true);
    }
  });

  test("rejects an unknown string and a non-string", () => {
    expect(isProductType("bundle")).toBe(false);
    expect(isProductType(42)).toBe(false);
    expect(isProductType(undefined)).toBe(false);
  });
});

describe("isProductStatus", () => {
  test("accepts every declared status", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(isProductStatus(status)).toBe(true);
    }
  });

  test("rejects an unknown string", () => {
    expect(isProductStatus("deleted")).toBe(false);
  });
});

describe("LEGAL_TRANSITIONS", () => {
  test("every status has an entry, and every entry names only real statuses", () => {
    for (const status of PRODUCT_STATUSES) {
      expect(LEGAL_TRANSITIONS[status]).toBeDefined();
      for (const next of LEGAL_TRANSITIONS[status]) {
        expect(PRODUCT_STATUSES).toContain(next);
      }
    }
  });

  test("archived only re-opens through draft", () => {
    expect(LEGAL_TRANSITIONS.archived).toEqual(["draft"]);
  });

  test("every status can reach archived directly", () => {
    // A merchant must always be able to retire a product outright, regardless
    // of which state it is currently in (other than already being there).
    for (const status of PRODUCT_STATUSES) {
      if (status === "archived") continue;
      expect(LEGAL_TRANSITIONS[status]).toContain("archived");
    }
  });
});

describe("applyProductStatus", () => {
  test("same-state is always legal, even for a status with no other transitions out", () => {
    for (const status of PRODUCT_STATUSES) {
      const result = applyProductStatus(status, status);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.value).toBe(status);
    }
  });

  test("a legal forward transition succeeds", () => {
    const result = applyProductStatus("draft", "active");
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toBe("active");
  });

  test("active can be pulled to inactive and back", () => {
    expect(applyProductStatus("active", "inactive").valid).toBe(true);
    expect(applyProductStatus("inactive", "active").valid).toBe(true);
  });

  test("an illegal transition is refused and names the field", () => {
    // archived -> active skips re-authoring through draft.
    const result = applyProductStatus("archived", "active");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.field).toBe("status");
      expect(result.errors[0]!.message).toContain("archived");
      expect(result.errors[0]!.message).toContain("active");
    }
  });

  test("draft cannot go directly to inactive", () => {
    // A product must be made active before it can be pulled from sale.
    expect(applyProductStatus("draft", "inactive").valid).toBe(false);
  });

  test("the message names every legal next state", () => {
    const result = applyProductStatus(
      "draft" as ProductStatus,
      "inactive" as ProductStatus
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      for (const legal of LEGAL_TRANSITIONS.draft) {
        expect(result.errors[0]!.message).toContain(legal);
      }
    }
  });
});

describe("validateCreateProductInput — required fields", () => {
  const VALID_BODY = {
    sku: "SKU-001",
    name: "Kopi Robusta 250g",
    slug: "kopi-robusta-250g",
    price: "45000.00"
  };

  test("a minimal valid body succeeds and defaults the rest", () => {
    const result = validateCreateProductInput(VALID_BODY);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.type).toBe("physical");
      expect(result.value.discountPercent).toBe(0);
      expect(result.value.stock).toBe(0);
      expect(result.value.categoryId).toBeNull();
      expect(result.value.description).toBeNull();
      expect(result.value.sku).toBe("SKU-001");
      expect(result.value.price).toBe("45000.00");
    }
  });

  test("an empty body is refused, naming every missing required field", () => {
    const result = validateCreateProductInput({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("sku");
      expect(fields).toContain("name");
      expect(fields).toContain("slug");
      expect(fields).toContain("price");
    }
  });

  test("sku/name are trimmed", () => {
    const result = validateCreateProductInput({
      ...VALID_BODY,
      sku: "  SKU-001  ",
      name: "  Kopi Robusta 250g  "
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.sku).toBe("SKU-001");
      expect(result.value.name).toBe("Kopi Robusta 250g");
    }
  });

  test("an empty description clears to null rather than storing ''", () => {
    const result = validateCreateProductInput({
      ...VALID_BODY,
      description: "   "
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.description).toBeNull();
  });
});

describe("validateCreateProductInput — slug", () => {
  const VALID_BODY = {
    sku: "SKU-001",
    name: "Kopi Robusta 250g",
    price: "45000.00"
  };

  test("rejects uppercase, spaces, and double hyphens", () => {
    for (const slug of [
      "Kopi-Robusta",
      "kopi robusta",
      "kopi--robusta",
      "-kopi",
      "kopi-"
    ]) {
      const result = validateCreateProductInput({ ...VALID_BODY, slug });
      expect(result.valid, slug).toBe(false);
    }
  });

  test("accepts lowercase alphanumeric segments", () => {
    const result = validateCreateProductInput({
      ...VALID_BODY,
      slug: "kopi-robusta-250g"
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateCreateProductInput — price (numeric(14,2) as text)", () => {
  const VALID_BODY = {
    sku: "SKU-001",
    name: "Kopi Robusta 250g",
    slug: "kopi-robusta-250g"
  };

  test("accepts an integer price, one fractional digit, and two", () => {
    for (const price of ["0", "45000", "45000.5", "45000.00"]) {
      const result = validateCreateProductInput({ ...VALID_BODY, price });
      expect(result.valid, price).toBe(true);
    }
  });

  test("refuses a negative price", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, price: "-1.00" }).valid
    ).toBe(false);
  });

  test("refuses more than 2 fractional digits", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, price: "45000.999" }).valid
    ).toBe(false);
  });

  test("refuses a JSON number — price must be a STRING", () => {
    // The whole point of Issue #4's money decision: a float can never even
    // reach validation as a legitimate price.
    const result = validateCreateProductInput({ ...VALID_BODY, price: 45000 });
    expect(result.valid).toBe(false);
  });

  test("refuses a non-numeric string", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, price: "free" }).valid
    ).toBe(false);
  });
});

describe("validateCreateProductInput — bounded fields", () => {
  const VALID_BODY = {
    sku: "SKU-001",
    name: "Kopi Robusta 250g",
    slug: "kopi-robusta-250g",
    price: "45000.00"
  };

  test("type must be one of the declared union", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, type: "bundle" }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, type: "digital" }).valid
    ).toBe(true);
  });

  test("discountPercent must be an integer between 0 and 100", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, discountPercent: -1 }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, discountPercent: 101 }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, discountPercent: 10.5 }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, discountPercent: 10 }).valid
    ).toBe(true);
  });

  test("stock must be a non-negative integer", () => {
    expect(validateCreateProductInput({ ...VALID_BODY, stock: -1 }).valid).toBe(
      false
    );
    expect(
      validateCreateProductInput({ ...VALID_BODY, stock: 3.5 }).valid
    ).toBe(false);
    expect(validateCreateProductInput({ ...VALID_BODY, stock: 0 }).valid).toBe(
      true
    );
  });

  test("categoryId must be a UUID when present", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, categoryId: "not-a-uuid" })
        .valid
    ).toBe(false);
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        categoryId: "11111111-1111-4111-8111-111111111111"
      }).valid
    ).toBe(true);
    expect(
      validateCreateProductInput({ ...VALID_BODY, categoryId: null }).valid
    ).toBe(true);
  });
});

describe("validateUpdateProductInput", () => {
  test("an empty body is refused — at least one field is required", () => {
    const result = validateUpdateProductInput({});
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]!.field).toBe("body");
  });

  test("a single field is accepted and nothing else is defaulted in", () => {
    const result = validateUpdateProductInput({ stock: 5 });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ stock: 5 });
    }
  });

  test("status is checked for STRING shape only here — legality is product-status.ts's job", () => {
    expect(validateUpdateProductInput({ status: "" }).valid).toBe(false);
    // Not a real status either, but this function only checks it is a
    // non-empty string — `updateProduct` is what rejects an unknown status.
    const result = validateUpdateProductInput({ status: "not-a-status" });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.status).toBe("not-a-status");
  });

  test("categoryId may be explicitly cleared to null", () => {
    const result = validateUpdateProductInput({ categoryId: null });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.categoryId).toBeNull();
  });
});

describe("validateCreateCategoryInput", () => {
  const VALID_BODY = { name: "Minuman", slug: "minuman" };

  test("a minimal valid body succeeds with a null parent/icon", () => {
    const result = validateCreateCategoryInput(VALID_BODY);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.parentId).toBeNull();
      expect(result.value.icon).toBeNull();
    }
  });

  test("name and slug are required", () => {
    const result = validateCreateCategoryInput({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("name");
      expect(fields).toContain("slug");
    }
  });

  test("slug grammar matches product-validation.ts's", () => {
    expect(
      validateCreateCategoryInput({ ...VALID_BODY, slug: "Minuman" }).valid
    ).toBe(false);
    expect(
      validateCreateCategoryInput({ ...VALID_BODY, slug: "minuman--dingin" })
        .valid
    ).toBe(false);
  });

  test("parentId must be a valid UUID when present", () => {
    expect(
      validateCreateCategoryInput({ ...VALID_BODY, parentId: "not-a-uuid" })
        .valid
    ).toBe(false);
    expect(
      validateCreateCategoryInput({
        ...VALID_BODY,
        parentId: "11111111-1111-4111-8111-111111111111"
      }).valid
    ).toBe(true);
  });
});

describe("validateUpdateCategoryInput", () => {
  test("an empty body is refused", () => {
    expect(validateUpdateCategoryInput({}).valid).toBe(false);
  });

  test("does not accept parentId at all — re-parenting is out of scope", () => {
    // `validateUpdateCategoryInput` takes `unknown`, so this is a RUNTIME
    // check (a stray `parentId` in the request body is silently ignored, not
    // a compile-time one — `UpdateCategoryInput` simply has no such field for
    // `updateCategory` to read).
    const result = validateUpdateCategoryInput({
      name: "Minuman Dingin",
      parentId: "11111111-1111-4111-8111-111111111111"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).not.toHaveProperty("parentId");
    }
  });

  test("an empty icon clears to null", () => {
    const result = validateUpdateCategoryInput({ icon: "" });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.icon).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #23 — full product-model parity
// ---------------------------------------------------------------------------

describe("computeFinalPrice (Issue #23) — exact numeric(14,2) arithmetic", () => {
  test('the acceptance example: "19.10" at 10% is exactly "17.19"', () => {
    expect(computeFinalPrice("19.10", 10)).toBe("17.19");
  });

  test("0% discount returns the price unchanged", () => {
    expect(computeFinalPrice("45000.00", 0)).toBe("45000.00");
  });

  test("100% discount is exactly free", () => {
    expect(computeFinalPrice("45000.00", 100)).toBe("0.00");
  });

  test("an integer price with no fractional part", () => {
    expect(computeFinalPrice("100", 50)).toBe("50.00");
  });

  test("rounds half up to the nearest cent", () => {
    // 10.01 * 0.50 = 5.005 -> rounds up to 5.01, never float drift.
    expect(computeFinalPrice("10.01", 50)).toBe("5.01");
  });

  test("throws on a malformed price string", () => {
    expect(() => computeFinalPrice("free", 10)).toThrow();
    expect(() => computeFinalPrice("-1.00", 10)).toThrow();
  });

  test("throws on an out-of-range discountPercent", () => {
    expect(() => computeFinalPrice("10.00", -1)).toThrow();
    expect(() => computeFinalPrice("10.00", 101)).toThrow();
    expect(() => computeFinalPrice("10.00", 10.5)).toThrow();
  });
});

describe("isSizeChartType / SIZE_CHART_TYPES", () => {
  test("accepts every declared type and rejects an unknown one", () => {
    for (const type of SIZE_CHART_TYPES)
      expect(isSizeChartType(type)).toBe(true);
    expect(isSizeChartType("chart")).toBe(false);
    expect(isSizeChartType(42)).toBe(false);
  });
});

describe("reconcileSizeChart (Issue #23) — cross-field consistency", () => {
  test('"none" clears both carrier fields even if the caller sent them', () => {
    const result = reconcileSizeChart({
      sizeChartType: "none",
      sizeChartMediaId: "11111111-1111-4111-8111-111111111111",
      sizeChartDetails: { rows: [] }
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({
        sizeChartType: "none",
        sizeChartMediaId: null,
        sizeChartDetails: null
      });
    }
  });

  test('"image" requires sizeChartMediaId and clears sizeChartDetails', () => {
    const missing = reconcileSizeChart({
      sizeChartType: "image",
      sizeChartMediaId: null,
      sizeChartDetails: null
    });
    expect(missing.valid).toBe(false);
    if (!missing.valid)
      expect(missing.errors[0]!.field).toBe("sizeChartMediaId");

    const ok = reconcileSizeChart({
      sizeChartType: "image",
      sizeChartMediaId: "11111111-1111-4111-8111-111111111111",
      sizeChartDetails: { rows: [] }
    });
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.value.sizeChartMediaId).toBe(
        "11111111-1111-4111-8111-111111111111"
      );
      expect(ok.value.sizeChartDetails).toBeNull();
    }
  });

  test('"table" requires sizeChartDetails and clears sizeChartMediaId', () => {
    const missing = reconcileSizeChart({
      sizeChartType: "table",
      sizeChartMediaId: null,
      sizeChartDetails: null
    });
    expect(missing.valid).toBe(false);
    if (!missing.valid)
      expect(missing.errors[0]!.field).toBe("sizeChartDetails");

    const ok = reconcileSizeChart({
      sizeChartType: "table",
      sizeChartMediaId: "11111111-1111-4111-8111-111111111111",
      sizeChartDetails: { rows: [["S", "36"]] }
    });
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.value.sizeChartMediaId).toBeNull();
      expect(ok.value.sizeChartDetails).toEqual({ rows: [["S", "36"]] });
    }
  });
});

describe("isSubscriptionPeriod / isProductSort", () => {
  test("accept every declared value and reject an unknown one", () => {
    for (const period of SUBSCRIPTION_PERIODS) {
      expect(isSubscriptionPeriod(period)).toBe(true);
    }
    expect(isSubscriptionPeriod("fortnight")).toBe(false);

    for (const sort of PRODUCT_SORTS) expect(isProductSort(sort)).toBe(true);
    expect(isProductSort("relevance")).toBe(false);
  });
});

describe("validateServiceForm (Issue #23)", () => {
  test("null/undefined is valid — no service form", () => {
    expect(validateServiceForm(null)).toEqual({ valid: true, value: null });
    expect(validateServiceForm(undefined)).toEqual({
      valid: true,
      value: null
    });
  });

  test("a valid array of fields, including a select with options", () => {
    const result = validateServiceForm([
      { id: "name", type: "text", label: "Full name", required: true },
      {
        id: "size",
        type: "select",
        label: "Size",
        required: true,
        options: ["S", "M", "L"]
      }
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toHaveLength(2);
      expect(result.value![1]!.options).toEqual(["S", "M", "L"]);
    }
  });

  test("rejects a non-array, a duplicate id, and a select without options", () => {
    expect(validateServiceForm("nope").valid).toBe(false);

    const duplicate = validateServiceForm([
      { id: "x", type: "text", label: "A", required: false },
      { id: "x", type: "text", label: "B", required: false }
    ]);
    expect(duplicate.valid).toBe(false);

    const noOptions = validateServiceForm([
      { id: "size", type: "select", label: "Size", required: true }
    ]);
    expect(noOptions.valid).toBe(false);
  });

  test("rejects options on a non-select field", () => {
    const result = validateServiceForm([
      {
        id: "note",
        type: "text",
        label: "Note",
        required: false,
        options: ["a"]
      }
    ]);
    expect(result.valid).toBe(false);
  });
});

describe("validateVariantAttributes (Issue #23)", () => {
  test("null/undefined is valid — no declared attributes", () => {
    expect(validateVariantAttributes(null)).toEqual({
      valid: true,
      value: null
    });
  });

  test("a valid group with options, description optional", () => {
    const result = validateVariantAttributes([
      {
        name: "Size",
        options: [{ name: "M" }, { name: "L", description: "Large" }]
      }
    ]);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value![0]!.options).toEqual([
        { name: "M", description: null },
        { name: "L", description: "Large" }
      ]);
    }
  });

  test("rejects a group with no name or an empty options array", () => {
    expect(
      validateVariantAttributes([{ options: [{ name: "M" }] }]).valid
    ).toBe(false);
    expect(
      validateVariantAttributes([{ name: "Size", options: [] }]).valid
    ).toBe(false);
  });
});

describe("validateCreateProductImageInput / validateUpdateProductImageInput (Issue #23)", () => {
  test("mediaObjectId is required and must be a UUID", () => {
    expect(validateCreateProductImageInput({}).valid).toBe(false);
    expect(
      validateCreateProductImageInput({ mediaObjectId: "not-a-uuid" }).valid
    ).toBe(false);

    const result = validateCreateProductImageInput({
      mediaObjectId: "11111111-1111-4111-8111-111111111111"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.altText).toBeNull();
      expect(result.value.sortOrder).toBe(0);
    }
  });

  test("update requires at least one field", () => {
    expect(validateUpdateProductImageInput({}).valid).toBe(false);
    expect(validateUpdateProductImageInput({ sortOrder: 2 }).valid).toBe(true);
  });
});

describe("validateCreateProductVariantInput / validateUpdateProductVariantInput (Issue #23)", () => {
  test("name and value are required on create", () => {
    expect(validateCreateProductVariantInput({}).valid).toBe(false);

    const result = validateCreateProductVariantInput({
      name: "Size",
      value: "L"
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.sku).toBeNull();
      expect(result.value.stock).toBe(0);
    }
  });

  test("colorHex must be #RRGGBB when present", () => {
    expect(
      validateCreateProductVariantInput({
        name: "Color",
        value: "Red",
        colorHex: "red"
      }).valid
    ).toBe(false);
    expect(
      validateCreateProductVariantInput({
        name: "Color",
        value: "Red",
        colorHex: "#ff0000"
      }).valid
    ).toBe(true);
  });

  test("price fields accept a numeric(14,2) string or null", () => {
    expect(
      validateCreateProductVariantInput({
        name: "Size",
        value: "L",
        price: "not-a-price"
      }).valid
    ).toBe(false);
    expect(
      validateCreateProductVariantInput({
        name: "Size",
        value: "L",
        price: "10.00"
      }).valid
    ).toBe(true);
  });

  test("update requires at least one field, and does not require name/value", () => {
    expect(validateUpdateProductVariantInput({}).valid).toBe(false);
    expect(validateUpdateProductVariantInput({ stock: 5 }).valid).toBe(true);
  });
});

describe("validateCreateProductInput — Issue #23 parity fields", () => {
  const VALID_BODY = {
    sku: "SKU-001",
    name: "Kopi Robusta 250g",
    slug: "kopi-robusta-250g",
    price: "45000.00"
  };

  test("every parity field defaults sanely when omitted", () => {
    const result = validateCreateProductInput(VALID_BODY);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.priceLevel2).toBeNull();
      expect(result.value.costPrice).toBeNull();
      expect(result.value.minPurchase).toBe(1);
      expect(result.value.weightGrams).toBe(0);
      expect(result.value.manualRating).toBeNull();
      expect(result.value.withInsurance).toBe(false);
      expect(result.value.sizeChartType).toBe("none");
      expect(result.value.subscriptionPeriod).toBeNull();
      expect(result.value.allowFreeShipping).toBe(true);
      expect(result.value.isFeatured).toBe(false);
      expect(result.value.isRecommended).toBe(false);
    }
  });

  test("minPurchase must be an integer >= 1", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, minPurchase: 0 }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, minPurchase: 1.5 }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, minPurchase: 2 }).valid
    ).toBe(true);
  });

  test('manualRating must be "0.0"-"5.0" with at most one fractional digit', () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, manualRating: "5.5" }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, manualRating: "4.99" }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, manualRating: "4.5" }).valid
    ).toBe(true);
    expect(
      validateCreateProductInput({ ...VALID_BODY, manualRating: null }).valid
    ).toBe(true);
  });

  test("priceLevel2/3/4, costPrice, insuranceFee reuse the numeric(14,2) grammar", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, priceLevel2: "not-money" })
        .valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, priceLevel2: "40000.00" })
        .valid
    ).toBe(true);
    expect(
      validateCreateProductInput({ ...VALID_BODY, priceLevel2: null }).valid
    ).toBe(true);
  });

  test("sizeChart cross-field validation runs on create", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, sizeChartType: "image" })
        .valid
    ).toBe(false);
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        sizeChartType: "image",
        sizeChartMediaId: "11111111-1111-4111-8111-111111111111"
      }).valid
    ).toBe(true);
  });

  test("sizeChartDetails must be an object/array, bounded in size", () => {
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        sizeChartType: "table",
        sizeChartDetails: "not-an-object"
      }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        sizeChartType: "table",
        sizeChartDetails: { rows: [] }
      }).valid
    ).toBe(true);
  });

  test("subscriptionPeriod must be a declared value or null", () => {
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        subscriptionPeriod: "fortnight"
      }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({ ...VALID_BODY, subscriptionPeriod: "month" })
        .valid
    ).toBe(true);
  });

  test("serviceForm and variantAttributes are validated through their own modules", () => {
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        serviceForm: [{ type: "select", label: "x", required: true }]
      }).valid
    ).toBe(false);
    expect(
      validateCreateProductInput({
        ...VALID_BODY,
        variantAttributes: [{ name: "Size", options: [] }]
      }).valid
    ).toBe(false);
  });

  test("boolean parity fields reject a non-boolean", () => {
    expect(
      validateCreateProductInput({ ...VALID_BODY, isFeatured: "yes" }).valid
    ).toBe(false);
  });
});

describe("validateUpdateProductInput — Issue #23 parity fields", () => {
  test("a partial patch touching only a parity field is accepted", () => {
    const result = validateUpdateProductInput({ isFeatured: true });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toEqual({ isFeatured: true });
    }
  });

  test("costPrice may be set on update even though it never appears on create's public echo", () => {
    const result = validateUpdateProductInput({ costPrice: "12000.00" });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.costPrice).toBe("12000.00");
  });
});
