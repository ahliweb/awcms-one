/**
 * `src/lib/kurir-opsi.ts` — the pure option → display mapping the checkout
 * shipping step uses (issue #109, contract: #106 D4). No DOM/`document`
 * involved: every assertion is about the STRINGS/booleans this module
 * decides, given a `ShippingOption` the CMS (or `scripts/stub-awcms.mjs`)
 * could plausibly send.
 */
import { describe, expect, test } from "bun:test";
import { describeShippingOption, isShippingOptionSelected, shippingOptionKey } from "../src/lib/kurir-opsi";
import type { ShippingOption } from "../src/lib/toko-klien";

const COURIER_OPTION: ShippingOption = {
  method: "courier",
  serviceId: "jne:REG",
  name: "JNE REG",
  etd: "2-3 hari",
  cost: "15000.00",
  available: true
};

const COURIER_UNAVAILABLE: ShippingOption = {
  method: "courier",
  serviceId: null,
  name: "Kurir",
  cost: null,
  etd: null,
  available: false,
  note: "Pilih kecamatan tujuan pada langkah alamat untuk melihat ongkir kurir."
};

const SELF_PICKUP: ShippingOption = {
  method: "self_pickup",
  serviceId: null,
  name: "Ambil di toko",
  cost: "0.00",
  available: true
};

const ALTERNATIVE: ShippingOption = {
  method: "alternative",
  serviceId: "borneojek",
  name: "BORNEOJEK",
  cost: "15000.00",
  available: true
};

describe("kurir-opsi: shippingOptionKey", () => {
  test("is the same {method, serviceId} JSON shape checkout.ts's radio value has always used", () => {
    expect(shippingOptionKey(COURIER_OPTION)).toBe(JSON.stringify({ method: "courier", serviceId: "jne:REG" }));
    expect(shippingOptionKey(SELF_PICKUP)).toBe(JSON.stringify({ method: "self_pickup", serviceId: null }));
  });
});

describe("kurir-opsi: describeShippingOption", () => {
  test("an available courier option shows its etd and formatted price, no note", () => {
    const view = describeShippingOption(COURIER_OPTION);
    expect(view.name).toBe("JNE REG");
    expect(view.etdText).toBe("2-3 hari");
    expect(view.priceText).toContain("15.000");
    expect(view.noteText).toBeNull();
    expect(view.disabled).toBe(false);
  });

  test("the disabled placeholder shows its note, no etd, and 'Segera hadir' for a price", () => {
    const view = describeShippingOption(COURIER_UNAVAILABLE);
    expect(view.disabled).toBe(true);
    expect(view.etdText).toBeNull();
    expect(view.priceText).toBe("Segera hadir");
    expect(view.noteText).toBe("Pilih kecamatan tujuan pada langkah alamat untuk melihat ongkir kurir.");
  });

  test("a courier with a zero-string cost shows 'Gratis' — only an EMPTY cost string is falsy here", () => {
    const view = describeShippingOption({ ...COURIER_OPTION, cost: "" });
    expect(view.priceText).toBe("Gratis");
  });

  test("a non-courier option never carries an etd even when available", () => {
    const view = describeShippingOption(ALTERNATIVE);
    expect(view.etdText).toBeNull();
  });
});

describe("kurir-opsi: isShippingOptionSelected", () => {
  test("null selection matches nothing", () => {
    expect(isShippingOptionSelected(null, COURIER_OPTION)).toBe(false);
  });

  test("self_pickup matches on method alone", () => {
    expect(isShippingOptionSelected({ method: "self_pickup" }, SELF_PICKUP)).toBe(true);
  });

  test("courier requires the SAME serviceId — a different service on the same method is not a match", () => {
    expect(isShippingOptionSelected({ method: "courier", serviceId: "jne:REG" }, COURIER_OPTION)).toBe(true);
    expect(isShippingOptionSelected({ method: "courier", serviceId: "jnt:REG" }, COURIER_OPTION)).toBe(false);
  });

  test("alternative requires the SAME serviceId", () => {
    expect(isShippingOptionSelected({ method: "alternative", serviceId: "borneojek" }, ALTERNATIVE)).toBe(true);
    expect(isShippingOptionSelected({ method: "alternative", serviceId: "other" }, ALTERNATIVE)).toBe(false);
  });

  test("a method mismatch is never a match", () => {
    expect(isShippingOptionSelected({ method: "self_pickup" }, COURIER_OPTION)).toBe(false);
  });
});
