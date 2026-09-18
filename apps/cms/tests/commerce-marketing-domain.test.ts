/**
 * `commerce` marketing-surface domain tests (Issue #26, epic #21 in
 * awcms-one). Pure — no database, no network, no import that carries either.
 * Covers `domain/voucher-arithmetic.ts`, `domain/voucher-validation.ts`,
 * `domain/flash-sale-status.ts`, `domain/flash-sale-validation.ts`,
 * `domain/slider-validation.ts`, `domain/testimonial-validation.ts`,
 * `domain/popup-validation.ts` and `domain/store-settings-validation.ts`,
 * plus the one application-layer projection that is a security boundary
 * (`store-settings-directory.ts`'s `toPublicRecord`, exercised with a fake
 * media port so it stays a unit test).
 *
 * Every money assertion below is on a STRING: the whole point of the
 * arithmetic under test is that `"19.10"` at 10 % is `"1.91"`, never
 * `1.9100000000000001` — see ADR-0003 in awcms-one and `sql/901`'s header.
 */
import { describe, expect, test } from "bun:test";

import { evaluateVoucher } from "../src/modules/commerce/domain/voucher-arithmetic";
import { normalizeMoney } from "../src/modules/commerce/domain/price-calculation";
import {
  isVoucherType,
  reconcileVoucherFields,
  validateCreateVoucherInput,
  validateUpdateVoucherInput,
  VOUCHER_TYPES
} from "../src/modules/commerce/domain/voucher-validation";
import {
  deriveFlashSaleStatus,
  FLASH_SALE_STATUSES,
  isFlashSaleEditableStatus,
  isFlashSaleStatus
} from "../src/modules/commerce/domain/flash-sale-status";
import {
  validateCreateFlashSaleInput,
  validateCreateFlashSaleProductInput,
  validateUpdateFlashSaleInput
} from "../src/modules/commerce/domain/flash-sale-validation";
import {
  validateCreateSliderInput,
  validateUpdateSliderInput
} from "../src/modules/commerce/domain/slider-validation";
import {
  validateCreateTestimonialInput,
  validateUpdateTestimonialInput
} from "../src/modules/commerce/domain/testimonial-validation";
import {
  isPopupFrequency,
  POPUP_FREQUENCIES,
  validateCreatePopupInput
} from "../src/modules/commerce/domain/popup-validation";
import {
  STORE_SETTINGS_SCHEMA_VERSION,
  validateStoreSettingsInput
} from "../src/modules/commerce/domain/store-settings-validation";
import { toPublicRecord } from "../src/modules/commerce/application/store-settings-directory";
import type { MediaLibraryPort } from "../src/modules/_shared/ports/media-library-port";

const T0 = new Date("2026-09-16T10:00:00.000Z");
const BEFORE = new Date("2026-09-16T09:00:00.000Z");
const AFTER = new Date("2026-09-16T11:00:00.000Z");

const UUID = "11111111-1111-4111-8111-111111111111";

function voucher(
  overrides: Partial<Parameters<typeof evaluateVoucher>[0]> = {}
): Parameters<typeof evaluateVoucher>[0] {
  return {
    type: "percentage",
    value: "10.00",
    minOrder: "0.00",
    maxDiscount: null,
    quota: 0,
    usedCount: 0,
    startsAt: BEFORE,
    endsAt: AFTER,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Money shape on the wire
// ---------------------------------------------------------------------------

describe("normalizeMoney", () => {
  test("re-renders what Bun.SQL's binary numeric decoder hands back as the canonical two-decimal string", () => {
    // Found while seeding Issue #26: a stored 0.00 read through a
    // parameterised query arrives as "0"; every other value keeps its scale.
    expect(normalizeMoney("0")).toBe("0.00");
    expect(normalizeMoney("0.00")).toBe("0.00");
    expect(normalizeMoney("10.00")).toBe("10.00");
    expect(normalizeMoney("10")).toBe("10.00");
    expect(normalizeMoney("10.5")).toBe("10.50");
    expect(normalizeMoney("1234567.89")).toBe("1234567.89");
  });

  test("null passes through — an absent cap is not a cap of zero", () => {
    expect(normalizeMoney(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Voucher arithmetic
// ---------------------------------------------------------------------------

describe("evaluateVoucher", () => {
  test("percentage: exact cents, half-up, as a string", () => {
    const result = evaluateVoucher(voucher(), "19.10", "0.00", T0);
    expect(result).toEqual({
      valid: true,
      discount: "1.91",
      freeShipping: false
    });
  });

  test("percentage rounds half-up at the cent boundary", () => {
    // 12.5 % of 100.10 = 12.5125 → 12.51; 12.5 % of 100.20 = 12.525 → 12.53
    expect(
      evaluateVoucher(voucher({ value: "12.50" }), "100.10", "0.00", T0)
    ).toEqual({
      valid: true,
      discount: "12.51",
      freeShipping: false
    });
    expect(
      evaluateVoucher(voucher({ value: "12.50" }), "100.20", "0.00", T0)
    ).toEqual({
      valid: true,
      discount: "12.53",
      freeShipping: false
    });
  });

  test("percentage is capped by maxDiscount", () => {
    const result = evaluateVoucher(
      voucher({ value: "10.00", maxDiscount: "20000.00" }),
      "500000.00",
      "0.00",
      T0
    );
    expect(result).toEqual({
      valid: true,
      discount: "20000.00",
      freeShipping: false
    });
  });

  test("percentage below the cap is not touched by it", () => {
    const result = evaluateVoucher(
      voucher({ value: "10.00", maxDiscount: "20000.00" }),
      "120000.00",
      "0.00",
      T0
    );
    expect(result).toEqual({
      valid: true,
      discount: "12000.00",
      freeShipping: false
    });
  });

  test("nominal: the value, verbatim", () => {
    const result = evaluateVoucher(
      voucher({ type: "nominal", value: "15000.00" }),
      "120000.00",
      "0.00",
      T0
    );
    expect(result).toEqual({
      valid: true,
      discount: "15000.00",
      freeShipping: false
    });
  });

  test("free_shipping: no discount amount, the flag instead", () => {
    const result = evaluateVoucher(
      voucher({ type: "free_shipping", value: "0.00" }),
      "120000.00",
      "15000.00",
      T0
    );
    expect(result).toEqual({
      valid: true,
      discount: "0.00",
      freeShipping: true
    });
  });

  test("min_order: rejected when the subtotal is below it, accepted at exactly it", () => {
    expect(
      evaluateVoucher(voucher({ minOrder: "50000.00" }), "49999.99", "0.00", T0)
    ).toEqual({ valid: false, reason: "min_order" });
    expect(
      evaluateVoucher(voucher({ minOrder: "50000.00" }), "50000.00", "0.00", T0)
        .valid
    ).toBe(true);
  });

  test("quota: exhausted when usedCount reaches quota; 0 means unlimited", () => {
    expect(
      evaluateVoucher(voucher({ quota: 5, usedCount: 5 }), "100.00", "0.00", T0)
    ).toEqual({ valid: false, reason: "quota_exhausted" });
    expect(
      evaluateVoucher(voucher({ quota: 5, usedCount: 4 }), "100.00", "0.00", T0)
        .valid
    ).toBe(true);
    expect(
      evaluateVoucher(
        voucher({ quota: 0, usedCount: 100000 }),
        "100.00",
        "0.00",
        T0
      ).valid
    ).toBe(true);
  });

  test("window: not_started before startsAt, expired after endsAt, inclusive at both ends", () => {
    expect(
      evaluateVoucher(
        voucher(),
        "100.00",
        "0.00",
        new Date(BEFORE.getTime() - 1)
      )
    ).toEqual({
      valid: false,
      reason: "not_started"
    });
    expect(evaluateVoucher(voucher(), "100.00", "0.00", BEFORE).valid).toBe(
      true
    );
    expect(evaluateVoucher(voucher(), "100.00", "0.00", AFTER).valid).toBe(
      true
    );
    expect(
      evaluateVoucher(
        voucher(),
        "100.00",
        "0.00",
        new Date(AFTER.getTime() + 1)
      )
    ).toEqual({
      valid: false,
      reason: "expired"
    });
  });

  test("the checks are ordered window → quota → min order, so the reason names the FIRST failure", () => {
    // A voucher that is expired AND over quota AND under min order reports
    // expired: that is the reason a customer can do nothing about, and the
    // one the storefront should show first.
    const result = evaluateVoucher(
      voucher({ quota: 1, usedCount: 1, minOrder: "1000000.00" }),
      "1.00",
      "0.00",
      new Date(AFTER.getTime() + 1)
    );
    expect(result).toEqual({ valid: false, reason: "expired" });
  });
});

// ---------------------------------------------------------------------------
// Voucher validation
// ---------------------------------------------------------------------------

describe("voucher validation", () => {
  test("VOUCHER_TYPES is the closed set the storefront switches over", () => {
    expect([...VOUCHER_TYPES].sort()).toEqual([
      "free_shipping",
      "nominal",
      "percentage"
    ]);
    expect(isVoucherType("percentage")).toBe(true);
    expect(isVoucherType("bogo")).toBe(false);
    expect(isVoucherType(1)).toBe(false);
  });

  test("reconcileVoucherFields normalises the per-type shape", () => {
    expect(
      reconcileVoucherFields({
        type: "free_shipping",
        value: "99.00",
        maxDiscount: "5.00"
      })
    ).toEqual({
      valid: true,
      value: { type: "free_shipping", value: "0.00", maxDiscount: null }
    });
    expect(
      reconcileVoucherFields({
        type: "nominal",
        value: "15000.00",
        maxDiscount: "5.00"
      })
    ).toEqual({
      valid: true,
      value: { type: "nominal", value: "15000.00", maxDiscount: null }
    });
    expect(
      reconcileVoucherFields({
        type: "percentage",
        value: "10.00",
        maxDiscount: "20000.00"
      })
    ).toEqual({
      valid: true,
      value: { type: "percentage", value: "10.00", maxDiscount: "20000.00" }
    });
  });

  test("a percentage above 100 is refused", () => {
    const result = reconcileVoucherFields({
      type: "percentage",
      value: "150.00",
      maxDiscount: null
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.errors[0]?.field).toBe("value");
  });

  test("create: a well-formed input round-trips", () => {
    const result = validateCreateVoucherInput({
      code: "HEMAT10",
      name: "Hemat 10%",
      type: "percentage",
      value: "10.00",
      minOrder: "50000.00",
      maxDiscount: "20000.00",
      quota: 100,
      isPublic: true,
      startsAt: BEFORE.toISOString(),
      endsAt: AFTER.toISOString()
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.code).toBe("HEMAT10");
      expect(result.value.type).toBe("percentage");
      expect(result.value.isPublic).toBe(true);
    }
  });

  test("create: rejects a missing code, an unknown type, a float value, and endsAt before startsAt", () => {
    const result = validateCreateVoucherInput({
      name: "x",
      type: "bogo",
      value: 10,
      startsAt: AFTER.toISOString(),
      endsAt: BEFORE.toISOString()
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("code");
      expect(fields).toContain("type");
      expect(fields).toContain("value");
      expect(
        fields.some((field) => field === "endsAt" || field === "startsAt")
      ).toBe(true);
    }
  });

  test("update: an empty body is invalid, an unknown status is refused", () => {
    expect(validateUpdateVoucherInput({}).valid).toBe(false);
    expect(validateUpdateVoucherInput({ status: "paused" }).valid).toBe(false);
    expect(validateUpdateVoucherInput({ status: "inactive" }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Flash sales
// ---------------------------------------------------------------------------

describe("deriveFlashSaleStatus", () => {
  const starts = BEFORE;
  const ends = AFTER;

  test("draft is editorial and never derived away", () => {
    expect(deriveFlashSaleStatus("draft", starts, ends, T0)).toBe("draft");
    expect(
      deriveFlashSaleStatus("draft", starts, ends, new Date(ends.getTime() + 1))
    ).toBe("draft");
  });

  test("a non-draft sale is scheduled before startsAt, active inside the window, ended after", () => {
    for (const editorial of ["scheduled", "active", "ended"] as const) {
      expect(
        deriveFlashSaleStatus(
          editorial,
          starts,
          ends,
          new Date(starts.getTime() - 1)
        )
      ).toBe("scheduled");
      expect(deriveFlashSaleStatus(editorial, starts, ends, starts)).toBe(
        "active"
      );
      expect(deriveFlashSaleStatus(editorial, starts, ends, ends)).toBe(
        "active"
      );
      expect(
        deriveFlashSaleStatus(
          editorial,
          starts,
          ends,
          new Date(ends.getTime() + 1)
        )
      ).toBe("ended");
    }
  });

  test("the status vocabularies are closed", () => {
    expect([...FLASH_SALE_STATUSES]).toEqual([
      "draft",
      "scheduled",
      "active",
      "ended"
    ]);
    expect(isFlashSaleStatus("ended")).toBe(true);
    expect(isFlashSaleStatus("paused")).toBe(false);
    expect(isFlashSaleEditableStatus("draft")).toBe(true);
    expect(isFlashSaleEditableStatus("scheduled")).toBe(true);
    expect(isFlashSaleEditableStatus("active")).toBe(false);
  });
});

describe("flash-sale validation", () => {
  test("create: a well-formed input round-trips, defaulting to draft", () => {
    const result = validateCreateFlashSaleInput({
      name: "Flash Sale Jumat",
      slug: "flash-sale-jumat",
      startsAt: BEFORE.toISOString(),
      endsAt: AFTER.toISOString()
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.status).toBe("draft");
      expect(result.value.startsAt.toISOString()).toBe(BEFORE.toISOString());
    }
  });

  test("create: rejects a bad slug, an inverted window, and a non-editable status", () => {
    const result = validateCreateFlashSaleInput({
      name: "x",
      slug: "Not A Slug",
      startsAt: AFTER.toISOString(),
      endsAt: BEFORE.toISOString(),
      status: "active"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("slug");
      expect(fields).toContain("status");
      expect(
        fields.some((field) => field === "endsAt" || field === "startsAt")
      ).toBe(true);
    }
  });

  test("update: an empty body is invalid", () => {
    expect(validateUpdateFlashSaleInput({}).valid).toBe(false);
    expect(validateUpdateFlashSaleInput({ name: "Renamed" }).valid).toBe(true);
  });

  test("product row: sale price is a money string, quota a non-negative integer", () => {
    expect(
      validateCreateFlashSaleProductInput({
        productId: UUID,
        salePrice: "8500.00",
        quota: 50
      }).valid
    ).toBe(true);
    const bad = validateCreateFlashSaleProductInput({
      productId: "not-a-uuid",
      salePrice: 8500,
      quota: -1
    });
    expect(bad.valid).toBe(false);
    if (!bad.valid) {
      const fields = bad.errors.map((error) => error.field);
      expect(fields).toContain("productId");
      expect(fields).toContain("salePrice");
      expect(fields).toContain("quota");
    }
  });
});

// ---------------------------------------------------------------------------
// Sliders, testimonials, popups
// ---------------------------------------------------------------------------

describe("slider validation", () => {
  test("requires a title and a media object id; window is optional but must be ordered", () => {
    expect(
      validateCreateSliderInput({ title: "Promo", mediaObjectId: UUID }).valid
    ).toBe(true);
    const bad = validateCreateSliderInput({
      title: "",
      mediaObjectId: "x",
      startsAt: AFTER.toISOString(),
      endsAt: BEFORE.toISOString()
    });
    expect(bad.valid).toBe(false);
    if (!bad.valid) {
      const fields = bad.errors.map((error) => error.field);
      expect(fields).toContain("title");
      expect(fields).toContain("mediaObjectId");
    }
  });

  test("update: an empty body is invalid", () => {
    expect(validateUpdateSliderInput({}).valid).toBe(false);
    expect(validateUpdateSliderInput({ isActive: false }).valid).toBe(true);
  });
});

describe("testimonial validation", () => {
  test("rating is an integer 1..5", () => {
    expect(
      validateCreateTestimonialInput({
        authorName: "Siti",
        body: "Mantap",
        rating: 5
      }).valid
    ).toBe(true);
    for (const rating of [0, 6, 4.5, "5"]) {
      const result = validateCreateTestimonialInput({
        authorName: "Siti",
        body: "x",
        rating
      });
      expect(result.valid).toBe(false);
      if (!result.valid)
        expect(result.errors.map((error) => error.field)).toContain("rating");
    }
  });

  test("update: an empty body is invalid", () => {
    expect(validateUpdateTestimonialInput({}).valid).toBe(false);
  });
});

describe("popup validation", () => {
  test("frequency is a closed vocabulary with a default", () => {
    expect([...POPUP_FREQUENCIES]).toEqual([
      "once_per_session",
      "once_per_day",
      "always"
    ]);
    expect(isPopupFrequency("always")).toBe(true);
    expect(isPopupFrequency("hourly")).toBe(false);
    const result = validateCreatePopupInput({ title: "Promo Spesial" });
    expect(result.valid).toBe(true);
    if (result.valid)
      expect(isPopupFrequency(result.value.frequency)).toBe(true);
  });

  test("rejects a missing title and an unknown frequency", () => {
    const result = validateCreatePopupInput({ frequency: "hourly" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("title");
      expect(fields).toContain("frequency");
    }
  });
});

// ---------------------------------------------------------------------------
// Store settings
// ---------------------------------------------------------------------------

const LIVE_SETTINGS = {
  storeName: "BjekMart",
  tagline: "Belanja online hemat, mudah, dan terpercaya di BjekMart",
  address: "Jl. Ahmad Wongso RT 19 Kelurahan Madurejo",
  phone: "0851-2868-8885",
  whatsapp: "6285128688885",
  email: "borneojekpangkalanbun@gmail.com",
  faqs: [{ question: "Bisa COD?", answer: "Bisa, untuk area Pangkalan Bun." }],
  social: { facebook: null, instagram: "https://instagram.com/bjekmart" },
  customerLevels: [
    {
      level: 1,
      name: "Pelanggan Umum",
      type: "percentage",
      value: "0.00",
      active: true
    },
    {
      level: 2,
      name: "Reseller",
      type: "percentage",
      value: "5.00",
      active: true
    },
    {
      level: 3,
      name: "Agen",
      type: "percentage",
      value: "10.00",
      active: true
    },
    {
      level: 4,
      name: "Distributor",
      type: "nominal",
      value: "15000.00",
      active: true
    }
  ],
  shipping: {
    alternativeServices: [
      { id: "borneojek", name: "BORNEOJEK", cost: "15000.00" }
    ],
    selfPickup: true,
    courierEnabled: false,
    pinpointEnabled: false,
    freeShipping: {
      active: false,
      minOrder: "50000.00",
      maxDiscount: "20000.00"
    },
    originCityName: "Kabupaten Kotawaringin Barat",
    originSubdistrictName: "Arut Selatan"
  },
  payment: {
    manualBank: {
      active: true,
      accounts: [
        {
          bankName: "BCA",
          accountNumber: "1234567890",
          accountHolder: "PT Borneojek"
        }
      ]
    },
    manualQris: { active: true, mediaObjectId: UUID },
    downPayment: { active: false, percent: 50 },
    tax: { active: false, percent: 11 },
    insurance: { active: false, ratePercent: "0.20", minFee: "500.00" }
  },
  promoSection: { active: false, items: [] },
  meta: {
    home: { title: null, description: null },
    contact: { title: null, description: null }
  }
};

describe("validateStoreSettingsInput", () => {
  test("the live BjekMart settings block validates and is stamped with the schema version", () => {
    const result = validateStoreSettingsInput(LIVE_SETTINGS);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value.schemaVersion).toBe(STORE_SETTINGS_SCHEMA_VERSION);
      expect(result.value.storeName).toBe("BjekMart");
      expect(result.value.payment.manualBank.accounts[0]?.accountNumber).toBe(
        "1234567890"
      );
      expect(result.value.social.instagram).toBe(
        "https://instagram.com/bjekmart"
      );
    }
  });

  test("an unknown key is rejected at every level it is checked — a typo must not be silently kept as dead configuration", () => {
    for (const body of [
      { ...LIVE_SETTINGS, storeNmae: "x" },
      { ...LIVE_SETTINGS, social: { ...LIVE_SETTINGS.social, twitter: "x" } },
      {
        ...LIVE_SETTINGS,
        promoSection: { active: true, items: [], enabled: true }
      },
      { ...LIVE_SETTINGS, meta: { ...LIVE_SETTINGS.meta, about: {} } }
    ]) {
      expect(validateStoreSettingsInput(body).valid).toBe(false);
    }
  });

  test("storeName is required", () => {
    const result = validateStoreSettingsInput({
      ...LIVE_SETTINGS,
      storeName: ""
    });
    expect(result.valid).toBe(false);
    if (!result.valid)
      expect(result.errors.map((error) => error.field)).toContain("storeName");
  });

  test("a media id must be a uuid", () => {
    const result = validateStoreSettingsInput({
      ...LIVE_SETTINGS,
      logoMediaObjectId: "logo.png"
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.map((error) => error.field)).toContain(
        "logoMediaObjectId"
      );
    }
  });
});

describe("toPublicRecord — the public subset is a security boundary", () => {
  // A fake port: resolves the QRIS/logo id to a URL the way the real one
  // would, so the test proves the public record uses the port for the logo
  // and NOT for the QRIS payload.
  const fakePort: MediaLibraryPort = {
    isMediaLibraryEnabled: async () => true,
    isMediaReferenceSafe: async () => true,
    resolveMediaReferences: async (
      _tx: Bun.SQL,
      _tenantId: string,
      ids: readonly string[]
    ) =>
      new Map(
        ids.map((id: string) => [
          id,
          {
            publicUrl: `https://media.example.test/${id}.png`,
            altText: null,
            width: 512,
            height: 512
          }
        ])
      )
  } as unknown as MediaLibraryPort;

  test("never carries an account number, account holder, or QRIS media reference", async () => {
    const validated = validateStoreSettingsInput({
      ...LIVE_SETTINGS,
      logoMediaObjectId: UUID
    });
    expect(validated.valid).toBe(true);
    if (!validated.valid) return;

    const record = await toPublicRecord(
      null as unknown as Bun.SQL,
      "tenant",
      validated.value,
      fakePort
    );

    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("1234567890");
    expect(serialised).not.toContain("PT Borneojek");
    expect(serialised).not.toContain("accountNumber");
    expect(serialised).not.toContain("accountHolder");
    expect(serialised).not.toContain("mediaObjectId");

    // What IS there is the availability and the bank NAME — enough for a
    // checkout to say "transfer to BCA" and nothing more until an order exists.
    expect(record.payment.manualBank).toEqual({
      active: true,
      banks: [{ bankName: "BCA" }]
    });
    expect(record.payment.manualQris).toEqual({ active: true });

    // The logo is resolved through the port; the QRIS image is not exposed at all.
    expect(record.logo?.url).toBe(`https://media.example.test/${UUID}.png`);
    expect(record.logo?.alt).toBe("BjekMart");
    expect(record.favicon).toBeNull();

    // Customer levels drop the discount rule — a shopper sees the names, not
    // the margins behind them.
    expect(record.customerLevels).toEqual([
      { level: 1, name: "Pelanggan Umum" },
      { level: 2, name: "Reseller" },
      { level: 3, name: "Agen" },
      { level: 4, name: "Distributor" }
    ]);
  });
});
