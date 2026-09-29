/**
 * Product type union (Issue #4's catalog slice of the legacy
 * `commerce_bj_mart.products` table). Pure — no database, no I/O.
 *
 * Four upstream values carried into this slice unchanged: `physical` and
 * `digital` are the two the storefront already needs to render differently
 * (a digital product has no shipping and surfaces `digitalNote` instead),
 * `service` and `subscription` are kept because the upstream schema already
 * distinguishes them and re-deriving that distinction later, from rows that
 * never recorded it, would not be possible.
 *
 * Issue #266 (IRMbyDUS, FR-COM-001) adds five PRD-required kinds on top of
 * that upstream set, additive only — no existing value changes meaning:
 * `digital_ebook` and `digital_program` are `digital`'s closer analogs (a
 * downloadable file vs. a structured program, both still just surface
 * `digitalNote`/`downloadLink` like plain `digital` does today), `mentoring`
 * and `event` are `service`'s closer analog (both are booked/scheduled the
 * same way `service` is, via the existing `serviceForm` intake), and `bundle`
 * groups other products together (closest, for now, to `physical` — it is
 * catalog-visible and shipped/fulfilled like a regular product). None of
 * these five gets new type-gated fields here: this issue is scoped to the
 * enum extension only. A real digital-delivery linkage (tying a product to
 * protected media/program/mentoring content) is deliberately OUT of scope —
 * see issue #267 (the entitlement module) — so today every new kind reuses
 * the same ungated `digitalNote`/`serviceForm`/`downloadLink` fields the
 * existing kinds already have.
 */
export const PRODUCT_TYPES = [
  "physical",
  "digital",
  "service",
  "subscription",
  "digital_ebook",
  "digital_program",
  "mentoring",
  "bundle",
  "event"
] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export function isProductType(value: unknown): value is ProductType {
  return (
    typeof value === "string" &&
    (PRODUCT_TYPES as readonly string[]).includes(value)
  );
}
