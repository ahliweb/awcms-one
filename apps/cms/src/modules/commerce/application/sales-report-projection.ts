/**
 * Sales-report projection sinks and hooks — Issue #117 (epic #33 C8, contract
 * #106 / ADR-0017 D7). The DB half of the three `commerce.sales_*`
 * `cursor_table` projections `commerce/module.ts` contributes to the
 * `reporting` engine: every function here takes the ENGINE's transaction
 * (`tx`) and is called by `reporting/application/projection-incremental-
 * worker.ts`, `projection-rebuild.ts`, `projection-reconciliation.ts` and
 * `export-generation.ts` at the points their scalar path already has (see
 * `ProjectionDimensionalSink`/`ProjectionDimensionalContract` in
 * `_shared/module-contract.ts`). No `getDatabaseClient`, no `withTenant`, no
 * cross-module import: this file is deliberately as light as a domain file so
 * that `module.ts` can reference it without dragging a connection pool into
 * every pure registry gate that imports `listModules()`.
 *
 * ## What a batch is
 *
 * The engine SELECTs `awcms_commerce_order_events` rows — cursor-ordered by
 * `created_at`, bounded by `batchLimit`, after the (tenant, projection)
 * advisory lock and the rebuild guard — with the extra columns each sink's
 * `selectColumns` names (`id`, `order_id`, `from_status`, `to_status`). A
 * sink first drops every row `resolveSalesDeltaDirection` maps to `0` (the
 * common case: creation rows, fulfilment steps, never-paid cancellations),
 * loads ONE snapshot per remaining order (header + items + each item's
 * product category — all `commerce`-owned tables, all READ), runs the pure
 * delta functions, and upserts additive deltas by primary key. All inside
 * the engine's transaction, before the cursor advance — a crash rolls the
 * whole pass back, a retry re-applies exactly the same batch once.
 *
 * ## Why the sinks never write a negative row
 *
 * A `-1` event can only ever follow a `+1` event for the same order (the
 * status graph, see `domain/sales-report-deltas.ts`), and events are
 * consumed in `created_at` order, so a subtraction always lands on a row
 * that already holds the matching addition. Rows are never deleted when they
 * reach zero — a day that sold and fully refunded is a fact worth showing as
 * `0`, not an absence — and the `SUM()`-based reads are unaffected either way.
 *
 * ## Known limitation — category is a live join
 *
 * `awcms_commerce_order_items` snapshots the product NAME but not its
 * category, so the by-category attribution reads `products.category_id`
 * at the time the event is PROCESSED. Recategorising a product later does
 * not move its past sales; a REBUILD would re-attribute them under the new
 * category. The reconciliation control totals (quantity and gross, summed
 * over ALL categories) are unaffected, so this shows up as an honest
 * difference between two rebuilds, never as a reconcile mismatch.
 */
import {
  accumulateSalesControlTotals,
  computeSalesByCategoryDeltas,
  computeSalesByProductDeltas,
  computeSalesDailyDelta,
  emptySalesControlTotals,
  formatCentsDelta,
  resolveSalesAttributionDay,
  resolveSalesDeltaDirection,
  type SalesOrderEvent,
  type SalesOrderSnapshot
} from "../domain/sales-report-deltas";
import {
  SALES_DAILY_CONTROL_KEYS,
  SALES_LINE_CONTROL_KEYS
} from "../domain/sales-report-keys";
import { toCents } from "../domain/price-calculation";
import type {
  ProjectionDimensionalContract,
  ProjectionDimensionalSink,
  ProjectionDimensionalTotals
} from "../../_shared/module-contract";

/** Columns every sink asks the engine to SELECT beyond the cursor column. */
export const SALES_EVENT_SELECT_COLUMNS = [
  "id",
  "order_id",
  "from_status",
  "to_status"
] as const;

type EventRow = {
  id: string;
  order_id: string;
  from_status: string | null;
  to_status: string;
  created_at: Date | string;
};

function toEvent(row: Record<string, unknown>): SalesOrderEvent {
  const raw = row as EventRow;
  return {
    orderId: raw.order_id,
    fromStatus: raw.from_status ?? null,
    toStatus: raw.to_status,
    createdAt:
      raw.created_at instanceof Date
        ? raw.created_at
        : new Date(raw.created_at as string)
  };
}

type OrderHeaderRow = {
  id: string;
  paid_at: Date | string | null;
  subtotal: string;
  discount: string;
  voucher_discount: string;
  shipping_cost: string;
  total: string;
};

type OrderItemRow = {
  order_id: string;
  product_id: string;
  name: string;
  quantity: number;
  line_total: string;
  category_id: string | null;
  category_name: string | null;
};

/**
 * One snapshot per order id — header + live items + the item's product
 * category (LEFT JOINs: a purged product or category simply reads as
 * uncategorised rather than dropping the line). Orders are never
 * soft-deleted and items are immutable once written (sql/913's header), so
 * the same snapshot is read whether the event is processed live or during a
 * rebuild months later.
 */
export async function loadSalesOrderSnapshots(
  tx: Bun.SQL,
  tenantId: string,
  orderIds: readonly string[]
): Promise<Map<string, SalesOrderSnapshot>> {
  const distinct = [...new Set(orderIds)];
  if (distinct.length === 0) return new Map();

  const headers = (await tx`
    SELECT id, paid_at, subtotal, discount, voucher_discount, shipping_cost, total
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND id = ANY(${tx.array(distinct, "uuid")}::uuid[])
  `) as OrderHeaderRow[];

  const items = (await tx`
    SELECT oi.order_id, oi.product_id, oi.name, oi.quantity, oi.line_total,
      p.category_id, c.name AS category_name
    FROM awcms_commerce_order_items oi
    LEFT JOIN awcms_commerce_products p
      ON p.id = oi.product_id AND p.tenant_id = oi.tenant_id
    LEFT JOIN awcms_commerce_categories c
      ON c.id = p.category_id AND c.tenant_id = p.tenant_id
    WHERE oi.tenant_id = ${tenantId}
      AND oi.deleted_at IS NULL
      AND oi.order_id = ANY(${tx.array(distinct, "uuid")}::uuid[])
    ORDER BY oi.created_at ASC, oi.id ASC
  `) as OrderItemRow[];

  const snapshots = new Map<string, SalesOrderSnapshot>();
  for (const header of headers) {
    snapshots.set(header.id, {
      orderId: header.id,
      paidAt:
        header.paid_at === null
          ? null
          : header.paid_at instanceof Date
            ? header.paid_at
            : new Date(header.paid_at),
      subtotal: String(header.subtotal),
      discount: String(header.discount),
      voucherDiscount: String(header.voucher_discount),
      shippingCost: String(header.shipping_cost),
      total: String(header.total),
      items: []
    });
  }
  for (const item of items) {
    const snapshot = snapshots.get(item.order_id);
    if (!snapshot) continue;
    (snapshot.items as SalesOrderSnapshot["items"][number][]).push({
      productId: item.product_id,
      productName: item.name,
      quantity: Number(item.quantity),
      lineTotal: String(item.line_total),
      categoryId: item.category_id ?? null,
      categoryName: item.category_name ?? null
    });
  }
  return snapshots;
}

type EffectiveEvent = {
  event: SalesOrderEvent;
  direction: 1 | -1;
  order: SalesOrderSnapshot;
  day: string;
};

/** Filters a batch down to the events that change anything and pairs each with its order snapshot and attribution day. An event whose order header cannot be read (impossible under the FK, defensive) is skipped. */
async function resolveEffectiveEvents(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<EffectiveEvent[]> {
  const candidates: { event: SalesOrderEvent; direction: 1 | -1 }[] = [];
  for (const row of rows) {
    const event = toEvent(row);
    const direction = resolveSalesDeltaDirection(event);
    if (direction !== 0) candidates.push({ event, direction });
  }
  if (candidates.length === 0) return [];

  const snapshots = await loadSalesOrderSnapshots(
    tx,
    tenantId,
    candidates.map((candidate) => candidate.event.orderId)
  );

  const effective: EffectiveEvent[] = [];
  for (const candidate of candidates) {
    const order = snapshots.get(candidate.event.orderId);
    if (!order) continue;
    effective.push({
      ...candidate,
      order,
      day: resolveSalesAttributionDay(order, candidate.event)
    });
  }
  return effective;
}

// ---------------------------------------------------------------------------
// commerce.sales_daily
// ---------------------------------------------------------------------------

export async function applySalesDailyBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const { order, direction, day } of await resolveEffectiveEvents(
    tx,
    tenantId,
    rows
  )) {
    const delta = computeSalesDailyDelta(order, direction, day);
    if (!delta) continue;
    await tx`
      INSERT INTO awcms_commerce_sales_daily
        (tenant_id, day, orders_paid, gross, discount, shipping, net)
      VALUES (
        ${tenantId}, ${delta.day}::date, ${delta.ordersPaid},
        ${formatCentsDelta(delta.grossCents)}::numeric,
        ${formatCentsDelta(delta.discountCents)}::numeric,
        ${formatCentsDelta(delta.shippingCents)}::numeric,
        ${formatCentsDelta(delta.netCents)}::numeric
      )
      ON CONFLICT (tenant_id, day) DO UPDATE SET
        orders_paid = awcms_commerce_sales_daily.orders_paid + EXCLUDED.orders_paid,
        gross = awcms_commerce_sales_daily.gross + EXCLUDED.gross,
        discount = awcms_commerce_sales_daily.discount + EXCLUDED.discount,
        shipping = awcms_commerce_sales_daily.shipping + EXCLUDED.shipping,
        net = awcms_commerce_sales_daily.net + EXCLUDED.net,
        updated_at = now()
    `;
  }
}

export const SALES_DAILY_SINK: ProjectionDimensionalSink = {
  selectColumns: SALES_EVENT_SELECT_COLUMNS,
  applyBatch: applySalesDailyBatch
};

// ---------------------------------------------------------------------------
// commerce.sales_by_product
// ---------------------------------------------------------------------------

export async function applySalesByProductBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const { order, direction, day } of await resolveEffectiveEvents(
    tx,
    tenantId,
    rows
  )) {
    for (const line of computeSalesByProductDeltas(order, direction, day)) {
      await tx`
        INSERT INTO awcms_commerce_sales_by_product
          (tenant_id, day, product_id, product_name, qty, gross)
        VALUES (
          ${tenantId}, ${line.day}::date, ${line.productId}, ${line.productName},
          ${line.qty}, ${formatCentsDelta(line.grossCents)}::numeric
        )
        ON CONFLICT (tenant_id, day, product_id) DO UPDATE SET
          qty = awcms_commerce_sales_by_product.qty + EXCLUDED.qty,
          gross = awcms_commerce_sales_by_product.gross + EXCLUDED.gross,
          product_name = EXCLUDED.product_name,
          updated_at = now()
      `;
    }
  }
}

export const SALES_BY_PRODUCT_SINK: ProjectionDimensionalSink = {
  selectColumns: SALES_EVENT_SELECT_COLUMNS,
  applyBatch: applySalesByProductBatch
};

// ---------------------------------------------------------------------------
// commerce.sales_by_category
// ---------------------------------------------------------------------------

export async function applySalesByCategoryBatch(
  tx: Bun.SQL,
  tenantId: string,
  rows: readonly Record<string, unknown>[]
): Promise<void> {
  for (const { order, direction, day } of await resolveEffectiveEvents(
    tx,
    tenantId,
    rows
  )) {
    for (const line of computeSalesByCategoryDeltas(order, direction, day)) {
      await tx`
        INSERT INTO awcms_commerce_sales_by_category
          (tenant_id, day, category_id, category_name, qty, gross)
        VALUES (
          ${tenantId}, ${line.day}::date, ${line.categoryId}, ${line.categoryName},
          ${line.qty}, ${formatCentsDelta(line.grossCents)}::numeric
        )
        ON CONFLICT (tenant_id, day, category_id) DO UPDATE SET
          qty = awcms_commerce_sales_by_category.qty + EXCLUDED.qty,
          gross = awcms_commerce_sales_by_category.gross + EXCLUDED.gross,
          category_name = EXCLUDED.category_name,
          updated_at = now()
      `;
    }
  }
}

export const SALES_BY_CATEGORY_SINK: ProjectionDimensionalSink = {
  selectColumns: SALES_EVENT_SELECT_COLUMNS,
  applyBatch: applySalesByCategoryBatch
};

// ---------------------------------------------------------------------------
// Control totals (reconciliation) — source side, shared by all three
// ---------------------------------------------------------------------------

/** Bounded page size of the reconciliation's full source walk — a control READ, so it may take several pages, but each page is a bounded statement. */
const CONTROL_TOTAL_PAGE_SIZE = 2000;

/**
 * Walks the tenant's ENTIRE event stream (cursor-ordered, paged) through the
 * same three delta functions the sinks apply and sums the result — the
 * reconciliation's source control total. Unbounded by design, like the
 * engine's own `COUNT(*)` control totals; read-only; runs inside the
 * reconcile route's own transaction.
 */
export async function computeSalesSourceControlTotals(
  tx: Bun.SQL,
  tenantId: string
) {
  const totals = emptySalesControlTotals();
  let afterCreatedAt: Date | null = null;
  let afterId: string | null = null;

  for (;;) {
    const page = (await tx`
      SELECT id, order_id, from_status, to_status, created_at
      FROM awcms_commerce_order_events
      WHERE tenant_id = ${tenantId}
        AND (
          ${afterCreatedAt}::timestamptz IS NULL
          OR (created_at, id) > (${afterCreatedAt}::timestamptz, ${afterId}::uuid)
        )
      ORDER BY created_at ASC, id ASC
      LIMIT ${CONTROL_TOTAL_PAGE_SIZE}
    `) as EventRow[];
    if (page.length === 0) break;

    const effective = await resolveEffectiveEvents(
      tx,
      tenantId,
      page as unknown as Record<string, unknown>[]
    );
    for (const { event, order } of effective) {
      accumulateSalesControlTotals(totals, event, order);
    }

    const last = page[page.length - 1]!;
    afterCreatedAt =
      last.created_at instanceof Date
        ? last.created_at
        : new Date(last.created_at);
    afterId = last.id;
    if (page.length < CONTROL_TOTAL_PAGE_SIZE) break;
  }

  return totals;
}

function centsToNumber(cents: bigint): number {
  return Number(cents);
}

function sumToCents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(toCents(String(value)));
}

// ---------------------------------------------------------------------------
// Descriptor-level dimensional contracts
// ---------------------------------------------------------------------------

export const SALES_DAILY_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_sales_daily WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT COALESCE(SUM(orders_paid), 0) AS orders_paid,
        COALESCE(SUM(gross), 0) AS gross, COALESCE(SUM(discount), 0) AS discount,
        COALESCE(SUM(shipping), 0) AS shipping, COALESCE(SUM(net), 0) AS net
      FROM awcms_commerce_sales_daily
      WHERE tenant_id = ${tenantId}
    `) as Record<string, unknown>[];
    const row = rows[0] ?? {};
    return {
      [SALES_DAILY_CONTROL_KEYS.ordersPaid]: Number(row.orders_paid ?? 0),
      [SALES_DAILY_CONTROL_KEYS.grossCents]: sumToCents(row.gross),
      [SALES_DAILY_CONTROL_KEYS.discountCents]: sumToCents(row.discount),
      [SALES_DAILY_CONTROL_KEYS.shippingCents]: sumToCents(row.shipping),
      [SALES_DAILY_CONTROL_KEYS.netCents]: sumToCents(row.net)
    };
  },
  computeSourceTotals: async (tx, tenantId) => {
    const totals = await computeSalesSourceControlTotals(tx, tenantId);
    return {
      [SALES_DAILY_CONTROL_KEYS.ordersPaid]: totals.ordersPaid,
      [SALES_DAILY_CONTROL_KEYS.grossCents]: centsToNumber(totals.grossCents),
      [SALES_DAILY_CONTROL_KEYS.discountCents]: centsToNumber(
        totals.discountCents
      ),
      [SALES_DAILY_CONTROL_KEYS.shippingCents]: centsToNumber(
        totals.shippingCents
      ),
      [SALES_DAILY_CONTROL_KEYS.netCents]: centsToNumber(totals.netCents)
    };
  },
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, orders_paid, gross, discount, shipping, net
      FROM awcms_commerce_sales_daily
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC
    `) as Record<string, unknown>[];
    return {
      columns: ["day", "orders_paid", "gross", "discount", "shipping", "net"],
      rows
    };
  }
};

type LineSumRow = { qty: unknown; gross: unknown };

function toLineTotals(
  rows: readonly LineSumRow[]
): ProjectionDimensionalTotals {
  const row = rows[0];
  return {
    [SALES_LINE_CONTROL_KEYS.qty]: Number(row?.qty ?? 0),
    [SALES_LINE_CONTROL_KEYS.grossCents]: sumToCents(row?.gross)
  };
}

/** Source side of the by-product AND by-category control totals — identical by construction: both tables partition the same line items, so their sums must equal the same walk. */
async function computeLineSourceTotals(
  tx: Bun.SQL,
  tenantId: string
): Promise<ProjectionDimensionalTotals> {
  const totals = await computeSalesSourceControlTotals(tx, tenantId);
  return {
    [SALES_LINE_CONTROL_KEYS.qty]: totals.itemQty,
    [SALES_LINE_CONTROL_KEYS.grossCents]: centsToNumber(totals.itemGrossCents)
  };
}

export const SALES_BY_PRODUCT_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_sales_by_product WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) =>
    toLineTotals(
      (await tx`
        SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(gross), 0) AS gross
        FROM awcms_commerce_sales_by_product
        WHERE tenant_id = ${tenantId}
      `) as LineSumRow[]
    ),
  computeSourceTotals: computeLineSourceTotals,
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, product_id, product_name, qty, gross
      FROM awcms_commerce_sales_by_product
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, product_name ASC, product_id ASC
    `) as Record<string, unknown>[];
    return {
      columns: ["day", "product_id", "product_name", "qty", "gross"],
      rows
    };
  }
};

export const SALES_BY_CATEGORY_DIMENSIONAL: ProjectionDimensionalContract = {
  resetForTenant: async (tx, tenantId) => {
    await tx`DELETE FROM awcms_commerce_sales_by_category WHERE tenant_id = ${tenantId}`;
  },
  readProjectionTotals: async (tx, tenantId) =>
    toLineTotals(
      (await tx`
        SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(gross), 0) AS gross
        FROM awcms_commerce_sales_by_category
        WHERE tenant_id = ${tenantId}
      `) as LineSumRow[]
    ),
  computeSourceTotals: computeLineSourceTotals,
  exportRows: async (tx, tenantId) => {
    const rows = (await tx`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, category_id, category_name, qty, gross
      FROM awcms_commerce_sales_by_category
      WHERE tenant_id = ${tenantId}
      ORDER BY day ASC, category_name ASC, category_id ASC
    `) as Record<string, unknown>[];
    return {
      columns: ["day", "category_id", "category_name", "qty", "gross"],
      rows
    };
  }
};
