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
 */
export const PRODUCT_TYPES = [
  "physical",
  "digital",
  "service",
  "subscription"
] as const;

export type ProductType = (typeof PRODUCT_TYPES)[number];

export function isProductType(value: unknown): value is ProductType {
  return (
    typeof value === "string" &&
    (PRODUCT_TYPES as readonly string[]).includes(value)
  );
}
