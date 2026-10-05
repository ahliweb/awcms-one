import { describe, expect, test } from "bun:test";
import {
  allocateBundleValue,
  buildBundleSnapshot,
  componentLockOrder,
  componentSourceLine,
  computeBundleAvailability,
  computeDerivedBundlePrice,
  expandBundleLines,
  formatPercentHundredths,
  parsePercentHundredths,
  validateBundleDefinitionFields,
  validateBundleState,
  validateComponentTargets,
  type ComponentProductFacts
} from "../src/modules/commerce/domain/bundle";
import { sortForPosting } from "../src/modules/commerce/domain/commerce-inventory";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const V1 = "44444444-4444-4444-8444-444444444444";
const BUNDLE = "99999999-9999-4999-8999-999999999999";

const facts = (
  entries: Record<string, ComponentProductFacts>
): ReadonlyMap<string, ComponentProductFacts> =>
  new Map(Object.entries(entries));

describe("nesting and component target rules (ADR-0036 D2)", () => {
  const standard: ComponentProductFacts = {
    kind: "standard",
    liveVariantIds: new Set()
  };

  test("a standard product is a valid component", () => {
    expect(
      validateComponentTargets(
        BUNDLE,
        [{ productId: A, variantId: null, quantity: 2 }],
        facts({ [A]: standard })
      )
    ).toEqual([]);
  });

  test("a component that is itself a bundle is refused (no nesting)", () => {
    const errors = validateComponentTargets(
      BUNDLE,
      [{ productId: B, variantId: null, quantity: 1 }],
      facts({ [B]: { kind: "bundle", liveVariantIds: new Set() } })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("not nested");
  });

  test("a bundle cannot contain itself", () => {
    const errors = validateComponentTargets(
      BUNDLE,
      [{ productId: BUNDLE, variantId: null, quantity: 1 }],
      facts({ [BUNDLE]: { kind: "bundle", liveVariantIds: new Set() } })
    );
    expect(errors[0]!.message).toContain("contain itself");
  });

  test("an unknown, deleted or cross-tenant product is refused identically", () => {
    const errors = validateComponentTargets(
      BUNDLE,
      [
        { productId: A, variantId: null, quantity: 1 },
        { productId: C, variantId: null, quantity: 1 }
      ],
      facts({})
    );
    expect(errors.map((e) => e.message)).toEqual([
      "The component product was not found.",
      "The component product was not found."
    ]);
  });

  test("a product with live variants must name one, and it must be its own", () => {
    const withVariants: ComponentProductFacts = {
      kind: "standard",
      liveVariantIds: new Set([V1])
    };
    expect(
      validateComponentTargets(
        BUNDLE,
        [{ productId: A, variantId: null, quantity: 1 }],
        facts({ [A]: withVariants })
      )[0]!.message
    ).toContain("has variants");
    expect(
      validateComponentTargets(
        BUNDLE,
        [{ productId: A, variantId: V1, quantity: 1 }],
        facts({ [A]: withVariants })
      )
    ).toEqual([]);
    expect(
      validateComponentTargets(
        BUNDLE,
        [{ productId: B, variantId: V1, quantity: 1 }],
        facts({ [B]: standard })
      )[0]!.message
    ).toContain("variant was not found");
  });

  test("the same product and variant twice is refused", () => {
    const errors = validateComponentTargets(
      BUNDLE,
      [
        { productId: A, variantId: null, quantity: 1 },
        { productId: A, variantId: null, quantity: 3 }
      ],
      facts({ [A]: standard })
    );
    expect(errors).toHaveLength(1);
  });
});

describe("bundle state rules (ADR-0036 D1/D3)", () => {
  const base = {
    kind: "bundle" as const,
    pricing: "fixed" as const,
    discountPercent: null,
    stock: 0,
    hasServiceForm: false,
    components: null,
    componentCount: 2
  };

  test("a well-formed bundle passes", () => {
    expect(validateBundleState(base)).toEqual([]);
  });

  test("a bundle has no stock, no service form, 1-20 components", () => {
    expect(validateBundleState({ ...base, stock: 3 })[0]!.field).toBe("stock");
    expect(
      validateBundleState({ ...base, hasServiceForm: true })[0]!.field
    ).toBe("serviceForm");
    expect(validateBundleState({ ...base, componentCount: 0 })[0]!.field).toBe(
      "bundleComponents"
    );
    expect(validateBundleState({ ...base, componentCount: 21 })[0]!.field).toBe(
      "bundleComponents"
    );
  });

  test("a discount percent needs derived pricing", () => {
    expect(
      validateBundleState({ ...base, discountPercent: "10.00" })[0]!.field
    ).toBe("bundleDiscountPercent");
    expect(
      validateBundleState({
        ...base,
        pricing: "derived",
        discountPercent: "10.00"
      })
    ).toEqual([]);
  });

  test("a standard product carries no bundle settings", () => {
    const standard = { ...base, kind: "standard" as const, componentCount: 0 };
    expect(validateBundleState(standard)).toEqual([]);
    expect(
      validateBundleState({ ...standard, pricing: "derived" })[0]!.field
    ).toBe("bundlePricing");
    expect(
      validateBundleState({ ...standard, componentCount: 1 })[0]!.field
    ).toBe("bundleComponents");
  });

  test("shape validation of a request body", () => {
    const errors: { field: string; message: string }[] = [];
    const value = validateBundleDefinitionFields(
      {
        kind: "bundle",
        bundlePricing: "derived",
        bundleDiscountPercent: "12.5",
        bundleComponents: [{ productId: A, quantity: 2 }]
      },
      errors
    );
    expect(errors).toEqual([]);
    expect(value.bundleDiscountPercent).toBe("12.50");
    expect(value.bundleComponents).toEqual([
      { productId: A, variantId: null, quantity: 2 }
    ]);

    const bad: { field: string; message: string }[] = [];
    validateBundleDefinitionFields(
      {
        kind: "kit",
        bundlePricing: "formula",
        bundleDiscountPercent: 101,
        bundleComponents: [{ productId: "nope", quantity: 0 }]
      },
      bad
    );
    expect(bad.map((e) => e.field)).toEqual([
      "kind",
      "bundlePricing",
      "bundleDiscountPercent",
      "bundleComponents[0].productId",
      "bundleComponents[0].quantity"
    ]);
    const tooMany: { field: string; message: string }[] = [];
    validateBundleDefinitionFields(
      {
        bundleComponents: Array.from({ length: 21 }, () => ({
          productId: A,
          quantity: 1
        }))
      },
      tooMany
    );
    expect(tooMany[0]!.field).toBe("bundleComponents");
  });
});

describe("availability arithmetic (D4)", () => {
  test("min over components of floor(stock / quantity)", () => {
    expect(
      computeBundleAvailability([
        { stock: 10, quantityPerBundle: 2 },
        { stock: 7, quantityPerBundle: 3 }
      ])
    ).toBe(2);
    expect(
      computeBundleAvailability([{ stock: 9, quantityPerBundle: 3 }])
    ).toBe(3);
  });

  test("an unsellable component, an empty bundle or no stock is zero", () => {
    expect(
      computeBundleAvailability([
        { stock: 10, quantityPerBundle: 1 },
        { stock: null, quantityPerBundle: 1 }
      ])
    ).toBe(0);
    expect(computeBundleAvailability([])).toBe(0);
    expect(
      computeBundleAvailability([{ stock: 1, quantityPerBundle: 2 }])
    ).toBe(0);
  });
});

describe("derived pricing (D3)", () => {
  const parts = [
    { unitPrice: "10000.00", quantityPerBundle: 2 },
    { unitPrice: "2500.50", quantityPerBundle: 1 }
  ];

  test("sum of component list prices x quantity", () => {
    expect(computeDerivedBundlePrice(parts, null)).toBe("22500.50");
    expect(computeDerivedBundlePrice(parts, "0.00")).toBe("22500.50");
  });

  test("percent off, rounded half-up to the cent", () => {
    expect(computeDerivedBundlePrice(parts, "10.00")).toBe("20250.45");
    // 3.33 x (1 - 0.15) = 2.8305 -> 2.83 ; 0.01 x 0.5 = 0.005 -> 0.01
    expect(
      computeDerivedBundlePrice(
        [{ unitPrice: "3.33", quantityPerBundle: 1 }],
        "15"
      )
    ).toBe("2.83");
    expect(
      computeDerivedBundlePrice(
        [{ unitPrice: "0.01", quantityPerBundle: 1 }],
        "50"
      )
    ).toBe("0.01");
    expect(computeDerivedBundlePrice(parts, "100.00")).toBe("0.00");
  });

  test("percent parsing is exact", () => {
    expect(parsePercentHundredths("12.5")).toBe(1250);
    expect(parsePercentHundredths(12.34)).toBe(1234);
    expect(parsePercentHundredths("100.01")).toBeNull();
    expect(parsePercentHundredths("1.234")).toBeNull();
    expect(parsePercentHundredths(-1)).toBeNull();
    expect(formatPercentHundredths(5)).toBe("0.05");
    expect(formatPercentHundredths(10000)).toBe("100.00");
  });
});

describe("allocation of the line value across components (D5)", () => {
  const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);

  test("shares always sum to the line total exactly", () => {
    const parts = [
      { unitPrice: "3.33", quantityPerBundle: 1 },
      { unitPrice: "6.67", quantityPerBundle: 1 },
      { unitPrice: "1.00", quantityPerBundle: 3 }
    ];
    for (const total of [1n, 2n, 99n, 1000n, 1234567n]) {
      for (const qty of [1, 2, 7]) {
        expect(sum(allocateBundleValue(total, parts, qty))).toBe(total);
      }
    }
  });

  test("proportional to list value, largest remainder, ties to the earlier position", () => {
    // 100 cents over weights 1:1:1 -> 34/33/33 (the extra cent goes first)
    const equal = [
      { unitPrice: "1.00", quantityPerBundle: 1 },
      { unitPrice: "1.00", quantityPerBundle: 1 },
      { unitPrice: "1.00", quantityPerBundle: 1 }
    ];
    expect(allocateBundleValue(100n, equal, 1)).toEqual([34n, 33n, 33n]);
    // 2:1 -> 200 cents = 133/67
    expect(
      allocateBundleValue(
        200n,
        [
          { unitPrice: "2.00", quantityPerBundle: 1 },
          { unitPrice: "1.00", quantityPerBundle: 1 }
        ],
        1
      )
    ).toEqual([133n, 67n]);
  });

  test("zero list values split evenly; a zero total is all zero", () => {
    const free = [
      { unitPrice: "0.00", quantityPerBundle: 1 },
      { unitPrice: "0.00", quantityPerBundle: 1 }
    ];
    expect(allocateBundleValue(5n, free, 1)).toEqual([3n, 2n]);
    expect(allocateBundleValue(0n, free, 1)).toEqual([0n, 0n]);
  });

  test("the snapshot rows carry totals and decimal shares", () => {
    const rows = buildBundleSnapshot("30000.00", 2, [
      {
        position: 1,
        productId: A,
        variantId: null,
        sku: "A",
        name: "Alpha",
        variantName: null,
        quantityPerBundle: 2,
        unitPrice: "10000.00"
      },
      {
        position: 2,
        productId: B,
        variantId: V1,
        sku: "B-1",
        name: "Beta",
        variantName: "Red",
        quantityPerBundle: 1,
        unitPrice: "5000.00"
      }
    ]);
    expect(rows.map((r) => r.quantityTotal)).toEqual([4, 2]);
    expect(rows.map((r) => r.allocatedValue)).toEqual(["24000.00", "6000.00"]);
  });
});

describe("source line ids and line expansion (D6)", () => {
  test("component source lines are <line>:c<position> and fit the ledger limit", () => {
    const line = componentSourceLine(A, 20);
    expect(line).toBe(`${A}:c20`);
    expect(line.length).toBeLessThanOrEqual(64);
    expect(line).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  });

  test("a bundle line becomes its components; a standard line passes through", () => {
    const expanded = expandBundleLines(
      [
        { lineId: "L1", productId: BUNDLE, variantId: null, quantity: 3 },
        { lineId: "L2", productId: C, variantId: null, quantity: 1 }
      ],
      new Map([
        [
          "L1",
          [
            {
              position: 1,
              productId: A,
              variantId: null,
              quantityPerBundle: 2
            },
            { position: 2, productId: B, variantId: V1, quantityPerBundle: 1 }
          ]
        ]
      ])
    );
    expect(expanded).toEqual([
      { lineId: "L1:c1", productId: A, variantId: null, quantity: 6 },
      { lineId: "L1:c2", productId: B, variantId: V1, quantity: 3 },
      { lineId: "L2", productId: C, variantId: null, quantity: 1 }
    ]);
  });

  test("component lines sort with the other lines of the order, globally", () => {
    const expanded = expandBundleLines(
      [
        { lineId: "L1", productId: BUNDLE, variantId: null, quantity: 1 },
        { lineId: "L2", productId: A, variantId: null, quantity: 1 }
      ],
      new Map([
        [
          "L1",
          [
            {
              position: 1,
              productId: C,
              variantId: null,
              quantityPerBundle: 1
            },
            { position: 2, productId: A, variantId: null, quantityPerBundle: 1 }
          ]
        ]
      ])
    );
    const sorted = sortForPosting(
      expanded.map((line) => ({
        line,
        item: {
          itemType: "commerce.product" as const,
          itemRef: line.productId
        },
        lineKey: line.lineId
      }))
    ).map((entry) => entry.line.lineId);
    // A (L1:c2, L2) before C (L1:c1), whatever order the lines were built in.
    expect(sorted).toEqual(["L1:c2", "L2", "L1:c1"]);
  });

  test("counter-mode lock order is products then variants, ascending id", () => {
    expect(
      componentLockOrder([
        { productId: C, variantId: V1 },
        { productId: B, variantId: null },
        { productId: A, variantId: null },
        { productId: B, variantId: null }
      ])
    ).toEqual([
      { kind: "product", id: A },
      { kind: "product", id: B },
      { kind: "variant", id: V1 }
    ]);
  });
});
