/**
 * Product size-chart type union (Issue #23, catalog-parity increment).
 * Pure — no database, no I/O.
 *
 * BjekMart's `size_chart_type` column: `none` (no chart — the default for
 * most catalog rows), `image` (a single reference image, `size_chart_media_id`
 * carries the media object), or `table` (a structured measurement table,
 * `size_chart_details` carries the rows as `jsonb`). `product-validation.ts`
 * enforces the cross-field rule (`image` requires `size_chart_media_id`,
 * `table` requires `size_chart_details`, `none` requires neither) — this file
 * only names the three values.
 */
export const SIZE_CHART_TYPES = ["none", "image", "table"] as const;

export type SizeChartType = (typeof SIZE_CHART_TYPES)[number];

export function isSizeChartType(value: unknown): value is SizeChartType {
  return (
    typeof value === "string" &&
    (SIZE_CHART_TYPES as readonly string[]).includes(value)
  );
}

export type SizeChartFields = {
  sizeChartType: SizeChartType;
  sizeChartMediaId: string | null;
  sizeChartDetails: unknown | null;
};

export type SizeChartValidationError = { field: string; message: string };

/**
 * Enforces the cross-field rule the `sql/156` `CHECK` constraint mirrors:
 * `image` requires `sizeChartMediaId`, `table` requires `sizeChartDetails`,
 * `none` requires neither. Called from BOTH `product-validation.ts`'s create
 * path (against the request's already-defaulted values) and
 * `product-directory.ts`'s `updateProduct` (against the MERGED next state,
 * existing values patched with whatever the request changed) — the same
 * "check the next state before writing" rule `applyProductStatus` follows.
 *
 * Deliberately CLEARS the irrelevant field rather than merely allowing it to
 * be inconsistent: switching `sizeChartType` from `"table"` to `"image"`
 * without an explicit `sizeChartDetails: null` in the same request would
 * otherwise leave a stale table behind a chart the UI now renders as a single
 * image — a leftover value nothing would ever surface as wrong, because
 * nothing reads `sizeChartDetails` once `sizeChartType !== "table"`.
 */
export function reconcileSizeChart(
  fields: SizeChartFields
):
  | { valid: true; value: SizeChartFields }
  | { valid: false; errors: SizeChartValidationError[] } {
  if (fields.sizeChartType === "none") {
    return {
      valid: true,
      value: {
        sizeChartType: "none",
        sizeChartMediaId: null,
        sizeChartDetails: null
      }
    };
  }

  if (fields.sizeChartType === "image") {
    if (!fields.sizeChartMediaId) {
      return {
        valid: false,
        errors: [
          {
            field: "sizeChartMediaId",
            message:
              'sizeChartMediaId is required when sizeChartType is "image".'
          }
        ]
      };
    }
    return {
      valid: true,
      value: {
        sizeChartType: "image",
        sizeChartMediaId: fields.sizeChartMediaId,
        sizeChartDetails: null
      }
    };
  }

  // "table"
  if (
    fields.sizeChartDetails === null ||
    fields.sizeChartDetails === undefined
  ) {
    return {
      valid: false,
      errors: [
        {
          field: "sizeChartDetails",
          message: 'sizeChartDetails is required when sizeChartType is "table".'
        }
      ]
    };
  }

  return {
    valid: true,
    value: {
      sizeChartType: "table",
      sizeChartMediaId: null,
      sizeChartDetails: fields.sizeChartDetails
    }
  };
}
