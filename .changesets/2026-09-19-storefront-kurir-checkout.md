---
bump: minor
type: structure
impact: public
---

# Checkout prices real courier rates per destination (issue #109, S1 of #33)

The checkout shipping step's courier row stops being a permanent "segera"
placeholder. Coded against the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106)
(D4) names, so wiring `apps/cms`'s own RajaOngkir adapter in later needs no
storefront change.

- `cart/quote` sends `destination: {districtCode}` as soon as the address
  step's kecamatan `<select>` has a value, and re-quotes on every district
  change (including a saved-address autofill). Courier options render one
  radio per real, priced service (name, ETD, price) — or the same single
  disabled placeholder as before, now carrying a visible `note` explaining
  which of three reasons applies (courier off, no destination yet, the
  provider could not price this destination).
- An `aria-live="polite"` status line announces "Menghitung ongkir…" while a
  quote is in flight and a short failure message otherwise; every disabled
  row keeps a real `<label>` and its note as visible help text
  (`aria-describedby`), not a tooltip.
- `apps/storefront/scripts/stub-awcms.mjs` prices real JNE/J&T/SiCepat
  services from a new fixture (`shipping-rates.json`, three district codes ×
  three couriers × two services, per-kilogram pricing) and re-validates the
  chosen courier service against a fresh quote at order time, answering
  `409 CART_CHANGED` on any mismatch — the same treatment a stock/price
  change already gets.
- A pure `describeShippingOption`/`isShippingOptionSelected` module
  (`apps/storefront/src/lib/kurir-opsi.ts`) now owns the option → label
  decision, unit-tested with no DOM.

- No client-side arithmetic was added — every price shown still comes from
  the quote, formatted only through the existing `formatPrice`.
