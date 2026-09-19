/**
 * Pure option → display mapping for the checkout shipping step (issue #109,
 * contract: #106 D4) — extracted out of `src/scripts/checkout.ts`'s
 * `renderShippingOptions` so the DOM-building code stays a thin loop over
 * data this module already decided, and so this decision has its own unit
 * test (`tests/kurir-opsi.test.ts`) with no DOM/`document` involved at all.
 *
 * A courier row from the CMS (or this repo's own `scripts/stub-awcms.mjs`)
 * is either:
 *   - one of several real, priced services (`available:true`, its own
 *     `serviceId`/`name`/`etd`/`cost`), one radio per service; or
 *   - the SINGLE disabled placeholder (`available:false`, `serviceId:null`,
 *     `cost:null`, a `note` explaining why — courier disabled, no
 *     destination chosen yet, or the provider could not price this
 *     destination).
 *
 * This module never formats money itself — `formatPrice` (`./harga.ts`)
 * stays the one place a price string becomes display text, per that file's
 * own "no client-side arithmetic" rule. It only decides WHICH strings go
 * where, and whether a row is disabled.
 */
import { formatPrice } from "./harga";
import type { ShippingOption, ShippingSelection } from "./toko-klien";

export type ShippingOptionView = {
  /** A stable DOM id suffix and the radio's `value` payload — `JSON.stringify({method, serviceId})`. */
  key: string;
  /** The option's own display name, e.g. "JNE REG" or "Ambil di toko". */
  name: string;
  /** The courier's estimated delivery time, e.g. "2-3 hari" — `null` when the option carries none (non-courier, or the disabled placeholder). */
  etdText: string | null;
  /** The formatted price, or `"Gratis"` for a free option — never a raw number. */
  priceText: string;
  /** Visible help text for a disabled row (the placeholder's own `note`) — `null` for every available option. */
  noteText: string | null;
  disabled: boolean;
};

/** Builds the checkbox/radio `value` this app has always used — `{method, serviceId}`, JSON-encoded, read back by `checkout.ts`'s own `change` handler. */
export function shippingOptionKey(option: Pick<ShippingOption, "method" | "serviceId">): string {
  return JSON.stringify({ method: option.method, serviceId: option.serviceId });
}

/** The one place `ShippingOption` becomes text for a checkout radio row — see this file's own header for what each field means. */
export function describeShippingOption(option: ShippingOption): ShippingOptionView {
  return {
    key: shippingOptionKey(option),
    name: option.name,
    etdText: option.available ? option.etd ?? null : null,
    priceText: option.available ? (option.cost ? formatPrice(option.cost) : "Gratis") : "Segera hadir",
    noteText: option.available ? null : option.note ?? null,
    disabled: !option.available
  };
}

/**
 * Whether `option` is the one the shopper currently has selected — used to
 * restore the checked radio after a re-quote rebuilds the whole list from
 * scratch (the same "restore, don't lose, the shopper's choice" rule
 * `renderPaymentOptions` already follows for the payment radios). A
 * `self_pickup` selection matches any `self_pickup` option (there is only
 * ever one); `alternative`/`courier` additionally require the SAME
 * `serviceId` — a plain `method` match is not enough once a courier method
 * can carry several priced services at once.
 */
export function isShippingOptionSelected(selection: ShippingSelection, option: ShippingOption): boolean {
  if (!selection || selection.method !== option.method) return false;
  if (selection.method === "self_pickup") return true;
  return selection.serviceId === option.serviceId;
}
