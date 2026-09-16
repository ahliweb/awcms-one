/**
 * `GET /api/v1/commerce/products?sort=` union (Issue #23). Pure — no
 * database, no I/O; `application/product-directory.ts` is what turns a value
 * here into an `ORDER BY` clause.
 *
 * `newest` (the increment-1 default, `created_at DESC, id DESC`) stays first
 * so an existing caller that never sends `sort` keeps its current ordering.
 * `price_asc`/`price_desc` order by the stored `price` column, never
 * `finalPrice` — the computed, discounted price would make the ordering shift
 * every time `discountPercent` changes on an unrelated row, which is not a
 * catalog-browse behaviour any caller has asked for. `name` is a plain
 * alphabetical sort for a merchant who wants an A-Z catalog view.
 */
export const PRODUCT_SORTS = [
  "newest",
  "price_asc",
  "price_desc",
  "name"
] as const;

export type ProductSort = (typeof PRODUCT_SORTS)[number];

export function isProductSort(value: unknown): value is ProductSort {
  return (
    typeof value === "string" &&
    (PRODUCT_SORTS as readonly string[]).includes(value)
  );
}
