/**
 * Commerce tax adapter — Issue #293, ADR-0039. Pure: no database, no network.
 *
 * The load-bearing property is PARITY (ADR-0039 D3): with the same percentage,
 * `exclusive` pricing, `half_up`, scale 2 and `document` level, the tax module's
 * result equals the flat store-level percentage EXACTLY, for any cart and any
 * voucher. It is proven over seeded random carts (a fixed seed, so a failure is
 * reproducible), at the adapter and again through the real `quoteCart`.
 */
import { describe, expect, test } from "bun:test";

import {
  quoteCart,
  type CartQuoteContext,
  type CartQuoteProductSnapshot
} from "../src/modules/commerce/domain/cart-quote";
import {
  businessDateInTimeZone,
  buildTaxLineInputs,
  computeEngineTax,
  fallbackRatePercent,
  versionTaxesAnything
} from "../src/modules/commerce/domain/tax-adapter";
import {
  fromCents,
  toCents
} from "../src/modules/commerce/domain/price-calculation";
import { validateCreateProductInput } from "../src/modules/commerce/domain/product-validation";
import type { StoreSettingsData } from "../src/modules/commerce/domain/store-settings-validation";
import type {
  ResolvedTaxRuleVersion,
  TaxRule
} from "../src/modules/tax/domain/tax-types";

const NOW = new Date("2026-10-05T03:00:00.000Z");

/** Mulberry32 — a tiny seeded PRNG so every run sees the same carts. */
function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function version(
  overrides: Partial<ResolvedTaxRuleVersion> & {
    percent?: number | string;
  } = {}
): ResolvedTaxRuleVersion {
  const { percent = 11, ...rest } = overrides;
  const rules: TaxRule[] = [
    {
      categoryCode: null,
      treatment: "taxable",
      components: [
        { code: "tax", name: "Tax", rate: String(percent), basis: "net" }
      ]
    }
  ];

  return {
    ruleVersionId: "00000000-0000-4000-8000-000000000001",
    profileCode: "store-default",
    versionNo: 1,
    jurisdictionCode: "XX",
    currencyCode: "IDR",
    pricingMode: "exclusive",
    roundingMode: "half_up",
    roundingScale: 2,
    roundingLevel: "document",
    definition: { categories: [], rules },
    ...rest
  };
}

/** The pre-#293 formula, verbatim from `quoteCart`. */
function flatTaxCents(
  subtotalCents: bigint,
  voucherCents: bigint,
  percent: number
): bigint {
  return ((subtotalCents - voucherCents) * BigInt(percent) + 50n) / 100n;
}

describe("buildTaxLineInputs — document discount allocation", () => {
  test("allocates by largest remainder, ties to the lower index, summing exactly", () => {
    const lines = [
      {
        lineRef: "a",
        categoryCode: null,
        quantity: 1,
        unitPrice: "10.00",
        lineTotal: "10.00"
      },
      {
        lineRef: "b",
        categoryCode: null,
        quantity: 1,
        unitPrice: "10.00",
        lineTotal: "10.00"
      },
      {
        lineRef: "c",
        categoryCode: null,
        quantity: 1,
        unitPrice: "10.00",
        lineTotal: "10.00"
      }
    ];
    const inputs = buildTaxLineInputs(lines, toCents("1.00"));

    // 100 cents over three equal lines: 33 each, the leftover cent to the FIRST.
    expect(inputs.map((line) => line.discount)).toEqual([
      "0.34",
      "0.33",
      "0.33"
    ]);
    expect(
      inputs.reduce((sum, line) => sum + toCents(line.discount!), 0n)
    ).toBe(100n);
  });

  test("never exceeds a line, and caps at the subtotal", () => {
    const inputs = buildTaxLineInputs(
      [
        {
          lineRef: "a",
          categoryCode: null,
          quantity: 2,
          unitPrice: "0.50",
          lineTotal: "1.00"
        },
        {
          lineRef: "b",
          categoryCode: null,
          quantity: 1,
          unitPrice: "0.00",
          lineTotal: "0.00"
        }
      ],
      toCents("50.00")
    );

    expect(inputs.map((line) => line.discount)).toEqual(["1.00", "0.00"]);
  });

  test("no discount means a zero discount on every line", () => {
    const inputs = buildTaxLineInputs(
      [
        {
          lineRef: "a",
          categoryCode: "food",
          quantity: 3,
          unitPrice: "7.25",
          lineTotal: "21.75"
        }
      ],
      0n
    );

    expect(inputs).toEqual([
      {
        lineRef: "a",
        categoryCode: "food",
        quantity: "3",
        unitPrice: "7.25",
        discount: "0.00"
      }
    ]);
  });
});

describe("parity — the engine equals the flat percentage exactly", () => {
  test("2,000 seeded random carts, every integer-percent family", () => {
    const next = rng(293);
    const pick = (min: number, max: number): number =>
      min + Math.floor(next() * (max - min + 1));

    for (let round = 0; round < 2000; round += 1) {
      const percent = [0, 1, 5, 10, 11, 12, 15, 25, 50, 100][pick(0, 9)]!;
      const lineCount = pick(1, 8);
      const lines = Array.from({ length: lineCount }, (_, index) => {
        const unitCents = BigInt(pick(0, 2_500_000)) * (next() < 0.2 ? 1n : 1n);
        const quantity = pick(1, 40);

        return {
          lineRef: String(index + 1),
          categoryCode: null,
          quantity,
          unitPrice: fromCents(unitCents),
          lineTotal: fromCents(unitCents * BigInt(quantity))
        };
      });
      const subtotalCents = lines.reduce(
        (sum, line) => sum + toCents(line.lineTotal),
        0n
      );
      // A voucher anywhere from nothing to the whole subtotal.
      const voucherCents =
        next() < 0.4
          ? 0n
          : BigInt(Math.floor(next() * Number(subtotalCents + 1n)));
      const outcome = computeEngineTax(
        version({ percent }),
        "store-default",
        "2026-10-05",
        lines,
        voucherCents
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.figure.amountCents).toBe(
        flatTaxCents(subtotalCents, voucherCents, percent)
      );
    }
  });

  test("through the real quoteCart: tax and total are identical in both modes", () => {
    const next = rng(2930);
    const pick = (min: number, max: number): number =>
      min + Math.floor(next() * (max - min + 1));

    for (let round = 0; round < 500; round += 1) {
      const percent = [0, 5, 10, 11, 12, 25][pick(0, 5)]!;
      const productCount = pick(1, 5);
      const products = new Map<string, CartQuoteProductSnapshot>();
      const lines = [];

      for (let index = 0; index < productCount; index += 1) {
        const id = `p${index}`;

        products.set(
          id,
          product({
            id,
            price: fromCents(BigInt(pick(100, 900_000))),
            discountPercent: next() < 0.3 ? pick(1, 40) : 0
          })
        );
        lines.push({
          productId: id,
          variantId: null,
          quantity: pick(1, 12),
          serviceFormValues: null
        });
      }

      // The voucher is sized against the real subtotal. A NOMINAL voucher larger
      // than the subtotal is a pre-existing flat-mode oddity (a negative tax); the
      // engine caps the discount at the subtotal instead — see the next test.
      const subtotalCents = toCents(
        quoteCart(
          { lines, shipping: null, insurance: false },
          context({ products })
        ).subtotal
      );
      const voucher =
        next() < 0.5
          ? {
              code: "V",
              lookup: {
                found: true as const,
                row: {
                  type:
                    next() < 0.5
                      ? ("percentage" as const)
                      : ("nominal" as const),
                  value: "0.00",
                  minOrder: "0.00",
                  maxDiscount: null,
                  quota: 0,
                  usedCount: 0,
                  startsAt: new Date("2026-01-01T00:00:00Z"),
                  endsAt: new Date("2027-01-01T00:00:00Z")
                }
              }
            }
          : null;

      if (voucher && voucher.lookup.row.type === "percentage") {
        voucher.lookup.row.value = fromCents(BigInt(pick(1, 100)) * 100n);
      } else if (voucher) {
        voucher.lookup.row.value = fromCents(
          BigInt(Math.floor(next() * Number(subtotalCents + 1n)))
        );
      }

      const settings = defaultSettings(percent);
      const flat = quoteCart(
        { lines, shipping: null, insurance: false },
        context({ products, storeSettings: settings, voucher })
      );
      const engine = quoteCart(
        { lines, shipping: null, insurance: false },
        context({
          products,
          storeSettings: settings,
          voucher,
          tax: {
            mode: "engine",
            profileCode: "store-default",
            taxDate: "2026-10-05",
            version: version({ percent }),
            categoryByProductId: new Map()
          }
        })
      );

      expect(flat.tax.mode).toBe("flat");
      expect(engine.tax.mode).toBe("engine");
      expect(engine.tax.amount).toBe(flat.tax.amount);
      expect(engine.total).toBe(flat.total);
      expect(engine.canCheckout).toBe(flat.canCheckout);
    }
  });

  test("a nominal voucher above the subtotal is capped by the engine (flat goes negative)", () => {
    const outcome = computeEngineTax(
      version({ percent: 11 }),
      "store-default",
      "2026-10-05",
      [
        {
          lineRef: "1",
          categoryCode: null,
          quantity: 1,
          unitPrice: "10.00",
          lineTotal: "10.00"
        }
      ],
      toCents("25.00")
    );

    expect(outcome.ok && outcome.figure.amountCents).toBe(0n);
  });

  test("an absent tax context is flat mode, byte for byte", () => {
    const quote = quoteCart(
      { lines: [line("product-1", 3)], shipping: null, insurance: false },
      context({ storeSettings: defaultSettings(11) })
    );

    expect(quote.tax).toEqual({
      active: true,
      percent: 11,
      amount: "3300.00",
      mode: "flat",
      inclusive: false,
      error: null,
      engine: null
    });
    expect(quote.total).toBe("33300.00");
  });
});

describe("categories — exempt and zero-rated lines", () => {
  const withCategories = (): ResolvedTaxRuleVersion => {
    const base = version({ percent: 10 });

    return {
      ...base,
      definition: {
        categories: [
          { code: "staple", name: "Staples" },
          { code: "export", name: "Export" }
        ],
        rules: [
          ...base.definition.rules,
          { categoryCode: "staple", treatment: "exempt", components: [] },
          { categoryCode: "export", treatment: "zero_rated", components: [] }
        ]
      }
    };
  };

  test("only standard-category lines carry tax", () => {
    const lines = [
      {
        lineRef: "1",
        categoryCode: null,
        quantity: 1,
        unitPrice: "100.00",
        lineTotal: "100.00"
      },
      {
        lineRef: "2",
        categoryCode: "staple",
        quantity: 1,
        unitPrice: "200.00",
        lineTotal: "200.00"
      },
      {
        lineRef: "3",
        categoryCode: "export",
        quantity: 1,
        unitPrice: "300.00",
        lineTotal: "300.00"
      }
    ];
    const outcome = computeEngineTax(
      withCategories(),
      "store-default",
      "2026-10-05",
      lines,
      0n
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(fromCents(outcome.figure.amountCents)).toBe("10.00");
    expect(
      outcome.figure.calculation.lines.map((entry) => entry.treatment)
    ).toEqual(["taxable", "exempt", "zero_rated"]);
  });

  test("a category with no rule and no fallback is refused, never untaxed", () => {
    const strict: ResolvedTaxRuleVersion = {
      ...withCategories(),
      definition: {
        categories: [],
        rules: [{ categoryCode: "staple", treatment: "exempt", components: [] }]
      }
    };
    const outcome = computeEngineTax(
      strict,
      "store-default",
      "2026-10-05",
      [
        {
          lineRef: "1",
          categoryCode: "gadget",
          quantity: 1,
          unitPrice: "5.00",
          lineTotal: "5.00"
        }
      ],
      0n
    );

    expect(outcome).toMatchObject({ ok: false, code: "TAX_RULE_NOT_FOUND" });
  });

  test("quoteCart maps a product's category onto its line", () => {
    const products = new Map([
      ["p-std", product({ id: "p-std", price: "100.00" })],
      ["p-food", product({ id: "p-food", price: "200.00" })]
    ]);
    const quote = quoteCart(
      {
        lines: [line("p-std", 1), line("p-food", 1)],
        shipping: null,
        insurance: false
      },
      context({
        products,
        tax: {
          mode: "engine",
          profileCode: "store-default",
          taxDate: "2026-10-05",
          version: withCategories(),
          categoryByProductId: new Map([
            ["p-food", "staple"],
            ["p-std", null]
          ])
        }
      })
    );

    expect(quote.tax.amount).toBe("10.00");
    expect(quote.total).toBe("310.00");
    expect(quote.tax.engine?.versionNo).toBe(1);
  });
});

describe("inclusive pricing", () => {
  test("the tax is extracted from the price and NOT added to the total", () => {
    const quote = quoteCart(
      { lines: [line("product-1", 1)], shipping: null, insurance: false },
      context({
        products: new Map([["product-1", product({ price: "111.00" })]]),
        tax: {
          mode: "engine",
          profileCode: "store-default",
          taxDate: "2026-10-05",
          version: version({ percent: 11, pricingMode: "inclusive" }),
          categoryByProductId: new Map()
        }
      })
    );

    expect(quote.tax.inclusive).toBe(true);
    expect(quote.tax.amount).toBe("11.00");
    expect(quote.subtotal).toBe("111.00");
    expect(quote.total).toBe("111.00");
  });

  test("a voucher reduces the inclusive base like any other discount", () => {
    const outcome = computeEngineTax(
      version({ percent: 10, pricingMode: "inclusive" }),
      "store-default",
      "2026-10-05",
      [
        {
          lineRef: "1",
          categoryCode: null,
          quantity: 1,
          unitPrice: "120.00",
          lineTotal: "120.00"
        }
      ],
      toCents("10.00")
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 110.00 gross carries 10.00 of tax at 10 %.
    expect(fromCents(outcome.figure.amountCents)).toBe("10.00");
  });
});

describe("refusals — fail closed", () => {
  test("no published version blocks checkout and taxes nothing silently", () => {
    const quote = quoteCart(
      { lines: [line("product-1", 1)], shipping: null, insurance: false },
      context({
        tax: {
          mode: "engine",
          profileCode: "store-default",
          taxDate: "2026-10-05",
          version: null,
          categoryByProductId: new Map()
        }
      })
    );

    expect(quote.tax.error).toBe("TAX_RULE_VERSION_NOT_FOUND");
    expect(quote.canCheckout).toBe(false);
  });

  test("a rounding scale commerce cannot store is refused", () => {
    const outcome = computeEngineTax(
      version({ roundingScale: 0 }),
      "store-default",
      "2026-10-05",
      [
        {
          lineRef: "1",
          categoryCode: null,
          quantity: 1,
          unitPrice: "5.00",
          lineTotal: "5.00"
        }
      ],
      0n
    );

    expect(outcome).toMatchObject({ ok: false, code: "TAX_INPUT_INVALID" });
  });

  test("an empty cart taxes nothing", () => {
    const outcome = computeEngineTax(
      version(),
      "store-default",
      "2026-10-05",
      [],
      0n
    );

    expect(outcome.ok && outcome.figure.amountCents).toBe(0n);
  });
});

describe("helpers", () => {
  test("legacy percent/active reflect the fallback rule", () => {
    expect(fallbackRatePercent(version({ percent: "7.5" }))).toBe(7.5);
    expect(versionTaxesAnything(version())).toBe(true);
    expect(
      versionTaxesAnything({
        ...version(),
        definition: {
          categories: [],
          rules: [{ categoryCode: null, treatment: "exempt", components: [] }]
        }
      })
    ).toBe(false);
  });

  test("the business date is the store's calendar date, not the server's", () => {
    // 18:00 UTC on 5 Oct is already 6 Oct in Jakarta (UTC+7).
    expect(
      businessDateInTimeZone(new Date("2026-10-05T18:00:00Z"), "Asia/Jakarta")
    ).toBe("2026-10-06");
    expect(
      businessDateInTimeZone(new Date("2026-10-05T03:00:00Z"), "Asia/Jakarta")
    ).toBe("2026-10-05");
    expect(
      businessDateInTimeZone(
        new Date("2026-10-05T03:00:00Z"),
        "America/Los_Angeles"
      )
    ).toBe("2026-10-04");
  });

  test("a product's taxCategoryCode is validated against the tax module's code shape", () => {
    const base = {
      name: "Kopi",
      sku: "KP-1",
      slug: "kopi",
      price: "10.00"
    };
    const good = validateCreateProductInput({
      ...base,
      taxCategoryCode: "staple"
    });
    const blank = validateCreateProductInput({
      ...base,
      taxCategoryCode: "  "
    });
    const bad = validateCreateProductInput({
      ...base,
      taxCategoryCode: "Not A Code!"
    });

    expect(good.valid && good.value.taxCategoryCode).toBe("staple");
    expect(blank.valid && blank.value.taxCategoryCode).toBeNull();
    expect(bad.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function line(productId: string, quantity: number) {
  return { productId, variantId: null, quantity, serviceFormValues: null };
}

function product(
  overrides: Partial<CartQuoteProductSnapshot> = {}
): CartQuoteProductSnapshot {
  return {
    id: "product-1",
    slug: "mie",
    name: "Mie",
    sku: "M1",
    price: "10000.00",
    priceLevel2: null,
    priceLevel3: null,
    priceLevel4: null,
    discountPercent: 0,
    stock: 100000,
    status: "active",
    minPurchase: 1,
    weightGrams: 100,
    withInsurance: false,
    insuranceRequired: false,
    allowDp: false,
    allowFreeShipping: true,
    serviceForm: null,
    imageUrl: null,
    imageAlt: null,
    ...overrides
  };
}

function defaultSettings(percent = 11): StoreSettingsData {
  return {
    schemaVersion: 1,
    storeName: "Toko",
    tagline: null,
    logoMediaObjectId: null,
    faviconMediaObjectId: null,
    address: null,
    phone: null,
    whatsapp: null,
    email: null,
    mapsEmbedUrl: null,
    faqs: [],
    social: {
      facebook: null,
      instagram: null,
      tiktok: null,
      x: null,
      youtube: null,
      linkedin: null
    },
    customerLevels: [1, 2, 3, 4].map((level) => ({
      level,
      name: `Level ${level}`,
      type: "percentage" as const,
      value: "0.00"
    })),
    shipping: {
      alternativeServices: [],
      selfPickup: true,
      courierEnabled: false,
      pinpointEnabled: false,
      freeShipping: { active: false, minOrder: "0.00", maxDiscount: "0.00" },
      originCityName: null,
      originSubdistrictName: null,
      courier: { enabled: false, originDestinationId: null, couriers: [] }
    },
    payment: {
      manualBank: { active: true, accounts: [] },
      manualQris: { active: true, mediaObjectId: null },
      downPayment: { active: false, percent: 50 },
      tax: { active: true, percent },
      insurance: { active: false, ratePercent: "0.0", minFee: "0.00" },
      gateway: { enabled: false }
    },
    orders: { expiryHours: 24 },
    promoSection: { active: false, items: [] },
    meta: {
      home: { title: null, description: null },
      contact: { title: null, description: null }
    }
  };
}

function context(overrides: Partial<CartQuoteContext> = {}): CartQuoteContext {
  return {
    products: new Map([["product-1", product()]]),
    variants: new Map(),
    flashSales: new Map(),
    storeSettings: defaultSettings(),
    voucher: null,
    now: NOW,
    ...overrides
  };
}
