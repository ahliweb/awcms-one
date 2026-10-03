import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { exportCatalogCsv } from "../../../../../modules/commerce/application/catalog-export";
import { COMMERCE_PRODUCTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "export"
} as const;

/**
 * `GET /api/v1/commerce/products/export.csv` (Issue #291) — the product catalog
 * as RFC 4180 CSV, UTF-8 with a BOM, one row per live product plus an
 * `attr:<key>` column per admin-visible product attribute. Every cell is
 * formula-injection-neutralised (`domain/catalog-csv.ts`). Bounded to
 * {@link MAX_CATALOG_EXPORT_ROWS} rows; `X-AWCMS-Export-Truncated: true` flags a
 * larger catalog. The file re-imports as all-`unchanged`
 * (`POST .../products/import`).
 */
export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: EXPORT_GUARD,
  handler: async ({ tx, tenantId, auth, locals }) => {
    const result = await exportCatalogCsv(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locals.correlationId
    );

    return new Response(result.csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="products.csv"',
        "x-awcms-export-row-count": String(result.rowCount),
        "x-awcms-export-truncated": result.truncated ? "true" : "false",
        "cache-control": "no-store"
      }
    });
  }
});
