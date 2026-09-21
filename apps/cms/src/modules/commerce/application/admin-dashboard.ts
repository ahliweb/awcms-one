/**
 * Read model behind `/admin/commerce` (Issue #171 — the commerce admin
 * dashboard re-composed on the new admin primitives, `.admin-stat-card` /
 * `.admin-status-pill` / `.admin-timeline`). Every figure here is a real
 * query over an existing `commerce` table or the existing sales-report
 * projection (Issue #117) — nothing is fabricated, and a widget with no
 * backing data (e.g. a conversion-rate stat with no funnel projection) is
 * simply not returned rather than invented.
 *
 * "Today" is computed against the database's own `now()`/`current_date` so a
 * tenant's dashboard always agrees with the timestamps its own rows carry,
 * never the admin server process's local clock.
 */
import { normalizeMoney } from "../domain/price-calculation";
import {
  listSalesDaily,
  type SalesDailyRecord
} from "./sales-report-directory";
import { listReviewsForAdmin } from "./review-directory";
import { listConversationsForAdmin } from "./conversation-directory";
import {
  listAffiliateCommissionsForAdmin,
  isAffiliateProgramEnabled
} from "./affiliate-directory";
import { listOrdersForAdmin, type OrderAdminSummary } from "./order-directory";
import { fetchCommerceFeatures } from "./commerce-feature-gate";

/** A product at or below this stock count is "low stock" — a plain, documented threshold, not a per-tenant setting (none exists today). */
export const LOW_STOCK_THRESHOLD = 5;

export type DashboardTodaySummary = {
  ordersToday: number;
  revenueToday: string;
};

export type DashboardActionItem = {
  kind: "confirmations" | "reviews" | "inbox" | "affiliate_commissions";
  count: number;
  href: string;
};

export type DashboardSummary = {
  today: DashboardTodaySummary;
  lowStockCount: number;
  revenueDaily: SalesDailyRecord[];
  actionItems: DashboardActionItem[];
  recentOrders: OrderAdminSummary[];
};

async function fetchTodaySummary(
  tx: Bun.SQL,
  tenantId: string
): Promise<DashboardTodaySummary> {
  const rows = (await tx`
    SELECT count(*)::int AS orders_count,
           coalesce(sum(total), 0) AS revenue
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND created_at >= date_trunc('day', now())
      AND created_at < date_trunc('day', now()) + interval '1 day'
  `) as { orders_count: number; revenue: string }[];

  const row = rows[0];
  return {
    ordersToday: row ? Number(row.orders_count) : 0,
    revenueToday: normalizeMoney(row ? String(row.revenue) : "0")
  };
}

async function countLowStockProducts(
  tx: Bun.SQL,
  tenantId: string
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS low_stock_count
    FROM awcms_commerce_products
    WHERE tenant_id = ${tenantId}
      AND deleted_at IS NULL
      AND status = 'active'
      AND stock <= ${LOW_STOCK_THRESHOLD}
  `) as { low_stock_count: number }[];
  return rows[0] ? Number(rows[0].low_stock_count) : 0;
}

async function countPendingPaymentConfirmations(
  tx: Bun.SQL,
  tenantId: string
): Promise<number> {
  const rows = (await tx`
    SELECT count(*)::int AS pending_count
    FROM awcms_commerce_payment_confirmations pc
    JOIN awcms_commerce_orders o ON o.id = pc.order_id AND o.tenant_id = pc.tenant_id
    WHERE pc.tenant_id = ${tenantId}
      AND pc.status = 'pending'
      AND o.deleted_at IS NULL
  `) as { pending_count: number }[];
  return rows[0] ? Number(rows[0].pending_count) : 0;
}

/** Inclusive 14-day `YYYY-MM-DD` range ending today (server clock, UTC — same convention `sales-report-query.ts` validates against). */
export function last14DayRange(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  return { from, to };
}

export type DashboardPermissions = {
  canReadReviews: boolean;
  canReadInbox: boolean;
  canReadAffiliates: boolean;
};

/**
 * Everything the dashboard renders, gathered in one transaction. `perms`
 * mirrors the `can()` checks `loadAdminScreen`'s caller already has to make
 * for the page's own sub-widgets — a "perlu tindakan" entry is omitted
 * entirely (not shown disabled) when the viewer cannot read that resource,
 * per the capability-gated-controls rule (doc 14 §13).
 */
export async function fetchDashboardSummary(
  tx: Bun.SQL,
  tenantId: string,
  perms: DashboardPermissions
): Promise<DashboardSummary> {
  const now = new Date();

  const today = await fetchTodaySummary(tx, tenantId);
  const lowStockCount = await countLowStockProducts(tx, tenantId);
  const revenueDaily = await listSalesDaily(tx, tenantId, last14DayRange(now));

  const actionItems: DashboardActionItem[] = [];

  const pendingConfirmations = await countPendingPaymentConfirmations(
    tx,
    tenantId
  );
  if (pendingConfirmations > 0) {
    actionItems.push({
      kind: "confirmations",
      count: pendingConfirmations,
      href: "/admin/commerce-orders"
    });
  }

  if (perms.canReadReviews) {
    const pendingReviews = await listReviewsForAdmin(
      tx,
      tenantId,
      null,
      "pending"
    );
    if (pendingReviews.items.length > 0) {
      actionItems.push({
        kind: "reviews",
        count: pendingReviews.items.length,
        href: "/admin/commerce-reviews"
      });
    }
  }

  const features = await fetchCommerceFeatures(tx, tenantId);

  if (perms.canReadInbox && features.inbox) {
    const unreadThreads = await listConversationsForAdmin(
      tx,
      tenantId,
      { unreadForStore: true },
      null,
      50
    );
    if (unreadThreads.items.length > 0) {
      actionItems.push({
        kind: "inbox",
        count: unreadThreads.items.length,
        href: "/admin/commerce-inbox"
      });
    }
  }

  if (
    perms.canReadAffiliates &&
    (await isAffiliateProgramEnabled(tx, tenantId))
  ) {
    const pendingCommissions = await listAffiliateCommissionsForAdmin(
      tx,
      tenantId,
      null,
      { status: "pending" }
    );
    if (pendingCommissions.items.length > 0) {
      actionItems.push({
        kind: "affiliate_commissions",
        count: pendingCommissions.items.length,
        href: "/admin/commerce-affiliates"
      });
    }
  }

  const recent = await listOrdersForAdmin(tx, tenantId, null);

  return {
    today,
    lowStockCount,
    revenueDaily,
    actionItems,
    recentOrders: recent.items.slice(0, 10)
  };
}
