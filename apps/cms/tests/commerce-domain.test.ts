/**
 * `commerce` domain tests (Issue #4). Pure — no database, no network, no
 * import that carries either. Covers `domain/product-type.ts`,
 * `domain/product-status.ts`, `domain/product-validation.ts`, and
 * `domain/category-validation.ts`.
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
