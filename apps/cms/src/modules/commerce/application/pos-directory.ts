/**
 * `POST /api/v1/commerce/pos/orders` / `GET /api/v1/commerce/pos/orders` —
 * counter (POS) sales (Issue #116, epic #33 C7, contract #106's D6,
 * ADR-0017). The transactional heart mirrors
 * `application/order-directory.ts`'s `createOrderFromCart` — ONE function
 * re-quotes the cart, writes the order + items, decrements stock/a
 * flash-sale's quota, all inside one transaction — but is its OWN function
 * rather than a call into `createOrderFromCart` itself, for three reasons a
 * counter sale genuinely differs on:
 *
 * 1. **Payment**: `createOrderFromCart` gates the chosen method against
 *    `quote.paymentMethods` (store-settings-driven — manual bank/QRIS/DP/
 *    gateway availability), which knows nothing about `"cash"`. A POS sale
 *    is ALWAYS paid in full, on the spot — there is no `paymentMethods`
 *    availability question to ask.
 * 2. **Status**: `createOrderFromCart` always leaves an order
 *    `pending_payment`. A POS sale is `paid` the instant it exists —
 *    `createPosOrder` inserts `pending_payment` (reusing the SAME initial
 *    `order_events` row shape) and immediately calls
 *    `order-directory.ts`'s `applyPosOrderPaidTransition`, actor `"admin"`.
 * 3. **No address/voucher/affiliate/DP**: none of `createOrderFromCart`'s
 *    address snapshot, voucher redemption, or affiliate attribution apply
 *    to a counter sale — `shipping` is always `self_pickup`, no address is
 *    ever stored.
 *
 * The QUOTE/STOCK path IS reused, though — `buildCartQuote` (the same
 * function `createOrderFromCart` calls) re-prices every line and re-checks
 * stock inside this transaction, so a cashier can never ring up a price the
 * catalog no longer honours or a quantity the shelf no longer has. A
 * phone-identified customer's `level` is passed through as `customerLevel`
 * (#118 tiered pricing) — a level-2 partner buying at the counter pays the
 * same `price_level_2` they would online.
 *
 * ## Walk-in customer (contract #106 D6)
 *
 * `awcms_commerce_customers.phone` is `NOT NULL` (`sql/913`), so a counter
 * sale with no phone at all still needs a real customer row. When
 * `customer.phone` is blank, `createPosOrder` calls the SAME
 * `findOrCreateCustomerByPhone` a phone-identified sale uses, with
 * `domain/phone-normalisation.ts`'s documented
 * `POS_WALK_IN_CUSTOMER_SENTINEL_PHONE` — so every tenant gets exactly ONE
 * walk-in row, reused (never re-created) across every no-phone sale. A
 * phone that IS given but does not normalise is a `400` (`invalid_phone`),
 * never a silent fall-back to the walk-in row — the cashier typed something
 * and must be told it was wrong.
 *
 * ## Idempotency
 *
 * Same shared `awcms_idempotency_keys` store every other high-risk mutation
 * uses (`_shared/idempotency.ts`), scoped `"commerce.pos.create"` —
 * `(tenantId, scope, idempotencyKey)`. Same key + same payload replays the
 * stored 201 body; same key + different payload is
 * `IdempotencyPayloadMismatchError` (409 `IDEMPOTENCY_CONFLICT`). The acting
 * tenant user is part of the hashed payload (`awcms-idempotency` skill's
 * "bind the hash to the resource" rule): two cashiers who happen to reuse
 * one key value can never have the second replay the first's sale.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { appendDomainEvent } from "../../domain-event-runtime/application/append-domain-event";
import {
  computeRequestHash,
  findIdempotencyRecord,
  saveIdempotencyRecord
} from "../../_shared/idempotency";
import {
  keysetCursorCreatedAtSql,
  encodeKeysetCursor,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import { normalizeMoney } from "../domain/price-calculation";
import {
  normalizePhoneNumber,
  maskPhone,
  POS_WALK_IN_CUSTOMER_SENTINEL_PHONE
} from "../domain/phone-normalisation";
import { generateOrderCode } from "../domain/order-code";
import type { OrderStatus } from "../domain/order-status";
import type { CustomerLevel } from "../domain/cart-quote";
import {
  computeChange,
  POS_WALK_IN_CUSTOMER_NAME,
  type CreatePosOrderInput
} from "../domain/pos-order-validation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE,
  COMMERCE_ORDER_CREATED_EVENT_TYPE
} from "../domain/commerce-events";
import { buildCartQuote } from "./cart-quote-service";
import { findOrCreateCustomerByPhone } from "./customer-directory";
import {
  applyPosOrderPaidTransition,
  fetchOrderDetailForAdmin,
  IdempotencyPayloadMismatchError,
  toAdminOrderRecord,
  type OrderAdminDetailRecord,
  type OrderAdminSummary
} from "./order-directory";
import type { CartQuoteResult } from "../domain/cart-quote";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "order";
const PRODUCER_MODULE = "commerce";
const IDEMPOTENCY_SCOPE = "commerce.pos.create";
/** The audit action every counter sale records (skill `awcms-audit-log`: a posted transaction MUST be audited). */
export const POS_SALE_AUDIT_ACTION = "commerce.pos.sale";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const ORDER_CODE_CONSTRAINT = "awcms_commerce_orders_tenant_code_key";
const MAX_ORDER_CODE_ATTEMPTS = 5;

export const POS_ORDER_LIST_LIMIT = 50;

export class PosCartChangedError extends Error {
  public readonly quote: CartQuoteResult;
  constructor(quote: CartQuoteResult) {
    super(
      "One or more lines changed price/stock since the cart was priced; re-quote."
    );
    this.name = "PosCartChangedError";
    this.quote = quote;
  }
}

/**
 * The 201 body — the admin order record (unmasked phone: this is a staff
 * context) plus the computed `change` (`numeric(14,2)` string for cash,
 * `null` for QRIS), the `amountTendered` echoed back for the receipt, and
 * the cashier's own tenant user id.
 */
export type PosOrderRecord = OrderAdminDetailRecord & {
  change: string | null;
  amountTendered: string | null;
  cashierTenantUserId: string;
};

export type CreatePosOrderOutcome =
  | { kind: "replayed"; order: PosOrderRecord }
  | { kind: "created"; order: PosOrderRecord }
  | { kind: "invalid_phone" };

/**
 * `POST /api/v1/commerce/pos/orders` — a `paid`, `self_pickup`, `channel:
 * "pos"` counter sale, created and settled in one call. See this file's
 * header for the full reasoning.
 *
 * @throws {IdempotencyPayloadMismatchError} same key, different payload.
 * @throws {PosCartChangedError} a line's price/stock no longer allows checkout.
 * @throws {InsufficientTenderError} cash tendered is less than the total.
 */
export async function createPosOrder(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  mediaPort: MediaLibraryPort,
  input: CreatePosOrderInput,
  now: Date = new Date(),
  correlationId?: string
): Promise<CreatePosOrderOutcome> {
  const requestHash = computeRequestHash({
    action: IDEMPOTENCY_SCOPE,
    actorTenantUserId,
    customer: input.customer,
    lines: input.lines,
    payment: input.payment,
    notes: input.notes
  });

  const existing = await findIdempotencyRecord(
    tx,
    tenantId,
    IDEMPOTENCY_SCOPE,
    input.idempotencyKey
  );
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyPayloadMismatchError();
    }
    return {
      kind: "replayed",
      order: existing.responseBody as PosOrderRecord
    };
  }

  // Walk-in when no phone was given; otherwise find-or-create by the
  // normalised phone, exactly like a storefront guest checkout — resolved
  // BEFORE the quote so the customer's `level` can price it (#118).
  let customerPhone = POS_WALK_IN_CUSTOMER_SENTINEL_PHONE;
  if (input.customer.phone) {
    const phoneResult = normalizePhoneNumber(input.customer.phone);
    if (!phoneResult.valid) return { kind: "invalid_phone" };
    customerPhone = phoneResult.value;
  }
  const isWalkIn = customerPhone === POS_WALK_IN_CUSTOMER_SENTINEL_PHONE;
  const customerName =
    input.customer.name ??
    (isWalkIn ? POS_WALK_IN_CUSTOMER_NAME : "Pelanggan POS");

  const customer = await findOrCreateCustomerByPhone(
    tx,
    tenantId,
    customerName,
    customerPhone,
    null,
    correlationId
  );
  const customerLevel: CustomerLevel | null =
    !isWalkIn && customer.level >= 1 && customer.level <= 4
      ? (customer.level as CustomerLevel)
      : null;

  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: input.lines.map((line) => ({
        productId: line.productId,
        variantId: line.variantId,
        quantity: line.quantity,
        serviceFormValues: null
      })),
      shipping: { method: "self_pickup" },
      voucherCode: null,
      insurance: false,
      destination: null,
      customerLevel
    },
    now
  );

  // `canCheckout` is lines-only (every line `status: "ok"`): `quote.shipping`
  // may legitimately be `null` when the tenant never enabled self-pickup in
  // its store settings — a counter sale IS a pickup by definition, so the
  // storefront's shipping/payment availability never decides a POS sale.
  // The store's tax setting DOES apply (`quote.tax`), exactly as online.
  if (!quote.canCheckout) {
    throw new PosCartChangedError(quote);
  }

  // Throws `InsufficientTenderError` on a short tender — the route maps it
  // to a `409`, never silently records a negative change. QRIS is exact.
  const change =
    input.payment.method === "cash" && input.payment.amountTendered !== null
      ? computeChange(input.payment.amountTendered, quote.total)
      : null;

  let orderId = "";
  let orderCode = "";
  for (let attempt = 0; attempt < MAX_ORDER_CODE_ATTEMPTS; attempt += 1) {
    const candidateCode = generateOrderCode(now);
    try {
      const rows = (await tx`
        INSERT INTO awcms_commerce_orders (
          tenant_id, order_code, customer_id, status, payment_method, payment_status,
          shipping_method, shipping_cost, subtotal, discount, insurance_fee, tax, total,
          notes, channel, pos_cashier_tenant_user_id
        )
        VALUES (
          ${tenantId}, ${candidateCode}, ${customer.id}, 'pending_payment', ${input.payment.method}, 'unpaid',
          'self_pickup', '0.00', ${quote.subtotal}, ${quote.discount}, ${quote.insurance.fee}, ${quote.tax.amount},
          ${quote.total}, ${input.notes}, 'pos', ${actorTenantUserId}
        )
        RETURNING id, order_code
      `) as { id: string; order_code: string }[];
      orderId = rows[0]!.id;
      orderCode = rows[0]!.order_code;
      break;
    } catch (error) {
      const isCollision =
        error instanceof Bun.SQL.PostgresError &&
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === ORDER_CODE_CONSTRAINT;
      if (!isCollision || attempt === MAX_ORDER_CODE_ATTEMPTS - 1) throw error;
    }
  }

  // Sequential — one reserved `tx` connection (`tenant-route.ts`'s header).
  for (const line of quote.lines) {
    await tx`
      INSERT INTO awcms_commerce_order_items (
        tenant_id, order_id, product_id, variant_id, flash_sale_id,
        name, variant_name, sku, unit_price, quantity, weight_grams, line_total
      )
      VALUES (
        ${tenantId}, ${orderId}, ${line.productId}, ${line.variantId}, ${line.flashSaleId},
        ${line.name}, ${line.variantName}, ${line.sku}, ${line.unitPrice}, ${line.quantity},
        ${line.weightGrams}, ${line.lineTotal}
      )
    `;

    if (line.variantId) {
      await tx`
        UPDATE awcms_commerce_product_variants
        SET stock = stock - ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${line.variantId} AND deleted_at IS NULL
      `;
    } else {
      await tx`
        UPDATE awcms_commerce_products
        SET stock = stock - ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${line.productId} AND deleted_at IS NULL
      `;
    }

    if (line.flashSaleId) {
      await tx`
        UPDATE awcms_commerce_flash_sale_products
        SET sold = sold + ${line.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND flash_sale_id = ${line.flashSaleId}
          AND product_id = ${line.productId}
          AND variant_id IS NOT DISTINCT FROM ${line.variantId}
          AND deleted_at IS NULL
      `;
    }
  }

  // Initial `order_events` row — actor `"admin"` (a POS sale is staff-rung,
  // never `"customer"`), mirroring `createOrderFromCart`'s own insert shape.
  await tx`
    INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor)
    VALUES (${tenantId}, ${orderId}, NULL, 'pending_payment', 'admin')
  `;

  // Attributes carry no PII: order code, money, method, walk-in flag —
  // never the customer's name/phone (skill `awcms-audit-log` redaction).
  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: POS_SALE_AUDIT_ACTION,
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    message: `POS sale ${orderCode} rung up at the counter (${input.payment.method}).`,
    attributes: {
      orderCode,
      total: quote.total,
      method: input.payment.method,
      amountTendered: input.payment.amountTendered,
      change,
      walkIn: isWalkIn,
      lineCount: quote.lines.length
    },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_ORDER_CREATED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: orderId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: { orderId, orderCode, total: quote.total, channel: "pos" }
  });

  // `pending_payment -> paid`, actor `"admin"` — see `order-directory.ts`'s
  // `applyPosOrderPaidTransition` header for why this is a shared function
  // rather than a second copy of the status-transition bookkeeping.
  await applyPosOrderPaidTransition(
    tx,
    tenantId,
    actorTenantUserId,
    orderId,
    correlationId
  );

  const detail = await fetchOrderDetailForAdmin(
    tx,
    tenantId,
    mediaPort,
    orderId
  );
  const record = await toAdminOrderRecord(tx, tenantId, detail!);
  const responseBody: PosOrderRecord = {
    ...record,
    change,
    amountTendered: input.payment.amountTendered,
    cashierTenantUserId: actorTenantUserId
  };

  await saveIdempotencyRecord(
    tx,
    tenantId,
    IDEMPOTENCY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    responseBody
  );

  return { kind: "created", order: responseBody };
}

// ---------------------------------------------------------------------------
// POS history — `GET /api/v1/commerce/pos/orders`
// ---------------------------------------------------------------------------

export type PosOrderSummary = OrderAdminSummary & {
  paymentMethod: string;
  cashierTenantUserId: string | null;
};

export type PosOrderListPage = {
  items: PosOrderSummary[];
  nextCursor: string | null;
};

export type PosOrderListFilters = {
  dateFrom?: Date;
  dateTo?: Date;
  cashierTenantUserId?: string;
};

/**
 * Keyset history, newest first, `channel = 'pos'` only (contract's own
 * `(tenant, channel, created_at)` index, `sql/931`). Optional `dateFrom`/
 * `dateTo` (inclusive bounds) and `cashierTenantUserId` filters narrow the
 * same scan.
 */
export async function listPosOrders(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: PosOrderListFilters = {}
): Promise<PosOrderListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const dateFrom = filters.dateFrom ?? null;
  const dateTo = filters.dateTo ?? null;
  const cashierTenantUserId = filters.cashierTenantUserId ?? null;

  const rows = (await tx`
    SELECT o.id, o.order_code, o.status, o.payment_status, o.payment_method,
           o.pos_cashier_tenant_user_id, o.total, o.created_at,
           c.name AS customer_name, c.phone AS customer_phone,
           ${tx.unsafe(keysetCursorCreatedAtSql("o"))} AS created_at_cursor
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId}
      AND o.channel = 'pos'
      AND o.deleted_at IS NULL
      AND (${dateFrom}::timestamptz IS NULL OR o.created_at >= ${dateFrom})
      AND (${dateTo}::timestamptz IS NULL OR o.created_at <= ${dateTo})
      AND (
        ${cashierTenantUserId}::uuid IS NULL
        OR o.pos_cashier_tenant_user_id = ${cashierTenantUserId}
      )
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (o.created_at, o.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${POS_ORDER_LIST_LIMIT}
  `) as {
    id: string;
    order_code: string;
    status: string;
    payment_status: string;
    payment_method: string;
    pos_cashier_tenant_user_id: string | null;
    total: string;
    created_at: Date;
    customer_name: string;
    customer_phone: string;
    created_at_cursor: string;
  }[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === POS_ORDER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      orderCode: row.order_code,
      status: row.status as OrderStatus,
      paymentStatus: row.payment_status,
      paymentMethod: row.payment_method,
      cashierTenantUserId: row.pos_cashier_tenant_user_id,
      customerName: row.customer_name,
      customerPhoneMasked: maskPhone(row.customer_phone),
      total: normalizeMoney(row.total),
      createdAt: row.created_at.toISOString()
    })),
    nextCursor
  };
}
