/**
 * Product lifecycle status — union, legal transition table, and the checked
 * transition function. Pure — no database, no I/O. Shape copied from
 * `blog-content/domain/post-status.ts` (status union + allowed-transitions
 * map + a same-state-is-a-no-op checker), renamed `LEGAL_TRANSITIONS` per
 * Issue #4's file list.
 */
export const PRODUCT_STATUSES = [
  "draft",
  "active",
  "inactive",
  "archived"
] as const;

export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export function isProductStatus(value: unknown): value is ProductStatus {
  return (
    typeof value === "string" &&
    (PRODUCT_STATUSES as readonly string[]).includes(value)
  );
}

export type ValidationError = { field: string; message: string };

/**
 * Allowed forward/back transitions. A product is authored `draft`, switched
 * `active` to sell, `inactive` to pull from sale without losing the record
 * (out of stock, seasonal), and `archived` to retire it for good; only
 * `draft` re-opens an archived product — it goes back through review rather
 * than straight back on sale. Same shape as blog_content's
 * `ALLOWED_STATUS_TRANSITIONS` (archived -> draft only), because the
 * "retiring is not final until re-authored" rule is the same rule.
 */
export const LEGAL_TRANSITIONS: Record<
  ProductStatus,
  readonly ProductStatus[]
> = {
  draft: ["active", "archived"],
  active: ["inactive", "archived"],
  inactive: ["active", "archived"],
  archived: ["draft"]
};

/**
 * Checks `current -> next` against {@link LEGAL_TRANSITIONS} and returns the
 * next status on success. `current === next` is always legal — a PATCH that
 * repeats the product's own status is a no-op, not an error — so a caller
 * does not have to special-case "no change" before calling this.
 *
 * Returns the same `{valid, errors}` envelope `product-validation.ts` uses,
 * so a route can fold a rejected transition into the same 400 response shape
 * as any other validation failure.
 */
export function applyProductStatus(
  current: ProductStatus,
  next: ProductStatus
):
  | { valid: true; value: ProductStatus }
  | { valid: false; errors: ValidationError[] } {
  if (current === next) {
    return { valid: true, value: next };
  }

  const legalNextStates = LEGAL_TRANSITIONS[current];

  if (!legalNextStates.includes(next)) {
    return {
      valid: false,
      errors: [
        {
          field: "status",
          message:
            `Cannot transition status from "${current}" to "${next}". ` +
            (legalNextStates.length > 0
              ? `Legal transitions from "${current}": ${legalNextStates.join(", ")}.`
              : `"${current}" is terminal.`)
        }
      ]
    };
  }

  return { valid: true, value: next };
}
