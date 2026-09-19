/**
 * Read side of the sales reports (Issue #117) — the three
 * `GET /api/v1/reports/commerce/*` routes and `admin/commerce-reports.astro`
 * read the projection tables through these functions and nothing else. Every
 * function only READs `awcms_commerce_sales_*` (maintained by
 * `sales-report-projection.ts` under the `reporting` engine); money is
 * re-rendered through `normalizeMoney` so the wire always carries the
 * canonical two-decimal string (ADR-0003, and the `Bun.SQL` numeric scale
 * quirk `price-calculation.ts` documents).
 *
 * `from`/`to` are inclusive `YYYY-MM-DD` projection days, already validated
 * by `domain/sales-report-query.ts`; the caller passes them as-is and the
 * `::date` casts keep the comparison a plain date comparison.
 */
import { normalizeMoney } from "../domain/price-calculation";
import { SALES_REPORT_UNCATEGORISED_ID } from "../domain/sales-report-deltas";
import type { SalesReportRange } from "../domain/sales-report-query";

export type SalesDailyRecord = {
  day: string;
  ordersPaid: number;
  gross: string;
  discount: string;
  shipping: string;
  net: string;
};

export type SalesByProductRecord = {
  productId: string;
  productName: string;
  qty: number;
  gross: string;
};

export type SalesByCategoryRecord = {
  /** `null` for the uncategorised bucket (`SALES_REPORT_UNCATEGORISED_ID` in the table). */
  categoryId: string | null;
  categoryName: string;
  qty: number;
  gross: string;
};

export async function listSalesDaily(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<SalesDailyRecord[]> {
  const rows = (await tx`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, orders_paid, gross, discount, shipping, net
    FROM awcms_commerce_sales_daily
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    ORDER BY day ASC
  `) as {
    day: string;
    orders_paid: number;
    gross: string;
    discount: string;
    shipping: string;
    net: string;
  }[];

  return rows.map((row) => ({
    day: row.day,
    ordersPaid: Number(row.orders_paid),
    gross: normalizeMoney(String(row.gross)),
    discount: normalizeMoney(String(row.discount)),
    shipping: normalizeMoney(String(row.shipping)),
    net: normalizeMoney(String(row.net))
  }));
}

/** Grouped over the range, best-selling (by gross) first; the name shown is the most recent snapshot in the range. */
export async function listSalesByProduct(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange,
  limit: number
): Promise<SalesByProductRecord[]> {
  const rows = (await tx`
    SELECT product_id,
      (ARRAY_AGG(product_name ORDER BY day DESC))[1] AS product_name,
      SUM(qty) AS qty, SUM(gross) AS gross
    FROM awcms_commerce_sales_by_product
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    GROUP BY product_id
    ORDER BY SUM(gross) DESC, SUM(qty) DESC, product_id ASC
    LIMIT ${limit}
  `) as {
    product_id: string;
    product_name: string;
    qty: string | number;
    gross: string;
  }[];

  return rows.map((row) => ({
    productId: row.product_id,
    productName: row.product_name,
    qty: Number(row.qty),
    gross: normalizeMoney(String(row.gross))
  }));
}

export async function listSalesByCategory(
  tx: Bun.SQL,
  tenantId: string,
  range: SalesReportRange
): Promise<SalesByCategoryRecord[]> {
  const rows = (await tx`
    SELECT category_id,
      (ARRAY_AGG(category_name ORDER BY day DESC))[1] AS category_name,
      SUM(qty) AS qty, SUM(gross) AS gross
    FROM awcms_commerce_sales_by_category
    WHERE tenant_id = ${tenantId}
      AND day >= ${range.from}::date AND day <= ${range.to}::date
    GROUP BY category_id
    ORDER BY SUM(gross) DESC, SUM(qty) DESC, category_id ASC
  `) as {
    category_id: string;
    category_name: string;
    qty: string | number;
    gross: string;
  }[];

  return rows.map((row) => ({
    categoryId:
      row.category_id === SALES_REPORT_UNCATEGORISED_ID
        ? null
        : row.category_id,
    categoryName: row.category_name,
    qty: Number(row.qty),
    gross: normalizeMoney(String(row.gross))
  }));
}
