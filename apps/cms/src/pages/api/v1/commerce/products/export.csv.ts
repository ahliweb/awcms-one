import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { exportCatalogCsv } from "../../../../../modules/commerce/application/catalog-export";
import { authorizeInTransaction } from "../../../../../modules/identity-access/application/access-guard";
import { resolveClientIp } from "../../../../../lib/security/rate-limit";
import {
  COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  COMMERCE_PRODUCTS_ACTIVITY_CODE
} from "../../../../../modules/commerce/domain/commerce-permissions";

const EXPORT_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
  action: "export"
} as const;

/**
 * `GET /api/v1/commerce/products/export.csv` (Issue #291) — the product catalog
 * as RFC 4180 CSV, UTF-8 with a BOM, one row per live product plus an
 * `attr:<key>` column per admin-visible product attribute (only the
 * `visible_public` ones unless the caller also holds `commerce.attributes.read`). Every cell is
 * formula-injection-neutralised (`domain/catalog-csv.ts`). Bounded to
 * {@link MAX_CATALOG_EXPORT_ROWS} rows; `X-AWCMS-Export-Truncated: true` flags a
 * larger catalog. The file re-imports as all-`unchanged`
 * (`POST .../products/import`).
 */
export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: EXPORT_GUARD,
  handler: async ({
    tx,
    tenantId,
    auth,
    locals,
    request,
    clientAddress,
    tokenHash,
    now
  }) => {
    // Non-public attribute values are an `attributes.read` surface: an
    // `export`-only operator gets the `visible_public` columns, nothing more.
    const attributeDecision = await authorizeInTransaction(
      tx,
      tenantId,
      tokenHash,
      now,
      {
        moduleKey: "commerce",
        activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
        action: "read"
      },
      { clientIp: resolveClientIp(request, clientAddress) }
    );
    const result = await exportCatalogCsv(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locals.correlationId,
      attributeDecision.allowed
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
