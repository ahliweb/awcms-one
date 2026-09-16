/**
 * Flash-sale status union + the derivation rule (Issue #26). Pure — no
 * database, no I/O.
 *
 * `awcms_commerce_flash_sales.status` stores the EDITORIAL state only: the
 * two values a human may ever set via `PATCH` are `draft` (hidden — not yet
 * published) and `scheduled` (published; WHEN it actually runs is entirely a
 * function of `starts_at`/`ends_at`, never a caller's choice). `active` and
 * `ended` are written ONLY by the `commerce:flash-sales:tick` job
 * (`scripts/commerce-flash-sales-tick.ts`), which calls
 * {@link deriveFlashSaleStatus} on every non-draft row and persists the
 * result when it changed, emitting `commerce.flash_sale.{started,ended}` on
 * the transition. The public read model
 * (`GET /api/v1/commerce/flash-sales/active`) calls the SAME function again
 * at request time rather than trusting the stored column — so a sale is
 * never shown late because the tick job has not run in the last few minutes.
 */
export const FLASH_SALE_STATUSES = [
  "draft",
  "scheduled",
  "active",
  "ended"
] as const;

export type FlashSaleStatus = (typeof FLASH_SALE_STATUSES)[number];

export function isFlashSaleStatus(value: unknown): value is FlashSaleStatus {
  return (
    typeof value === "string" &&
    (FLASH_SALE_STATUSES as readonly string[]).includes(value)
  );
}

/** The only two values a caller may ever set directly — see this file's header. */
export const FLASH_SALE_EDITABLE_STATUSES = ["draft", "scheduled"] as const;

export type FlashSaleEditableStatus =
  (typeof FLASH_SALE_EDITABLE_STATUSES)[number];

export function isFlashSaleEditableStatus(
  value: unknown
): value is FlashSaleEditableStatus {
  return (
    typeof value === "string" &&
    (FLASH_SALE_EDITABLE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The status a flash sale ACTUALLY has right now, independent of what the
 * `status` column last recorded. `draft` short-circuits — an unpublished
 * sale is never "active" no matter what the clock says; otherwise the
 * answer is purely a function of `now()` against the window.
 */
export function deriveFlashSaleStatus(
  editorialStatus: FlashSaleStatus,
  startsAt: Date,
  endsAt: Date,
  now: Date
): FlashSaleStatus {
  if (editorialStatus === "draft") return "draft";
  if (now < startsAt) return "scheduled";
  if (now <= endsAt) return "active";
  return "ended";
}
