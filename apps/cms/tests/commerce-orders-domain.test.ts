/**
 * `commerce` transactional-surface domain tests (Issue #29, epic #21 in
 * awcms-one). Pure — no database, no network, no import that carries either.
 * Covers `domain/phone-normalisation.ts`, `domain/order-code.ts`,
 * `domain/order-status.ts`, `domain/address-validation.ts`,
 * `domain/cart-quote.ts`, `domain/order-request-validation.ts` and
 * `domain/public-request-validation.ts`.
 *
 * Every money assertion below is on a STRING (ADR-0003) — the point of the
 * arithmetic under test is that `"19.10"` at 10% is `"1.91"`, never
 * `1.9100000000000001`.
 */
import { describe, expect, test } from "bun:test";

import {
  maskPhone,
  normalizePhoneNumber
} from "../src/modules/commerce/domain/phone-normalisation";
import { generateOrderCode } from "../src/modules/commerce/domain/order-code";
import {
  actorMayApplyOrderStatus,
  applyOrderStatusTransition,
  isOrderCancellableByCustomer,
  isOrderPayable,
  isOrderReviewable,
  LEGAL_ORDER_STATUS_TRANSITIONS,
  ORDER_STATUSES
} from "../src/modules/commerce/domain/order-status";
import { validateAddressInput } from "../src/modules/commerce/domain/address-validation";
import {
  quoteCart,
  type CartQuoteContext,
  type CartQuoteFlashSaleSnapshot,
  type CartQuoteProductSnapshot,
  type CartQuoteVariantSnapshot
} from "../src/modules/commerce/domain/cart-quote";
import { validateCreateOrderInput } from "../src/modules/commerce/domain/order-request-validation";
import {
  validateCancelOrderInput,
  validateCartQuoteRequest,
  validateCreateReviewInput,
  validatePaymentConfirmationInput
} from "../src/modules/commerce/domain/public-request-validation";
import type { StoreSettingsData } from "../src/modules/commerce/domain/store-settings-validation";

const NOW = new Date("2026-09-16T10:00:00.000Z");

// ---------------------------------------------------------------------------
// phone-normalisation
// ---------------------------------------------------------------------------

describe("phone-normalisation", () => {
  test("normalises the shapes a customer actually types", () => {
    expect(normalizePhoneNumber("0812-3456-7890")).toEqual({
      valid: true,
      value: "+6281234567890"
    });
    expect(normalizePhoneNumber("081234567890")).toEqual({
      valid: true,
      value: "+6281234567890"
    });
    expect(normalizePhoneNumber("+62 812 3456 7890")).toEqual({
      valid: true,
      value: "+6281234567890"
    });
    expect(normalizePhoneNumber("6281234567890")).toEqual({
      valid: true,
      value: "+6281234567890"
    });
  });

  test("rejects empty, garbage, and implausible lengths", () => {
    expect(normalizePhoneNumber("")).toEqual({
      valid: false,
      reason: "empty"
    });
    expect(normalizePhoneNumber("abc")).toEqual({
      valid: false,
      reason: "invalid_format"
    });
    expect(normalizePhoneNumber("0812")).toEqual({
      valid: false,
      reason: "invalid_length"
    });
    // Neither a leading `0` nor a plausible bare `62` — falls through to a
    // format rejection rather than being misread as a domestic number.
    expect(normalizePhoneNumber("12345")).toEqual({
      valid: false,
      reason: "invalid_format"
    });
  });

  test("masks to the contract's own example shape", () => {
    expect(maskPhone("+6281234567890")).toBe("+62812•••7890");
  });
});

// ---------------------------------------------------------------------------
// order-code
// ---------------------------------------------------------------------------

describe("order-code", () => {
  test("generates BJM-YYYYMMDD-XXXX", () => {
    const code = generateOrderCode(new Date("2026-09-16T03:00:00.000Z"));
    expect(code).toMatch(/^BJM-20260916-[A-Z0-9]{4}$/);
  });

  test("never uses visually ambiguous characters (0/O, 1/I)", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateOrderCode(NOW);
      const suffix = code.split("-")[2]!;
      expect(suffix).not.toMatch(/[01OI]/);
    }
  });
});

// ---------------------------------------------------------------------------
// order-status
// ---------------------------------------------------------------------------

describe("order-status", () => {
  test("legal transition graph matches the issue's own state machine", () => {
    expect(
      ([...LEGAL_ORDER_STATUS_TRANSITIONS.pending_payment] as string[]).sort()
    ).toEqual(["cancelled", "expired", "paid"].sort());
    expect(
      ([...LEGAL_ORDER_STATUS_TRANSITIONS.paid] as string[]).sort()
    ).toEqual(["cancelled", "processing"].sort());
    expect(
      ([...LEGAL_ORDER_STATUS_TRANSITIONS.processing] as string[]).sort()
    ).toEqual(["cancelled", "shipped"].sort());
    expect(LEGAL_ORDER_STATUS_TRANSITIONS.shipped).toEqual(["completed"]);
    for (const terminal of ["completed", "cancelled", "expired"] as const) {
      expect(LEGAL_ORDER_STATUS_TRANSITIONS[terminal]).toEqual([]);
    }
  });

  test("customer may only cancel while pending_payment", () => {
    expect(
      actorMayApplyOrderStatus("customer", "pending_payment", "cancelled")
    ).toBe(true);
    expect(actorMayApplyOrderStatus("customer", "paid", "cancelled")).toBe(
      false
    );
    expect(
      actorMayApplyOrderStatus("customer", "pending_payment", "paid")
    ).toBe(false);
  });

  test("system may only expire a pending_payment order", () => {
    expect(
      actorMayApplyOrderStatus("system", "pending_payment", "expired")
    ).toBe(true);
    expect(actorMayApplyOrderStatus("system", "paid", "expired")).toBe(false);
    expect(
      actorMayApplyOrderStatus("system", "pending_payment", "cancelled")
    ).toBe(false);
  });

  test("admin may apply any legal transition", () => {
    expect(actorMayApplyOrderStatus("admin", "pending_payment", "paid")).toBe(
      true
    );
    expect(actorMayApplyOrderStatus("admin", "paid", "processing")).toBe(true);
    expect(actorMayApplyOrderStatus("admin", "processing", "shipped")).toBe(
      true
    );
    expect(actorMayApplyOrderStatus("admin", "shipped", "completed")).toBe(
      true
    );
    // ...but not an edge the graph itself does not have.
    expect(actorMayApplyOrderStatus("admin", "completed", "paid")).toBe(false);
  });

  test("applyOrderStatusTransition rejects same-status, illegal, and unauthorized moves distinctly", () => {
    expect(applyOrderStatusTransition("admin", "paid", "paid").valid).toBe(
      false
    );
    expect(
      applyOrderStatusTransition("admin", "pending_payment", "completed").valid
    ).toBe(false);
    expect(
      applyOrderStatusTransition("customer", "paid", "cancelled").valid
    ).toBe(false);
    expect(
      applyOrderStatusTransition("admin", "pending_payment", "paid").valid
    ).toBe(true);
  });

  test("derived predicates", () => {
    expect(isOrderPayable("pending_payment")).toBe(true);
    expect(isOrderPayable("paid")).toBe(false);
    expect(isOrderCancellableByCustomer("pending_payment")).toBe(true);
    expect(isOrderCancellableByCustomer("shipped")).toBe(false);
    expect(isOrderReviewable("completed")).toBe(true);
    expect(isOrderReviewable("shipped")).toBe(false);
  });

  test("every declared status round-trips through the transition table", () => {
    for (const status of ORDER_STATUSES) {
      expect(LEGAL_ORDER_STATUS_TRANSITIONS[status]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// address-validation
// ---------------------------------------------------------------------------

describe("address-validation", () => {
  const VALID_ADDRESS = {
    recipientName: "Siti",
    phone: "081234567890",
    provinceCode: "62",
    provinceName: "Kalimantan Tengah",
    cityCode: "62.01",
    cityName: "Kotawaringin Barat",
    districtCode: "62.01.01",
    districtName: "Arut Selatan",
    postalCode: "74111",
    street: "Jl. Mawar 3",
    latitude: null,
    longitude: null,
    notes: null
  };

  test("accepts a well-formed address", () => {
    const result = validateAddressInput(VALID_ADDRESS);
    expect(result.valid).toBe(true);
  });

  test("rejects missing required fields with field-pathed messages", () => {
    const result = validateAddressInput({});
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some((error) => error.field === "address.street")
      ).toBe(true);
      expect(
        result.errors.some((error) => error.field === "address.districtCode")
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// cart-quote
// ---------------------------------------------------------------------------

function product(
  overrides: Partial<CartQuoteProductSnapshot> = {}
): CartQuoteProductSnapshot {
  return {
    id: "product-1",
    slug: "mie-gacoan",
    name: "Mie Gacoan",
    sku: "Gc",
    price: "10000.00",
    discountPercent: 0,
    stock: 100,
    status: "active",
    minPurchase: 1,
    weightGrams: 350,
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

function defaultSettings(
  overrides: Partial<StoreSettingsData> = {}
): StoreSettingsData {
  return {
    schemaVersion: 1,
    storeName: "BjekMart",
    tagline: null,
    logoMediaObjectId: null,
    faviconMediaObjectId: null,
    address: null,
    phone: null,
    whatsapp: "6285128688885",
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
      alternativeServices: [
        { id: "borneojek", name: "BORNEOJEK", cost: "15000.00" }
      ],
      selfPickup: true,
      courierEnabled: false,
      pinpointEnabled: false,
      freeShipping: { active: false, minOrder: "0.00", maxDiscount: "0.00" },
      originCityName: null,
      originSubdistrictName: null
    },
    payment: {
      manualBank: { active: true, accounts: [] },
      manualQris: { active: true, mediaObjectId: null },
      downPayment: { active: false, percent: 50 },
      tax: { active: false, percent: 11 },
      insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
    },
    orders: { expiryHours: 24 },
    promoSection: { active: false, items: [] },
    meta: {
      home: { title: null, description: null },
      contact: { title: null, description: null }
    },
    ...overrides
  };
}

function baseContext(
  overrides: Partial<CartQuoteContext> = {}
): CartQuoteContext {
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

describe("cart-quote — line rejections", () => {
  test("unknown product -> unavailable", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "missing",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ products: new Map() })
    );
    expect(result.lines[0]!.status).toBe("unavailable");
    expect(result.canCheckout).toBe(false);
  });

  test("inactive product -> unavailable", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        products: new Map([["product-1", product({ status: "archived" })]])
      })
    );
    expect(result.lines[0]!.status).toBe("unavailable");
  });

  test("variant not belonging to product -> unavailable", () => {
    const variants = new Map<string, CartQuoteVariantSnapshot>([
      [
        "variant-1",
        {
          id: "variant-1",
          productId: "other-product",
          value: "Merah",
          sku: null,
          price: null,
          stock: 10,
          weightGrams: 100
        }
      ]
    ]);
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: "variant-1",
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ variants })
    );
    expect(result.lines[0]!.status).toBe("unavailable");
  });

  test("quantity below minPurchase -> min_purchase", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        products: new Map([["product-1", product({ minPurchase: 3 })]])
      })
    );
    expect(result.lines[0]!.status).toBe("min_purchase");
  });

  test("zero stock -> out_of_stock", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ products: new Map([["product-1", product({ stock: 0 })]]) })
    );
    expect(result.lines[0]!.status).toBe("out_of_stock");
    expect(result.lines[0]!.availableStock).toBe(0);
  });

  test("quantity exceeds stock but some available -> quantity_reduced", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 10,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ products: new Map([["product-1", product({ stock: 3 })]]) })
    );
    expect(result.lines[0]!.status).toBe("quantity_reduced");
    expect(result.lines[0]!.availableStock).toBe(3);
  });

  test("required service-form field missing -> service_form_invalid", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        products: new Map([
          [
            "product-1",
            product({
              serviceForm: [
                {
                  id: "address",
                  type: "text",
                  label: "Service address",
                  required: true,
                  options: null
                }
              ]
            })
          ]
        ])
      })
    );
    expect(result.lines[0]!.status).toBe("service_form_invalid");
    expect(result.lines[0]!.serviceFormErrors).not.toBeNull();
  });

  test("a fully valid line is ok and computes lineTotal via integer cents", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 3,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext()
    );
    expect(result.lines[0]!.status).toBe("ok");
    expect(result.lines[0]!.unitPrice).toBe("10000.00");
    expect(result.lines[0]!.lineTotal).toBe("30000.00");
    expect(result.subtotal).toBe("30000.00");
    expect(result.canCheckout).toBe(true);
  });

  test("flash-sale price overrides the catalog price and tracks quota", () => {
    const flashSales = new Map<string, CartQuoteFlashSaleSnapshot>([
      [
        "product-1:",
        {
          flashSaleId: "fs-1",
          productId: "product-1",
          variantId: null,
          salePrice: "7500.00",
          quota: 5,
          sold: 4
        }
      ]
    ]);
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ flashSales })
    );
    expect(result.lines[0]!.unitPrice).toBe("7500.00");
    expect(result.lines[0]!.flashSaleId).toBe("fs-1");
    expect(result.lines[0]!.availableStock).toBe(1);
  });

  test("flash-sale quota exhausted -> out_of_stock even though product stock remains", () => {
    const flashSales = new Map<string, CartQuoteFlashSaleSnapshot>([
      [
        "product-1:",
        {
          flashSaleId: "fs-1",
          productId: "product-1",
          variantId: null,
          salePrice: "7500.00",
          quota: 5,
          sold: 5
        }
      ]
    ]);
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ flashSales })
    );
    expect(result.lines[0]!.status).toBe("out_of_stock");
  });
});

describe("cart-quote — arithmetic order (subtotal -> voucher -> shipping -> insurance -> tax -> total)", () => {
  test("percentage voucher capped by maxDiscount", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 10,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        voucher: {
          code: "HEMAT10",
          lookup: {
            found: true,
            row: {
              type: "percentage",
              value: "50.00",
              minOrder: "0.00",
              maxDiscount: "2000.00",
              quota: 0,
              usedCount: 0,
              startsAt: new Date("2026-01-01T00:00:00.000Z"),
              endsAt: new Date("2026-12-31T00:00:00.000Z")
            }
          }
        }
      })
    );
    // subtotal 100000.00 * 50% = 50000.00, capped at 2000.00.
    expect(result.subtotal).toBe("100000.00");
    expect(result.voucher?.valid).toBe(true);
    expect(result.discount).toBe("2000.00");
  });

  test("nominal voucher discounts a flat amount", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        voucher: {
          code: "POTONG5K",
          lookup: {
            found: true,
            row: {
              type: "nominal",
              value: "5000.00",
              minOrder: "0.00",
              maxDiscount: null,
              quota: 0,
              usedCount: 0,
              startsAt: new Date("2026-01-01T00:00:00.000Z"),
              endsAt: new Date("2026-12-31T00:00:00.000Z")
            }
          }
        }
      })
    );
    expect(result.discount).toBe("5000.00");
  });

  test("free_shipping voucher zeroes the selected shipping cost", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: { method: "alternative", serviceId: "borneojek" },
        insurance: false
      },
      baseContext({
        voucher: {
          code: "GRATISONGKIR",
          lookup: {
            found: true,
            row: {
              type: "free_shipping",
              value: "0.00",
              minOrder: "0.00",
              maxDiscount: null,
              quota: 0,
              usedCount: 0,
              startsAt: new Date("2026-01-01T00:00:00.000Z"),
              endsAt: new Date("2026-12-31T00:00:00.000Z")
            }
          }
        }
      })
    );
    expect(result.freeShippingApplied).toBe(true);
    expect(result.shipping?.cost).toBe("0.00");
  });

  test("unknown voucher code answers not_found without failing the quote", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({ voucher: { code: "NOPE", lookup: { found: false } } })
    );
    expect(result.voucher).toEqual({
      code: "NOPE",
      valid: false,
      discount: "0.00",
      freeShipping: false,
      reason: "not_found"
    });
    expect(result.discount).toBe("0.00");
  });

  test("free shipping by store threshold requires every line to allow it", () => {
    const settings = defaultSettings({
      shipping: {
        alternativeServices: [
          { id: "borneojek", name: "BORNEOJEK", cost: "15000.00" }
        ],
        selfPickup: true,
        courierEnabled: false,
        pinpointEnabled: false,
        freeShipping: {
          active: true,
          minOrder: "5000.00",
          maxDiscount: "0.00"
        },
        originCityName: null,
        originSubdistrictName: null
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: { method: "alternative", serviceId: "borneojek" },
        insurance: false
      },
      baseContext({ storeSettings: settings })
    );
    expect(result.freeShippingApplied).toBe(true);
    expect(result.shipping?.cost).toBe("0.00");

    const notEligible = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: { method: "alternative", serviceId: "borneojek" },
        insurance: false
      },
      baseContext({
        storeSettings: settings,
        products: new Map([
          ["product-1", product({ allowFreeShipping: false })]
        ])
      })
    );
    expect(notEligible.freeShippingApplied).toBe(false);
    expect(notEligible.shipping?.cost).toBe("15000.00");
  });

  test("insurance fee is max(minFee, subtotal x ratePercent) when selected", () => {
    const settings = defaultSettings({
      payment: {
        manualBank: { active: true, accounts: [] },
        manualQris: { active: true, mediaObjectId: null },
        downPayment: { active: false, percent: 50 },
        tax: { active: false, percent: 11 },
        insurance: { active: true, ratePercent: "1.00", minFee: "5000.00" }
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: true
      },
      baseContext({
        storeSettings: settings,
        products: new Map([
          ["product-1", product({ withInsurance: true, price: "1000000.00" })]
        ])
      })
    );
    // subtotal 1,000,000.00 x 1% = 10,000.00 > minFee 5,000.00.
    expect(result.insurance.selected).toBe(true);
    expect(result.insurance.fee).toBe("10000.00");
  });

  test("insurance required forces selection even without the customer opting in", () => {
    const settings = defaultSettings({
      payment: {
        manualBank: { active: true, accounts: [] },
        manualQris: { active: true, mediaObjectId: null },
        downPayment: { active: false, percent: 50 },
        tax: { active: false, percent: 11 },
        insurance: { active: true, ratePercent: "1.00", minFee: "5000.00" }
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        storeSettings: settings,
        products: new Map([
          [
            "product-1",
            product({ withInsurance: true, insuranceRequired: true })
          ]
        ])
      })
    );
    expect(result.insurance.required).toBe(true);
    expect(result.insurance.selected).toBe(true);
  });

  test("tax is a percent of (subtotal - discount) when active", () => {
    const settings = defaultSettings({
      payment: {
        manualBank: { active: true, accounts: [] },
        manualQris: { active: true, mediaObjectId: null },
        downPayment: { active: false, percent: 50 },
        tax: { active: true, percent: 10 },
        insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        storeSettings: settings,
        voucher: {
          code: "POTONG1K",
          lookup: {
            found: true,
            row: {
              type: "nominal",
              value: "1000.00",
              minOrder: "0.00",
              maxDiscount: null,
              quota: 0,
              usedCount: 0,
              startsAt: new Date("2026-01-01T00:00:00.000Z"),
              endsAt: new Date("2026-12-31T00:00:00.000Z")
            }
          }
        }
      })
    );
    // subtotal 10000.00 - discount 1000.00 = 9000.00 taxable, 10% = 900.00.
    expect(result.tax.amount).toBe("900.00");
    expect(result.total).toBe(
      // 10000 - 1000 (discount) + 0 (shipping) + 0 (insurance) + 900 (tax)
      "9900.00"
    );
  });

  test("down payment is a percent of total and requires every line to allow it", () => {
    const settings = defaultSettings({
      payment: {
        manualBank: { active: true, accounts: [] },
        manualQris: { active: true, mediaObjectId: null },
        downPayment: { active: true, percent: 50 },
        tax: { active: false, percent: 11 },
        insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        storeSettings: settings,
        products: new Map([["product-1", product({ allowDp: true })]])
      })
    );
    expect(result.downPayment.available).toBe(true);
    expect(result.downPayment.amount).toBe("5000.00");
    expect(
      result.paymentMethods.find((m) => m.method === "dp")?.available
    ).toBe(true);
  });

  test("rounding is HALF-UP end to end on odd cent boundaries", () => {
    const settings = defaultSettings({
      payment: {
        manualBank: { active: true, accounts: [] },
        manualQris: { active: true, mediaObjectId: null },
        downPayment: { active: false, percent: 50 },
        tax: { active: true, percent: 11 },
        insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
      }
    });
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext({
        storeSettings: settings,
        products: new Map([
          ["product-1", product({ price: "19.10", discountPercent: 10 })]
        ])
      })
    );
    // 19.10 at 10% off = 17.19 (never 17.189999999999998).
    expect(result.lines[0]!.unitPrice).toBe("17.19");
  });

  test("canCheckout is false whenever any line is not ok", () => {
    const result = quoteCart(
      {
        lines: [
          {
            productId: "product-1",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          },
          {
            productId: "missing",
            variantId: null,
            quantity: 1,
            serviceFormValues: null
          }
        ],
        shipping: null,
        insurance: false
      },
      baseContext()
    );
    expect(result.canCheckout).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// order-request-validation / public-request-validation
// ---------------------------------------------------------------------------

describe("order-request-validation", () => {
  const VALID_BODY = {
    idempotencyKey: "11111111-1111-1111-1111-111111111111",
    customer: { name: "Siti", phone: "081234567890", email: null },
    address: {
      recipientName: "Siti",
      phone: "081234567890",
      provinceCode: "62",
      provinceName: "Kalimantan Tengah",
      cityCode: "62.01",
      cityName: "Kotawaringin Barat",
      districtCode: "62.01.01",
      districtName: "Arut Selatan",
      postalCode: "74111",
      street: "Jl. Mawar 3",
      latitude: null,
      longitude: null,
      notes: null
    },
    lines: [
      {
        productId: "product-1",
        variantId: null,
        quantity: 1,
        serviceFormValues: null
      }
    ],
    shipping: { method: "alternative", serviceId: "borneojek" },
    payment: { method: "manual_qris" },
    voucherCode: null,
    insurance: false,
    notes: null
  };

  test("accepts a fully-formed request", () => {
    const result = validateCreateOrderInput(VALID_BODY);
    expect(result.valid).toBe(true);
  });

  test("address may be omitted for self_pickup", () => {
    const result = validateCreateOrderInput({
      ...VALID_BODY,
      address: null,
      shipping: { method: "self_pickup" }
    });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value.address).toBeNull();
  });

  test("address is required when shipping is not self_pickup", () => {
    const result = validateCreateOrderInput({ ...VALID_BODY, address: null });
    expect(result.valid).toBe(false);
  });

  test("rejects an empty lines array", () => {
    const result = validateCreateOrderInput({ ...VALID_BODY, lines: [] });
    expect(result.valid).toBe(false);
  });

  test("rejects an unknown payment method", () => {
    const result = validateCreateOrderInput({
      ...VALID_BODY,
      payment: { method: "bitcoin" }
    });
    expect(result.valid).toBe(false);
  });
});

describe("public-request-validation", () => {
  test("cart quote request requires a non-empty lines array", () => {
    expect(validateCartQuoteRequest({ lines: [] }).valid).toBe(false);
    expect(
      validateCartQuoteRequest({
        lines: [{ productId: "p1", quantity: 1 }]
      }).valid
    ).toBe(true);
  });

  test("payment confirmation requires phone/method/amount", () => {
    expect(validatePaymentConfirmationInput({}).valid).toBe(false);
    expect(
      validatePaymentConfirmationInput({
        phone: "0812",
        method: "manual_qris",
        amount: "10000.00"
      }).valid
    ).toBe(true);
  });

  test("cancel requires phone", () => {
    expect(validateCancelOrderInput({}).valid).toBe(false);
    expect(validateCancelOrderInput({ phone: "0812" }).valid).toBe(true);
  });

  test("review requires orderCode/phone/productId/rating(1-5)/body", () => {
    expect(validateCreateReviewInput({}).valid).toBe(false);
    expect(
      validateCreateReviewInput({
        orderCode: "BJM-20260916-ABCD",
        phone: "0812",
        productId: "p1",
        rating: 6,
        body: "Great!"
      }).valid
    ).toBe(false);
    expect(
      validateCreateReviewInput({
        orderCode: "BJM-20260916-ABCD",
        phone: "0812",
        productId: "p1",
        rating: 5,
        body: "Great!"
      }).valid
    ).toBe(true);
  });
});
