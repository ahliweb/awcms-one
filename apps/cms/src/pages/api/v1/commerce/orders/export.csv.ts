import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  decodeKeysetCursor,
  type KeysetCursor
} from "../../../../../modules/_shared/keyset-pagination";
import { listOrdersForAdmin } from "../../../../../modules/commerce/application/order-directory";
import { COMMERCE_ORDERS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

/**
 * `GET /api/v1/commerce/orders/export.csv` — admin CSV export (Issue #29).
 * Bounded to the most recent 20 pages (up to 2000 orders) rather than an
 * unbounded loop — a tenant with a genuinely larger order history is a
 * later increment's paginated-export problem, not this one's; exporting
 * "everything, no matter how large" inside one request/response cycle is
 * exactly the unbounded-work shape `workClass: "reporting"` exists to keep
 * off the interactive pool.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
  action: "read"
} as const;

const MAX_PAGES = 20;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export const GET = defineTenantRoute({
  workClass: "reporting",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const header = [
      "orderCode",
      "status",
      "paymentStatus",
      "customerName",
      "customerPhoneMasked",
      "total",
      "createdAt"
    ];
    const rows: string[] = [header.join(",")];

    let cursor: KeysetCursor | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await listOrdersForAdmin(tx, tenantId, cursor);
      for (const order of result.items) {
        rows.push(
          [
            order.orderCode,
            order.status,
            order.paymentStatus,
            csvEscape(order.customerName),
            order.customerPhoneMasked,
            order.total,
            order.createdAt
          ].join(",")
        );
      }
      if (!result.nextCursor) break;
      const decoded = decodeKeysetCursor(result.nextCursor);
      if (!decoded) break;
      cursor = decoded;
    }

    return new Response(rows.join("\n"), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="orders.csv"'
      }
    });
  }
});
