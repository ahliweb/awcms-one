/**
 * `awcms_commerce_affiliates` / `_affiliate_commissions` persistence —
 * Issue #92 (contract #86's D5). Storefront (bearer) enrolment/self-view and
 * owner (ABAC) moderation both live here, the same "one directory per
 * table-family" shape `order-directory.ts` already uses.
 *
 * `order-directory.ts`'s `transitionOrderStatus` calls two functions here
 * directly (`recordAffiliateCommissionOnOrderCompleted` on the transition to
 * `completed`, `voidAffiliateCommissionForOrder` on the transition to
 * `cancelled`) — this file never imports FROM `order-directory.ts`, so there
 * is no cycle.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import { normalizeMoney } from "../domain/price-calculation";
import {
  computeCommissionAmount,
  computeCommissionBase,
  shouldEarnCommission
} from "../domain/affiliate-commission";
import {
  generateAffiliateCode,
  isAffiliateCodeShape
} from "../domain/affiliate-code";
import { fetchAffiliateCommissionRate } from "./store-settings-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE_AFFILIATE = "affiliate";
const AUDIT_RESOURCE_TYPE_COMMISSION = "affiliate_commission";

const POSTGRES_UNIQUE_VIOLATION = "23505";
const AFFILIATE_CODE_CONSTRAINT = "awcms_commerce_affiliates_tenant_code_key";
const MAX_AFFILIATE_CODE_ATTEMPTS = 5;

export const AFFILIATE_LIST_LIMIT = 100;
export const AFFILIATE_COMMISSION_LIST_LIMIT = 100;
export const ACCOUNT_AFFILIATE_COMMISSION_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Enrolment / self-view (storefront, bearer)
// ---------------------------------------------------------------------------

export class AffiliateProgramDisabledError extends Error {
  constructor() {
    super("The affiliate program is not enabled for this tenant.");
    this.name = "AffiliateProgramDisabledError";
  }
}

type AffiliateRow = {
  id: string;
  customer_id: string;
  code: string;
  commission_rate: string;
  status: "active" | "suspended";
  created_at: string;
};

export type AffiliateStats = {
  referredOrders: number;
  pendingAmount: string;
  approvedAmount: string;
  paidAmount: string;
};

export type AccountAffiliateRecord = {
  code: string;
  commissionRate: string;
  status: "active" | "suspended";
  link: string;
  stats: AffiliateStats;
};

/** `"${STOREFRONT_URL}/?ref=${code}"` — `COMMERCE_STOREFRONT_PUBLIC_URL` is this deployment's own configured storefront origin; falls back to a relative path (no origin configured yet) rather than fabricating one. */
function buildAffiliateLink(code: string): string {
  const base = (process.env.COMMERCE_STOREFRONT_PUBLIC_URL ?? "").replace(
    /\/+$/,
    ""
  );
  return `${base}/?ref=${code}`;
}

async function fetchAffiliateByCustomerId(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<AffiliateRow | null> {
  const rows = (await tx`
    SELECT id, customer_id, code, commission_rate, status, created_at
    FROM awcms_commerce_affiliates
    WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND deleted_at IS NULL
  `) as AffiliateRow[];
  return rows[0] ?? null;
}

async function fetchAffiliateStats(
  tx: Bun.SQL,
  tenantId: string,
  affiliateId: string
): Promise<AffiliateStats> {
  const orderCountRows = (await tx`
    SELECT count(*)::int AS count
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND affiliate_id = ${affiliateId}
  `) as { count: number }[];

  const sumRows = (await tx`
    SELECT status, COALESCE(sum(amount), 0)::text AS total
    FROM awcms_commerce_affiliate_commissions
    WHERE tenant_id = ${tenantId} AND affiliate_id = ${affiliateId}
    GROUP BY status
  `) as { status: string; total: string }[];

  const byStatus = new Map(sumRows.map((row) => [row.status, row.total]));

  return {
    referredOrders: orderCountRows[0]?.count ?? 0,
    pendingAmount: normalizeMoney(byStatus.get("pending") ?? "0.00"),
    approvedAmount: normalizeMoney(byStatus.get("approved") ?? "0.00"),
    paidAmount: normalizeMoney(byStatus.get("paid") ?? "0.00")
  };
}

async function toAccountAffiliateRecord(
  tx: Bun.SQL,
  tenantId: string,
  row: AffiliateRow
): Promise<AccountAffiliateRecord> {
  return {
    code: row.code,
    commissionRate: normalizeMoney(row.commission_rate),
    status: row.status,
    link: buildAffiliateLink(row.code),
    stats: await fetchAffiliateStats(tx, tenantId, row.id)
  };
}

/** `GET .../account/affiliate` — `null` when the account has not enrolled. */
export async function fetchAccountAffiliate(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<AccountAffiliateRecord | null> {
  const row = await fetchAffiliateByCustomerId(tx, tenantId, customerId);
  if (!row) return null;
  return toAccountAffiliateRecord(tx, tenantId, row);
}

/** Whether the tenant's affiliate program is turned on — `store_settings.affiliate_commission_rate IS NOT NULL`. */
export async function isAffiliateProgramEnabled(
  tx: Bun.SQL,
  tenantId: string
): Promise<boolean> {
  return (await fetchAffiliateCommissionRate(tx, tenantId)) !== null;
}

async function insertAffiliateWithRetryableCode(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  commissionRate: string
): Promise<AffiliateRow> {
  for (let attempt = 0; attempt < MAX_AFFILIATE_CODE_ATTEMPTS; attempt += 1) {
    const code = generateAffiliateCode();
    try {
      const rows = (await tx`
        INSERT INTO awcms_commerce_affiliates (tenant_id, customer_id, code, commission_rate, status)
        VALUES (${tenantId}, ${customerId}, ${code}, ${commissionRate}, 'active')
        RETURNING id, customer_id, code, commission_rate, status, created_at
      `) as AffiliateRow[];
      return rows[0]!;
    } catch (error) {
      const isCollision =
        error instanceof Bun.SQL.PostgresError &&
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === AFFILIATE_CODE_CONSTRAINT;
      if (!isCollision || attempt === MAX_AFFILIATE_CODE_ATTEMPTS - 1) {
        throw error;
      }
    }
  }
  throw new Error("Failed to generate a unique affiliate code.");
}

/**
 * `POST .../account/affiliate` — idempotent: an already-enrolled account
 * gets back its own existing row rather than a second one (the
 * `(tenant_id, customer_id)` unique index backs this, but this function
 * checks first to avoid manufacturing — and immediately discarding — a
 * fresh code on every repeat call).
 *
 * @throws {AffiliateProgramDisabledError} the tenant's program is off.
 */
export async function enrolAffiliate(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  correlationId?: string
): Promise<AccountAffiliateRecord> {
  const existing = await fetchAffiliateByCustomerId(tx, tenantId, customerId);
  if (existing) return toAccountAffiliateRecord(tx, tenantId, existing);

  const rate = await fetchAffiliateCommissionRate(tx, tenantId);
  if (rate === null) throw new AffiliateProgramDisabledError();

  const row = await insertAffiliateWithRetryableCode(
    tx,
    tenantId,
    customerId,
    rate
  );

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE_AFFILIATE,
    resourceId: row.id,
    message: `Customer enrolled in the affiliate program (code ${row.code}).`,
    attributes: { code: row.code, commissionRate: row.commission_rate },
    correlationId
  });

  return toAccountAffiliateRecord(tx, tenantId, row);
}

export type AccountAffiliateCommission = {
  id: string;
  orderCode: string;
  amount: string;
  status: "pending" | "approved" | "paid" | "void";
  createdAt: string;
};

export type AccountAffiliateCommissionPage = {
  items: AccountAffiliateCommission[];
  nextCursor: string | null;
};

/** `GET .../account/affiliate/commissions` — the enrolled account's own ledger, keyset, newest first. */
export async function listAccountAffiliateCommissions(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  cursor: KeysetCursor | null,
  limit: number = ACCOUNT_AFFILIATE_COMMISSION_LIST_LIMIT
): Promise<AccountAffiliateCommissionPage> {
  const affiliate = await fetchAffiliateByCustomerId(tx, tenantId, customerId);
  if (!affiliate) return { items: [], nextCursor: null };

  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    ACCOUNT_AFFILIATE_COMMISSION_LIST_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT c.id, c.amount, c.status, o.order_code,
           ${tx.unsafe(keysetCursorCreatedAtSql("c"))} AS created_at_cursor
    FROM awcms_commerce_affiliate_commissions c
    JOIN awcms_commerce_orders o ON o.id = c.order_id
    WHERE c.tenant_id = ${tenantId} AND c.affiliate_id = ${affiliate.id}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (c.created_at, c.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${boundedLimit}
  `) as {
    id: string;
    amount: string;
    status: AccountAffiliateCommission["status"];
    order_code: string;
    created_at_cursor: string;
  }[];

  const items = rows.map((row) => ({
    id: row.id,
    orderCode: row.order_code,
    amount: normalizeMoney(row.amount),
    status: row.status,
    createdAt: row.created_at_cursor
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

// ---------------------------------------------------------------------------
// Order-time resolution + completion/cancellation hooks (called from
// order-directory.ts)
// ---------------------------------------------------------------------------

/**
 * `?ref=`/checkout `affiliateCode` -> `orders.affiliate_id`, at
 * order-creation time. Unknown or suspended code -> `null`, NEVER an error —
 * a bad referral code must never block a checkout (Issue #92's own words).
 */
export async function resolveAffiliateForOrder(
  tx: Bun.SQL,
  tenantId: string,
  code: string | null
): Promise<string | null> {
  if (!code || !isAffiliateCodeShape(code)) return null;

  const rows = (await tx`
    SELECT id FROM awcms_commerce_affiliates
    WHERE tenant_id = ${tenantId} AND code = ${code} AND status = 'active' AND deleted_at IS NULL
  `) as { id: string }[];

  return rows[0]?.id ?? null;
}

/**
 * Called from `order-directory.ts`'s `transitionOrderStatus` the moment an
 * order reaches `completed`. No-op when the order carries no
 * `affiliate_id`, or when `shouldEarnCommission` says no (self-referral, or
 * the affiliate was suspended sometime between order-creation and
 * completion). `ON CONFLICT (order_id) DO NOTHING` on the insert is a
 * belt-and-suspenders guard — `completed` is a terminal state
 * (`domain/order-status.ts`), so this should never run twice for the same
 * order, but a commission is money and a defensive unique-constraint no-op
 * costs nothing.
 */
export async function recordAffiliateCommissionOnOrderCompleted(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<void> {
  const orderRows = (await tx`
    SELECT affiliate_id, customer_id, order_code, subtotal, discount, voucher_discount
    FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as {
    affiliate_id: string | null;
    customer_id: string;
    order_code: string;
    subtotal: string;
    discount: string;
    voucher_discount: string;
  }[];
  const order = orderRows[0];
  if (!order || !order.affiliate_id) return;

  const affiliateRows = (await tx`
    SELECT customer_id, status, commission_rate
    FROM awcms_commerce_affiliates
    WHERE tenant_id = ${tenantId} AND id = ${order.affiliate_id}
  `) as {
    customer_id: string;
    status: "active" | "suspended";
    commission_rate: string;
  }[];
  const affiliate = affiliateRows[0];
  if (!affiliate) return;

  const earns = shouldEarnCommission({
    affiliateCustomerId: affiliate.customer_id,
    orderCustomerId: order.customer_id,
    affiliateStatus: affiliate.status
  });
  if (!earns) return;

  const base = computeCommissionBase(
    order.subtotal,
    order.discount,
    order.voucher_discount
  );
  const amount = computeCommissionAmount(base, affiliate.commission_rate);

  const inserted = (await tx`
    INSERT INTO awcms_commerce_affiliate_commissions
      (tenant_id, affiliate_id, order_id, base_amount, rate, amount, status)
    VALUES (${tenantId}, ${order.affiliate_id}, ${orderId}, ${base}, ${affiliate.commission_rate}, ${amount}, 'pending')
    ON CONFLICT (order_id) DO NOTHING
    RETURNING id
  `) as { id: string }[];
  if (inserted.length === 0) return;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE_COMMISSION,
    resourceId: inserted[0]!.id,
    message: `Affiliate commission of ${amount} recorded for order ${order.order_code}.`,
    attributes: { orderId, orderCode: order.order_code, amount },
    correlationId
  });
}

/**
 * Called from `order-directory.ts`'s `transitionOrderStatus` on a
 * `cancelled` transition — voids a `pending`/`approved` commission attached
 * to the order, if one exists. Under the CURRENT order-status graph
 * (`domain/order-status.ts`), `completed` has no outgoing edge, so a
 * commission cannot actually be voided this way today; this hook exists so
 * a future refund/cancel-after-completion path (if one is ever added to the
 * graph) reuses the same enforcement rather than growing a second one.
 */
export async function voidAffiliateCommissionForOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<void> {
  const rows = (await tx`
    UPDATE awcms_commerce_affiliate_commissions
    SET status = 'void', voided_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND status IN ('pending', 'approved')
    RETURNING id
  `) as { id: string }[];
  if (rows.length === 0) return;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_COMMISSION,
    resourceId: rows[0]!.id,
    message: `Affiliate commission voided (order ${orderId} cancelled).`,
    attributes: { orderId },
    correlationId
  });
}

// ---------------------------------------------------------------------------
// Owner surface (ABAC-guarded)
// ---------------------------------------------------------------------------

export type AdminAffiliateRecord = {
  id: string;
  code: string;
  customerId: string;
  customerName: string;
  commissionRate: string;
  status: "active" | "suspended";
  createdAt: string;
};

export type AdminAffiliateListPage = {
  items: AdminAffiliateRecord[];
  nextCursor: string | null;
};

/** `GET /api/v1/commerce/affiliates` — staff list, keyset, newest first. */
export async function listAffiliatesForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null
): Promise<AdminAffiliateListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT a.id, a.code, a.customer_id, a.commission_rate, a.status,
           c.name AS customer_name,
           ${tx.unsafe(keysetCursorCreatedAtSql("a"))} AS created_at_cursor
    FROM awcms_commerce_affiliates a
    JOIN awcms_commerce_customers c ON c.id = a.customer_id
    WHERE a.tenant_id = ${tenantId} AND a.deleted_at IS NULL
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (a.created_at, a.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${AFFILIATE_LIST_LIMIT}
  `) as {
    id: string;
    code: string;
    customer_id: string;
    commission_rate: string;
    status: "active" | "suspended";
    customer_name: string;
    created_at_cursor: string;
  }[];

  const items = rows.map((row) => ({
    id: row.id,
    code: row.code,
    customerId: row.customer_id,
    customerName: row.customer_name,
    commissionRate: normalizeMoney(row.commission_rate),
    status: row.status,
    createdAt: row.created_at_cursor
  }));

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === AFFILIATE_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

export type PatchAffiliateInput = {
  status?: "active" | "suspended";
  commissionRate?: string;
};

/** `PATCH /api/v1/commerce/affiliates/{id}` — `null` for an unknown id. */
export async function patchAffiliate(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  affiliateId: string,
  input: PatchAffiliateInput,
  correlationId?: string
): Promise<AdminAffiliateRecord | null> {
  const rows = (await tx`
    UPDATE awcms_commerce_affiliates
    SET status = COALESCE(${input.status ?? null}, status),
        commission_rate = COALESCE(${input.commissionRate ?? null}, commission_rate),
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${affiliateId} AND deleted_at IS NULL
    RETURNING id, code, customer_id, commission_rate, status, created_at
  `) as AffiliateRow[];
  const row = rows[0];
  if (!row) return null;

  const customerRows = (await tx`
    SELECT name FROM awcms_commerce_customers WHERE id = ${row.customer_id}
  `) as { name: string }[];

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_AFFILIATE,
    resourceId: affiliateId,
    message: `Affiliate ${row.code} updated.`,
    attributes: { status: row.status, commissionRate: row.commission_rate },
    correlationId
  });

  return {
    id: row.id,
    code: row.code,
    customerId: row.customer_id,
    customerName: customerRows[0]?.name ?? "",
    commissionRate: normalizeMoney(row.commission_rate),
    status: row.status,
    createdAt: row.created_at
  };
}

export type AdminAffiliateCommissionRecord = {
  id: string;
  affiliateId: string;
  affiliateCode: string;
  orderId: string;
  orderCode: string;
  baseAmount: string;
  rate: string;
  amount: string;
  status: "pending" | "approved" | "paid" | "void";
  createdAt: string;
};

export type AdminAffiliateCommissionListPage = {
  items: AdminAffiliateCommissionRecord[];
  nextCursor: string | null;
};

function toAdminCommissionRecord(row: {
  id: string;
  affiliate_id: string;
  affiliate_code: string;
  order_id: string;
  order_code: string;
  base_amount: string;
  rate: string;
  amount: string;
  status: AdminAffiliateCommissionRecord["status"];
  created_at_cursor?: string;
  created_at?: string;
}): AdminAffiliateCommissionRecord {
  return {
    id: row.id,
    affiliateId: row.affiliate_id,
    affiliateCode: row.affiliate_code,
    orderId: row.order_id,
    orderCode: row.order_code,
    baseAmount: normalizeMoney(row.base_amount),
    rate: normalizeMoney(row.rate),
    amount: normalizeMoney(row.amount),
    status: row.status,
    createdAt: row.created_at_cursor ?? row.created_at ?? ""
  };
}

/** `GET /api/v1/commerce/affiliate-commissions?status=` — staff list, keyset, newest first. */
export async function listAffiliateCommissionsForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: { status?: "pending" | "approved" | "paid" | "void" } = {}
): Promise<AdminAffiliateCommissionListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const statusParam = filters.status ?? null;

  const rows = (await tx`
    SELECT c.id, c.affiliate_id, a.code AS affiliate_code, c.order_id, o.order_code,
           c.base_amount, c.rate, c.amount, c.status,
           ${tx.unsafe(keysetCursorCreatedAtSql("c"))} AS created_at_cursor
    FROM awcms_commerce_affiliate_commissions c
    JOIN awcms_commerce_affiliates a ON a.id = c.affiliate_id
    JOIN awcms_commerce_orders o ON o.id = c.order_id
    WHERE c.tenant_id = ${tenantId}
      AND (${statusParam}::text IS NULL OR c.status = ${statusParam})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (c.created_at, c.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${AFFILIATE_COMMISSION_LIST_LIMIT}
  `) as {
    id: string;
    affiliate_id: string;
    affiliate_code: string;
    order_id: string;
    order_code: string;
    base_amount: string;
    rate: string;
    amount: string;
    status: AdminAffiliateCommissionRecord["status"];
    created_at_cursor: string;
  }[];

  const items = rows.map(toAdminCommissionRecord);

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === AFFILIATE_COMMISSION_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

export class InvalidCommissionTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Commission cannot move from "${from}" to "${to}".`);
    this.name = "InvalidCommissionTransitionError";
  }
}

type CommissionStatus = "pending" | "approved" | "paid" | "void";

const LEGAL_COMMISSION_TRANSITIONS: Record<
  CommissionStatus,
  readonly CommissionStatus[]
> = {
  pending: ["approved", "void"],
  approved: ["paid", "void"],
  paid: [],
  void: []
};

const TRANSITION_TIMESTAMP_COLUMN: Record<
  CommissionStatus,
  "approved_at" | "paid_at" | "voided_at" | null
> = {
  pending: null,
  approved: "approved_at",
  paid: "paid_at",
  void: "voided_at"
};

async function transitionCommissionStatus(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  commissionId: string,
  to: CommissionStatus,
  correlationId?: string
): Promise<AdminAffiliateCommissionRecord | null> {
  const rows = (await tx`
    SELECT c.id, c.status, c.affiliate_id, a.code AS affiliate_code,
           c.order_id, o.order_code, c.base_amount, c.rate, c.amount
    FROM awcms_commerce_affiliate_commissions c
    JOIN awcms_commerce_affiliates a ON a.id = c.affiliate_id
    JOIN awcms_commerce_orders o ON o.id = c.order_id
    WHERE c.tenant_id = ${tenantId} AND c.id = ${commissionId}
  `) as {
    id: string;
    status: CommissionStatus;
    affiliate_id: string;
    affiliate_code: string;
    order_id: string;
    order_code: string;
    base_amount: string;
    rate: string;
    amount: string;
  }[];
  const current = rows[0];
  if (!current) return null;

  if (!LEGAL_COMMISSION_TRANSITIONS[current.status].includes(to)) {
    throw new InvalidCommissionTransitionError(current.status, to);
  }

  const column = TRANSITION_TIMESTAMP_COLUMN[to];
  const timestampSetSql = column ? `${column} = now(),` : "";

  await tx`
    UPDATE awcms_commerce_affiliate_commissions
    SET status = ${to},
        ${tx.unsafe(timestampSetSql)}
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${commissionId}
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE_COMMISSION,
    resourceId: commissionId,
    message: `Affiliate commission for order ${current.order_code} moved ${current.status} -> ${to}.`,
    attributes: { from: current.status, to, orderCode: current.order_code },
    correlationId
  });

  return toAdminCommissionRecord({ ...current, status: to });
}

/** `POST .../affiliate-commissions/{id}/approve` — `pending -> approved`. */
export async function approveAffiliateCommission(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  commissionId: string,
  correlationId?: string
): Promise<AdminAffiliateCommissionRecord | null> {
  return transitionCommissionStatus(
    tx,
    tenantId,
    actorTenantUserId,
    commissionId,
    "approved",
    correlationId
  );
}

/** `POST .../affiliate-commissions/{id}/pay` — `approved -> paid`. */
export async function payAffiliateCommission(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  commissionId: string,
  correlationId?: string
): Promise<AdminAffiliateCommissionRecord | null> {
  return transitionCommissionStatus(
    tx,
    tenantId,
    actorTenantUserId,
    commissionId,
    "paid",
    correlationId
  );
}

/** `POST .../affiliate-commissions/{id}/void` — `pending|approved -> void`. */
export async function voidAffiliateCommission(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  commissionId: string,
  correlationId?: string
): Promise<AdminAffiliateCommissionRecord | null> {
  return transitionCommissionStatus(
    tx,
    tenantId,
    actorTenantUserId,
    commissionId,
    "void",
    correlationId
  );
}
