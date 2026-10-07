/**
 * Record shapes and reads for returns, return lines, refund legs and their
 * compensations (Issue #287, ADR-0033). Reads only - every write lives in
 * `return-directory.ts` / `refund-settlement.ts` / `refund-execution.ts`.
 *
 * Money crosses the wire as a `numeric(14,2)` STRING (ADR-0003), normalised
 * with `normalizeMoney` here so `0.00` never decodes as `"0"`. A refund leg
 * never carries the provider's reference or refund id out of the module - they
 * are an operator-support detail kept in the row, not part of the API.
 */
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { normalizeMoney } from "../domain/price-calculation";
import type {
  RefundDestination,
  RefundSettledVia,
  RefundStatus,
  ReturnDisposition,
  ReturnKind,
  ReturnReason,
  ReturnStatus
} from "../domain/returns";

export type RefundRecord = {
  id: string;
  returnId: string;
  orderId: string;
  /** The succeeded payment this leg sends money back along. */
  allocationId: string;
  tenderType: string;
  amount: string;
  destination: RefundDestination;
  status: RefundStatus;
  settledVia: RefundSettledVia | null;
  attempts: number;
  failureCode: string | null;
  /** The payment-ledger reversal row that books it (`null` until settled). */
  reversalAllocationId: string | null;
  storeCreditAccountId: string | null;
  /** The reason an authorised operator gave for an offline settlement. */
  offlineReason: string | null;
  createdAt: string;
  settledAt: string | null;
};

export type ReturnLineRecord = {
  id: string;
  orderItemId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  reason: ReturnReason;
  disposition: ReturnDisposition;
  /** Units that went back into sellable stock. */
  stockEffect: number;
  goodsGross: string;
  discountShare: string;
  refundAmount: string;
  note: string | null;
};

export type RefundCompensationRecord = {
  refundId: string;
  kind:
    | "loyalty_reversal"
    | "affiliate_adjustment"
    | "store_credit_issue"
    | "store_credit_load";
  points: number | null;
  amount: string | null;
  refId: string | null;
  createdAt: string;
};

export type ReturnRecord = {
  id: string;
  orderId: string;
  kind: ReturnKind;
  status: ReturnStatus;
  note: string | null;
  goodsGross: string;
  discountShare: string;
  shippingRefund: string;
  /** The tax charged on the returned units, refunded with them (Issue #323). */
  taxRefund: string;
  refundTotal: string;
  exchangeOrderId: string | null;
  createdAt: string;
  completedAt: string | null;
  lines: ReturnLineRecord[];
  refunds: RefundRecord[];
  compensations: RefundCompensationRecord[];
};

type ReturnRow = {
  id: string;
  order_id: string;
  kind: string;
  status: string;
  note: string | null;
  goods_gross: string;
  discount_share: string;
  shipping_refund: string;
  tax_refund: string;
  refund_total: string;
  exchange_order_id: string | null;
  created_at: Date;
  completed_at: Date | null;
};

type LineRow = {
  id: string;
  return_id: string;
  order_item_id: string;
  product_id: string;
  variant_id: string | null;
  quantity: number;
  reason: string;
  disposition: string;
  stock_effect: number;
  goods_gross: string;
  discount_share: string;
  refund_amount: string;
  note: string | null;
};

export type RefundRow = {
  id: string;
  return_id: string;
  order_id: string;
  allocation_id: string;
  tender_type: string;
  amount: string;
  destination: string;
  status: string;
  settled_via: string | null;
  attempts: number;
  failure_code: string | null;
  reversal_allocation_id: string | null;
  store_credit_account_id: string | null;
  offline_reason: string | null;
  created_at: Date;
  settled_at: Date | null;
};

type CompensationRow = {
  refund_id: string;
  kind: string;
  points: string | number | bigint | null;
  amount: string | null;
  ref_id: string | null;
  created_at: Date;
};

export const RETURN_COLUMNS = `id, order_id, kind, status, note, goods_gross, discount_share,
  shipping_refund, tax_refund, refund_total, exchange_order_id, created_at, completed_at`;

export const REFUND_COLUMNS = `id, return_id, order_id, allocation_id, tender_type, amount, destination,
  status, settled_via, attempts, failure_code, reversal_allocation_id, store_credit_account_id,
  offline_reason, created_at, settled_at`;

const LINE_COLUMNS = `id, return_id, order_item_id, product_id, variant_id, quantity, reason,
  disposition, stock_effect, goods_gross, discount_share, refund_amount, note`;

export function toRefundRecord(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    returnId: row.return_id,
    orderId: row.order_id,
    allocationId: row.allocation_id,
    tenderType: row.tender_type,
    amount: normalizeMoney(String(row.amount)),
    destination: row.destination as RefundDestination,
    status: row.status as RefundStatus,
    settledVia: row.settled_via as RefundSettledVia | null,
    attempts: Number(row.attempts),
    failureCode: row.failure_code,
    reversalAllocationId: row.reversal_allocation_id,
    storeCreditAccountId: row.store_credit_account_id,
    offlineReason: row.offline_reason,
    createdAt: row.created_at.toISOString(),
    settledAt: row.settled_at ? row.settled_at.toISOString() : null
  };
}

function toLineRecord(row: LineRow): ReturnLineRecord {
  return {
    id: row.id,
    orderItemId: row.order_item_id,
    productId: row.product_id,
    variantId: row.variant_id,
    quantity: Number(row.quantity),
    reason: row.reason as ReturnReason,
    disposition: row.disposition as ReturnDisposition,
    stockEffect: Number(row.stock_effect),
    goodsGross: normalizeMoney(String(row.goods_gross)),
    discountShare: normalizeMoney(String(row.discount_share)),
    refundAmount: normalizeMoney(String(row.refund_amount)),
    note: row.note
  };
}

function toCompensationRecord(row: CompensationRow): RefundCompensationRecord {
  return {
    refundId: row.refund_id,
    kind: row.kind as RefundCompensationRecord["kind"],
    points: row.points === null ? null : Number(row.points),
    amount: row.amount === null ? null : normalizeMoney(String(row.amount)),
    refId: row.ref_id,
    createdAt: row.created_at.toISOString()
  };
}

function toReturnRecord(
  row: ReturnRow,
  lines: LineRow[],
  refunds: RefundRow[],
  compensations: CompensationRow[]
): ReturnRecord {
  return {
    id: row.id,
    orderId: row.order_id,
    kind: row.kind as ReturnKind,
    status: row.status as ReturnStatus,
    note: row.note,
    goodsGross: normalizeMoney(String(row.goods_gross)),
    discountShare: normalizeMoney(String(row.discount_share)),
    shippingRefund: normalizeMoney(String(row.shipping_refund)),
    taxRefund: normalizeMoney(String(row.tax_refund)),
    refundTotal: normalizeMoney(String(row.refund_total)),
    exchangeOrderId: row.exchange_order_id,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    lines: lines.map(toLineRecord),
    refunds: refunds.map(toRefundRecord),
    compensations: compensations.map(toCompensationRecord)
  };
}

/** Hydrates returns with their lines, refund legs and compensations in three batched queries. */
async function hydrate(
  tx: Bun.SQL,
  tenantId: string,
  rows: ReturnRow[]
): Promise<ReturnRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const lines = (await tx`
    SELECT ${tx.unsafe(LINE_COLUMNS)}
    FROM awcms_commerce_return_lines
    WHERE tenant_id = ${tenantId} AND return_id = ANY(${tx.array(ids, "uuid")}::uuid[])
    ORDER BY created_at ASC, id ASC
  `) as LineRow[];
  const refunds = (await tx`
    SELECT ${tx.unsafe(REFUND_COLUMNS)}
    FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND return_id = ANY(${tx.array(ids, "uuid")}::uuid[])
    ORDER BY created_at ASC, source_key ASC, id ASC
  `) as RefundRow[];
  const refundIds = refunds.map((row) => row.id);
  const compensations =
    refundIds.length === 0
      ? []
      : ((await tx`
          SELECT refund_id, kind, points, amount, ref_id, created_at
          FROM awcms_commerce_refund_compensations
          WHERE tenant_id = ${tenantId}
            AND refund_id = ANY(${tx.array(refundIds, "uuid")}::uuid[])
          ORDER BY created_at ASC, id ASC
        `) as CompensationRow[]);

  return rows.map((row) => {
    const refundsOfReturn = refunds.filter((r) => r.return_id === row.id);
    const refundIdsOfReturn = new Set(refundsOfReturn.map((r) => r.id));
    return toReturnRecord(
      row,
      lines.filter((l) => l.return_id === row.id),
      refundsOfReturn,
      compensations.filter((c) => refundIdsOfReturn.has(c.refund_id))
    );
  });
}

/** One return, tenant-scoped. `null` for an unknown or other-tenant id - one answer for both. */
export async function fetchReturn(
  tx: Bun.SQL,
  tenantId: string,
  returnId: string
): Promise<ReturnRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(RETURN_COLUMNS)}
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND id = ${returnId}
  `) as ReturnRow[];
  return (await hydrate(tx, tenantId, rows))[0] ?? null;
}

/** Every return of one order, oldest first. Empty for an unknown order. */
export async function listReturnsForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<ReturnRecord[]> {
  const rows = (await tx`
    SELECT ${tx.unsafe(RETURN_COLUMNS)}
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
    ORDER BY created_at ASC, id ASC
  `) as ReturnRow[];
  return hydrate(tx, tenantId, rows);
}

export const RETURN_LIST_DEFAULT_LIMIT = 50;
export const RETURN_LIST_MAX_LIMIT = 100;

export { decodeKeysetCursor };

/**
 * Newest first, bounded; optional status filter. Keyset by `(created_at, id)`
 * with the cursor's timestamp carried as full-precision TEXT (see
 * `_shared/keyset-pagination.ts` - a JS `Date` would floor the microseconds
 * and skip rows past page one).
 */
export async function listReturns(
  tx: Bun.SQL,
  tenantId: string,
  options: {
    status?: ReturnStatus | null;
    limit?: number;
    cursor?: KeysetCursor | null;
  }
): Promise<{ items: ReturnRecord[]; nextCursor: string | null }> {
  const limit = Math.min(
    Math.max(options.limit ?? RETURN_LIST_DEFAULT_LIMIT, 1),
    RETURN_LIST_MAX_LIMIT
  );
  const status = options.status ?? null;
  const cursorAt = options.cursor?.createdAt ?? null;
  const cursorId = options.cursor?.id ?? null;
  const rows = (await tx`
    SELECT ${tx.unsafe(RETURN_COLUMNS)},
           ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_commerce_returns
    WHERE tenant_id = ${tenantId}
      AND (${status}::text IS NULL OR status = ${status})
      AND (
        ${cursorAt}::text IS NULL
        OR (created_at, id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}
  `) as (ReturnRow & { created_at_cursor: string })[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: await hydrate(tx, tenantId, page),
    nextCursor:
      rows.length > limit && last
        ? encodeKeysetCursor(last.created_at_cursor, last.id)
        : null
  };
}

/** The refund leg, tenant- AND return-scoped (a refund of another return is the same `null` as an unknown one). */
export async function fetchRefundForReturn(
  tx: Bun.SQL,
  tenantId: string,
  returnId: string,
  refundId: string
): Promise<RefundRecord | null> {
  const rows = (await tx`
    SELECT ${tx.unsafe(REFUND_COLUMNS)}
    FROM awcms_commerce_refunds
    WHERE tenant_id = ${tenantId} AND return_id = ${returnId} AND id = ${refundId}
  `) as RefundRow[];
  return rows[0] ? toRefundRecord(rows[0]) : null;
}

export type ReturnableLine = {
  orderItemId: string;
  name: string;
  variantName: string | null;
  sku: string | null;
  unitPrice: string;
  quantity: number;
  returned: number;
  /** Units still eligible to return (`quantity - returned`, never negative). */
  remaining: number;
};

/**
 * The lines of an order with how many units are still eligible to return - the
 * return wizard's rows. One query, tenant-scoped; an unknown order is `[]`.
 */
export async function listReturnableLines(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<ReturnableLine[]> {
  const rows = (await tx`
    SELECT i.id, i.name, i.variant_name, i.sku, i.unit_price, i.quantity,
      COALESCE((
        SELECT SUM(l.quantity) FROM awcms_commerce_return_lines l
        WHERE l.tenant_id = i.tenant_id AND l.order_item_id = i.id
      ), 0)::int AS returned
    FROM awcms_commerce_order_items i
    WHERE i.tenant_id = ${tenantId} AND i.order_id = ${orderId}
      AND i.deleted_at IS NULL
    ORDER BY i.created_at ASC, i.id ASC
  `) as {
    id: string;
    name: string;
    variant_name: string | null;
    sku: string | null;
    unit_price: string;
    quantity: number;
    returned: number;
  }[];
  return rows.map((row) => ({
    orderItemId: row.id,
    name: row.name,
    variantName: row.variant_name,
    sku: row.sku,
    unitPrice: normalizeMoney(String(row.unit_price)),
    quantity: Number(row.quantity),
    returned: Number(row.returned),
    remaining: Math.max(0, Number(row.quantity) - Number(row.returned))
  }));
}
