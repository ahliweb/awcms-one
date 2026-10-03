/**
 * Catalog CSV export (Issue #291). Streams nothing: it builds one bounded string
 * (at most {@link MAX_CATALOG_EXPORT_ROWS} rows, equal to the import ceiling so
 * an export always re-imports) from keyset pages of the admin product list.
 *
 * Columns: the core import columns, then `attr:<key>` for every live,
 * product-applicable, admin-visible attribute definition (`sort_order`, `key`).
 * `costPrice` and `downloadLink` are deliberately NOT exported — the import
 * never writes them, and a CSV is the file most likely to leave the building.
 *
 * Every cell goes through `encodeCsvCell` (formula-injection neutralisation,
 * then RFC 4180 quoting); a file written here re-imports as all-`unchanged`.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { attributeAppliesToTarget } from "../domain/attribute-definition";
import { serializeCsv } from "../domain/catalog-csv";
import {
  attributeColumnName,
  CORE_IMPORT_COLUMNS,
  MAX_CATALOG_EXPORT_ROWS
} from "../domain/catalog-import";
import { listAttributeDefinitions } from "./attribute-definition-directory";
import { loadCanonicalProductValues } from "./attribute-value-directory";
import {
  listProductsForAdmin,
  type ProductAdminRecord
} from "./product-directory";

export type CatalogExportResult = {
  csv: string;
  rowCount: number;
  /** `true` when the catalog holds more live products than the export ceiling. */
  truncated: boolean;
};

function coreCell(
  product: ProductAdminRecord,
  column: (typeof CORE_IMPORT_COLUMNS)[number],
  categorySlugById: ReadonlyMap<string, string>
): string {
  switch (column) {
    case "sku":
      return product.sku;
    case "name":
      return product.name;
    case "slug":
      return product.slug;
    case "type":
      return product.type;
    case "status":
      return product.status;
    case "categorySlug":
      return product.categoryId
        ? (categorySlugById.get(product.categoryId) ?? "")
        : "";
    case "price":
      return product.price;
    case "discountPercent":
      return String(product.discountPercent);
    case "stock":
      return String(product.stock);
    case "weightGrams":
      return String(product.weightGrams);
    case "minPurchase":
      return String(product.minPurchase);
    case "description":
      return product.description ?? "";
    case "isFeatured":
      return product.isFeatured ? "true" : "false";
    case "isRecommended":
      return product.isRecommended ? "true" : "false";
  }
}

export async function exportCatalogCsv(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<CatalogExportResult> {
  const definitions = (
    await listAttributeDefinitions(tx, tenantId, { audience: "admin" })
  ).filter((definition) =>
    attributeAppliesToTarget(definition.appliesTo, "product")
  );

  const categoryRows = (await tx`
    SELECT id, slug FROM awcms_commerce_categories
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { id: string; slug: string }[];
  const categorySlugById = new Map(
    categoryRows.map((row) => [row.id, row.slug])
  );

  const header = [
    ...CORE_IMPORT_COLUMNS,
    ...definitions.map((definition) => attributeColumnName(definition.key))
  ];
  const rows: string[][] = [header];

  let cursor: KeysetCursor | null = null;
  let exported = 0;
  let truncated = false;

  for (;;) {
    const page = await listProductsForAdmin(tx, tenantId, cursor, {
      sort: "newest"
    });
    if (page.items.length === 0) break;

    const values = await loadCanonicalProductValues(
      tx,
      tenantId,
      page.items.map((product) => product.id),
      definitions
    );

    for (const product of page.items) {
      if (exported >= MAX_CATALOG_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      const perProduct = values.get(product.id);
      rows.push([
        ...CORE_IMPORT_COLUMNS.map((column) =>
          coreCell(product, column, categorySlugById)
        ),
        ...definitions.map(
          (definition) => perProduct?.get(definition.key) ?? ""
        )
      ]);
      exported += 1;
    }
    if (truncated || !page.nextCursor) break;
    const decoded = decodeKeysetCursor(page.nextCursor);
    if (!decoded) break;
    cursor = decoded;
  }

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: "commerce",
    action: "catalog_export.download",
    resourceType: "catalog_export",
    severity: "warning",
    message: `Catalog exported as CSV: ${exported} products.`,
    attributes: { rowCount: exported, truncated },
    correlationId
  });

  return { csv: serializeCsv(rows), rowCount: exported, truncated };
}
