/**
 * `awcms_commerce_orders` (+ `_order_items`, `_order_events`,
 * `_payment_confirmations`) persistence — Issue #29. The transactional
 * heart of the module: `createOrderFromCart` is the ONE place that writes an
 * order, decrements stock/a flash-sale's quota, and redeems a voucher, all
 * inside one transaction — the anonymous route
 * (`src/pages/api/v1/commerce/storefront/orders.ts`) never does any of that
 * itself.
 *
 * ## Idempotency: the shared store, not a per-row column
 *
 * The brief flagged a risk that `_shared/idempotency.ts`'s store might
 * assume an authenticated principal. It does not — `findIdempotencyRecord`/
 * `saveIdempotencyRecord` take only `(tx, tenantId, requestScope,
 * idempotencyKey)`, no principal of any kind, and the anonymous tenant
 * wrapper (`application/public-commerce-tenant.ts`) already hands this
 * module a `tenantId` and a `tx` before `createOrderFromCart` ever runs. So
 * this module uses the SAME shared `awcms_idempotency_keys` table every
 * other high-risk mutation in this codebase uses, keyed
 * `(tenantId, "commerce.orders.create", idempotencyKey)` — not a bespoke
 * `idempotency_key` column on `awcms_commerce_orders`. A sequential double
 * submit is caught by `findIdempotencyRecord` before any write; a genuinely
 * concurrent one is caught by `saveIdempotencyRecord`'s `ON CONFLICT`, which
 * throws `IdempotencyRaceLostError` — the ROUTE catches that (since this is
 * a plain `APIRoute`, not `defineTenantRoute`, there is no chokepoint doing
 * it centrally the way `withTenant` does for authenticated routes) and
 * answers with the winner's own response.
 *
 * ## Payment-proof upload: 503, not a bespoke anonymous auth seam
 *
 * `media-library`'s existing upload-session flow
 * (`createPendingNewsMediaObject`/`finalizeNewsMediaUploadSession`) requires
 * a real `actorTenantUserId` and a session `tokenHash` checked via
 * `authorizeInTransaction` — there is no way to call it from an anonymous
 * context without either widening that guard (a real security regression:
 * ANY caller could then mint upload sessions) or building a second,
 * parallel anonymous auth seam bound to `(orderCode, phoneHash)` that this
 * increment did not have room to design and review carefully enough to
 * trust. Both payment-proof routes therefore answer `503 MEDIA_UNAVAILABLE`
 * unconditionally, and the public store-settings read model says
 * `payment.proofUpload: false` so the storefront hides the control — a
 * payment confirmation WITHOUT a proof image is still fully accepted
 * (`createPaymentConfirmation` below never requires one).
 */
import { createHash } from "node:crypto";
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
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
import type {
  MediaLibraryPort,
  ResolvedMediaReferenceDTO
} from "../../_shared/ports/media-library-port";
import { normalizeMoney } from "../domain/price-calculation";
import { normalizePhoneNumber, maskPhone } from "../domain/phone-normalisation";
import { generateOrderCode } from "../domain/order-code";
import {
  applyOrderStatusTransition,
  isOrderCancellableByCustomer,
  isOrderPayable,
  isOrderReviewable,
  type OrderStatus,
  type OrderStatusActor
} from "../domain/order-status";
import type { CartQuoteResult } from "../domain/cart-quote";
import type { CreateOrderInput } from "../domain/order-request-validation";
import {
  COMMERCE_EVENT_VERSION,
  COMMERCE_ORDER_AGGREGATE_TYPE,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_CREATED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_VOUCHER_AGGREGATE_TYPE,
  COMMERCE_VOUCHER_REDEEMED_EVENT_TYPE
} from "../domain/commerce-events";
import { buildCartQuote } from "./cart-quote-service";
import {
  fetchCustomerById,
  findOrCreateCustomerByPhone,
  saveCustomerAddress
} from "./customer-directory";
import { fetchStoreSettings } from "./store-settings-directory";
import { listLiveProductImagesByProductIds } from "./product-image-directory";
import {
  recordAffiliateCommissionOnOrderCompleted,
  resolveAffiliateForOrder,
  voidAffiliateCommissionForOrder
} from "./affiliate-directory";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "order";
const PRODUCER_MODULE = "commerce";
const IDEMPOTENCY_SCOPE = "commerce.orders.create";
const POSTGRES_UNIQUE_VIOLATION = "23505";
const ORDER_CODE_CONSTRAINT = "awcms_commerce_orders_tenant_code_key";
const MAX_ORDER_CODE_ATTEMPTS = 5;

export const ORDER_LIST_LIMIT = 100;

export class IdempotencyPayloadMismatchError extends Error {
  constructor() {
    super("idempotencyKey was already used for a different request payload.");
    this.name = "IdempotencyPayloadMismatchError";
  }
}

export class OrderNotPayableError extends Error {
  constructor() {
    super("Order is not payable (not pending_payment).");
    this.name = "OrderNotPayableError";
  }
}

export class OrderNotCancellableError extends Error {
  constructor() {
    super("Order can no longer be cancelled.");
    this.name = "OrderNotCancellableError";
  }
}

export class IllegalOrderStatusTransitionError extends Error {
  public readonly errors: { field: string; message: string }[];
  constructor(errors: { field: string; message: string }[]) {
    super(errors.map((error) => error.message).join(" "));
    this.name = "IllegalOrderStatusTransitionError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Row / record shapes
// ---------------------------------------------------------------------------

type OrderHeaderRow = {
  id: string;
  order_code: string;
  customer_id: string;
  status: string;
  payment_method: string;
  payment_status: string;
  /** Issue #116 (contract #106 D6) — `"storefront"` for every order created before #116 landed. */
  channel: string;
  shipping_method: string;
  shipping_service_name: string | null;
  shipping_cost: string;
  address: OrderAddressSnapshot | null;
  subtotal: string;
  discount: string;
  voucher_code: string | null;
  voucher_discount: string;
  insurance_fee: string;
  tax: string;
  total: string;
  dp_amount: string | null;
  notes: string | null;
  paid_at: Date | null;
  shipped_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
};

type OrderItemRow = {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  sku: string | null;
  unit_price: string;
  quantity: number;
  line_total: string;
  service_form_values: Record<string, string> | null;
};

type OrderEventRow = {
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: Date;
};

type PaymentConfirmationRow = {
  id: string;
  method: string;
  amount: string;
  bank_name: string | null;
  account_name: string | null;
  status: string;
  created_at: Date;
};

export type OrderAddressSnapshot = {
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  postalCode: string | null;
  street: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
};

export type OrderDetail = {
  id: string;
  orderCode: string;
  customerId: string;
  status: OrderStatus;
  paymentMethod: string;
  paymentStatus: string;
  /** Issue #116 (contract #106 D6) — `"storefront"` for every order created before #116 landed. */
  channel: string;
  shippingMethod: string;
  shippingServiceName: string | null;
  shippingCost: string;
  address: OrderAddressSnapshot | null;
  subtotal: string;
  discount: string;
  voucherCode: string | null;
  voucherDiscount: string;
  insuranceFee: string;
  tax: string;
  total: string;
  dpAmount: string | null;
  notes: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  customer: { name: string; phone: string; email: string | null };
  lines: {
    productId: string;
    variantId: string | null;
    name: string;
    variantName: string | null;
    sku: string | null;
    unitPrice: string;
    quantity: number;
    lineTotal: string;
    serviceFormValues: Record<string, string> | null;
    image: { url: string; alt: string } | null;
  }[];
  timeline: { status: string; at: string; note: string | null }[];
  paymentConfirmations: {
    id: string;
    method: string;
    amount: string;
    bankName: string | null;
    accountName: string | null;
    status: string;
    submittedAt: string;
  }[];
};

async function fetchOrderDetailByWhere(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  where: { id: string } | { orderCode: string }
): Promise<OrderDetail | null> {
  const headerRows =
    "id" in where
      ? ((await tx`
          SELECT o.id, o.order_code, o.customer_id, o.status, o.payment_method, o.payment_status,
                 o.channel, o.shipping_method, o.shipping_service_name, o.shipping_cost, o.address,
                 o.subtotal, o.discount, o.voucher_code, o.voucher_discount, o.insurance_fee,
                 o.tax, o.total, o.dp_amount, o.notes, o.paid_at, o.shipped_at, o.completed_at,
                 o.cancelled_at, o.expires_at, o.created_at,
                 c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
          FROM awcms_commerce_orders o
          JOIN awcms_commerce_customers c ON c.id = o.customer_id
          WHERE o.tenant_id = ${tenantId} AND o.id = ${where.id} AND o.deleted_at IS NULL
        `) as OrderHeaderRow[])
      : ((await tx`
          SELECT o.id, o.order_code, o.customer_id, o.status, o.payment_method, o.payment_status,
                 o.channel, o.shipping_method, o.shipping_service_name, o.shipping_cost, o.address,
                 o.subtotal, o.discount, o.voucher_code, o.voucher_discount, o.insurance_fee,
                 o.tax, o.total, o.dp_amount, o.notes, o.paid_at, o.shipped_at, o.completed_at,
                 o.cancelled_at, o.expires_at, o.created_at,
                 c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
          FROM awcms_commerce_orders o
          JOIN awcms_commerce_customers c ON c.id = o.customer_id
          WHERE o.tenant_id = ${tenantId} AND o.order_code = ${where.orderCode} AND o.deleted_at IS NULL
        `) as OrderHeaderRow[]);

  const header = headerRows[0];
  if (!header) return null;

  const itemRows = (await tx`
    SELECT product_id, variant_id, name, variant_name, sku, unit_price, quantity, line_total, service_form_values
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${header.id} AND deleted_at IS NULL
    ORDER BY created_at ASC
  `) as OrderItemRow[];

  const eventRows = (await tx`
    SELECT from_status, to_status, note, created_at
    FROM awcms_commerce_order_events
    WHERE tenant_id = ${tenantId} AND order_id = ${header.id}
    ORDER BY created_at ASC
  `) as OrderEventRow[];

  const confirmationRows = (await tx`
    SELECT id, method, amount, bank_name, account_name, status, created_at
    FROM awcms_commerce_payment_confirmations
    WHERE tenant_id = ${tenantId} AND order_id = ${header.id} AND deleted_at IS NULL
    ORDER BY created_at ASC
  `) as PaymentConfirmationRow[];

  const productIds = [...new Set(itemRows.map((item) => item.product_id))];
  const imageRows = await listLiveProductImagesByProductIds(
    tx,
    tenantId,
    productIds
  );
  const firstImageMediaIdByProduct = new Map<string, string>();
  for (const image of imageRows) {
    if (!firstImageMediaIdByProduct.has(image.product_id)) {
      firstImageMediaIdByProduct.set(image.product_id, image.media_object_id);
    }
  }
  const mediaIds = [...new Set(firstImageMediaIdByProduct.values())];
  const resolvedMedia =
    mediaIds.length > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, mediaIds)
      : new Map<string, ResolvedMediaReferenceDTO>();

  return {
    id: header.id,
    orderCode: header.order_code,
    customerId: header.customer_id,
    status: header.status as OrderStatus,
    paymentMethod: header.payment_method,
    paymentStatus: header.payment_status,
    channel: header.channel,
    shippingMethod: header.shipping_method,
    shippingServiceName: header.shipping_service_name,
    shippingCost: normalizeMoney(header.shipping_cost),
    address: header.address,
    subtotal: normalizeMoney(header.subtotal),
    discount: normalizeMoney(header.discount),
    voucherCode: header.voucher_code,
    voucherDiscount: normalizeMoney(header.voucher_discount),
    insuranceFee: normalizeMoney(header.insurance_fee),
    tax: normalizeMoney(header.tax),
    total: normalizeMoney(header.total),
    dpAmount:
      header.dp_amount !== null ? normalizeMoney(header.dp_amount) : null,
    notes: header.notes,
    paidAt: header.paid_at?.toISOString() ?? null,
    shippedAt: header.shipped_at?.toISOString() ?? null,
    completedAt: header.completed_at?.toISOString() ?? null,
    cancelledAt: header.cancelled_at?.toISOString() ?? null,
    expiresAt: header.expires_at?.toISOString() ?? null,
    createdAt: header.created_at.toISOString(),
    customer: {
      name: header.customer_name,
      phone: header.customer_phone,
      email: header.customer_email
    },
    lines: itemRows.map((item) => {
      const mediaObjectId = firstImageMediaIdByProduct.get(item.product_id);
      const resolved = mediaObjectId
        ? resolvedMedia.get(mediaObjectId)
        : undefined;
      return {
        productId: item.product_id,
        variantId: item.variant_id,
        name: item.name,
        variantName: item.variant_name,
        sku: item.sku,
        unitPrice: normalizeMoney(item.unit_price),
        quantity: item.quantity,
        lineTotal: normalizeMoney(item.line_total),
        serviceFormValues: item.service_form_values,
        image: resolved
          ? { url: resolved.publicUrl, alt: resolved.altText ?? item.name }
          : null
      };
    }),
    timeline: eventRows.map((event) => ({
      status: event.to_status,
      at: event.created_at.toISOString(),
      note: event.note
    })),
    paymentConfirmations: confirmationRows.map((row) => ({
      id: row.id,
      method: row.method,
      amount: normalizeMoney(row.amount),
      bankName: row.bank_name,
      accountName: row.account_name,
      status: row.status,
      submittedAt: row.created_at.toISOString()
    }))
  };
}

// ---------------------------------------------------------------------------
// Public (anonymous) read model — GET .../orders/{orderCode}?phone=
// ---------------------------------------------------------------------------

export type PublicOrderRecord = {
  orderCode: string;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string;
  /** Issue #116 (contract #106 D6) — `"storefront"` for every order created before #116 landed. */
  channel: string;
  shippingMethod: string;
  shippingServiceName: string | null;
  customer: { name: string; phoneMasked: string; email: string | null };
  address:
    (Omit<OrderAddressSnapshot, "phone"> & { phoneMasked: string }) | null;
  lines: {
    name: string;
    variantName: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
    image: { url: string; alt: string } | null;
    serviceFormValues: Record<string, string> | null;
  }[];
  subtotal: string;
  discount: string;
  voucherCode: string | null;
  shippingCost: string;
  insuranceFee: string;
  tax: string;
  total: string;
  downPayment: { amount: string; paid: boolean } | null;
  paymentInstructions: {
    method: string;
    qrisImage: { url: string } | null;
    banks: { bankName: string; accountNumber: string; accountName: string }[];
    amountDue: string;
    expiresAt: string | null;
    proofUpload: boolean;
  } | null;
  paymentConfirmations: {
    id: string;
    method: string;
    amount: string;
    status: string;
    submittedAt: string;
  }[];
  timeline: { status: string; at: string; note: string | null }[];
  canCancel: boolean;
  canConfirmPayment: boolean;
  canReview: boolean;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  whatsapp: { number: string; text: string };
};

function buildWhatsapp(
  storeName: string,
  whatsapp: string | null,
  orderCode: string
): { number: string; text: string } {
  const digits = (whatsapp ?? "").replace(/\D/g, "");
  const number = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return {
    number,
    text: `Halo ${storeName}, saya ingin menanyakan pesanan ${orderCode}`
  };
}

export async function toPublicOrderRecord(
  tx: Bun.SQL,
  tenantId: string,
  detail: OrderDetail
): Promise<PublicOrderRecord> {
  const settings = await fetchStoreSettings(tx, tenantId);
  const payable = isOrderPayable(detail.status);

  const paymentInstructions = payable
    ? {
        method: detail.paymentMethod,
        qrisImage: null, // Media resolution for the QRIS image is intentionally
        // deferred — this increment never resolves
        // `payment.manualQris.mediaObjectId` to a public URL from the order
        // path (it is owner-only data, `store-settings-directory.ts`'s
        // header); a storefront reads the QRIS image from the public
        // store-settings read model instead.
        banks: settings.payment.manualBank.active
          ? settings.payment.manualBank.accounts.map((account) => ({
              bankName: account.bankName,
              accountNumber: account.accountNumber,
              accountName: account.accountHolder
            }))
          : [],
        amountDue: detail.total,
        expiresAt: detail.expiresAt,
        proofUpload: false
      }
    : null;

  return {
    orderCode: detail.orderCode,
    status: detail.status,
    paymentStatus: detail.paymentStatus,
    paymentMethod: detail.paymentMethod,
    channel: detail.channel,
    shippingMethod: detail.shippingMethod,
    shippingServiceName: detail.shippingServiceName,
    customer: {
      name: detail.customer.name,
      phoneMasked: maskPhone(detail.customer.phone),
      email: detail.customer.email
    },
    address: detail.address
      ? {
          recipientName: detail.address.recipientName,
          phoneMasked: maskPhone(detail.address.phone),
          provinceCode: detail.address.provinceCode,
          provinceName: detail.address.provinceName,
          cityCode: detail.address.cityCode,
          cityName: detail.address.cityName,
          districtCode: detail.address.districtCode,
          districtName: detail.address.districtName,
          postalCode: detail.address.postalCode,
          street: detail.address.street,
          latitude: detail.address.latitude,
          longitude: detail.address.longitude,
          notes: detail.address.notes
        }
      : null,
    lines: detail.lines.map((line) => ({
      name: line.name,
      variantName: line.variantName,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      image: line.image,
      serviceFormValues: line.serviceFormValues
    })),
    subtotal: detail.subtotal,
    discount: detail.discount,
    voucherCode: detail.voucherCode,
    shippingCost: detail.shippingCost,
    insuranceFee: detail.insuranceFee,
    tax: detail.tax,
    total: detail.total,
    downPayment:
      detail.dpAmount !== null
        ? {
            amount: detail.dpAmount,
            paid:
              detail.paymentStatus === "dp_paid" ||
              detail.paymentStatus === "paid"
          }
        : null,
    paymentInstructions,
    paymentConfirmations: detail.paymentConfirmations.map((confirmation) => ({
      id: confirmation.id,
      method: confirmation.method,
      amount: confirmation.amount,
      status: confirmation.status,
      submittedAt: confirmation.submittedAt
    })),
    timeline: detail.timeline,
    canCancel: isOrderCancellableByCustomer(detail.status),
    canConfirmPayment: payable,
    canReview: isOrderReviewable(detail.status),
    createdAt: detail.createdAt,
    expiresAt: detail.expiresAt,
    paidAt: detail.paidAt,
    shippedAt: detail.shippedAt,
    completedAt: detail.completedAt,
    cancelledAt: detail.cancelledAt,
    whatsapp: buildWhatsapp(
      settings.storeName,
      settings.whatsapp,
      detail.orderCode
    )
  };
}

/**
 * The tracking lookup — `orderCode` + `phone` is the credential, and the
 * check happens INSIDE this query (not merely in the route's `prepare`):
 * unknown code, wrong phone, and another tenant's order all fall through to
 * the same `null`, which the route maps to one neutral `404`.
 */
export async function fetchOrderForTracking(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string
): Promise<PublicOrderRecord | null> {
  const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    orderCode
  });
  if (!detail || detail.customer.phone !== phone) return null;
  return toPublicOrderRecord(tx, tenantId, detail);
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

export type CreateOrderOutcome =
  | { kind: "replayed"; order: PublicOrderRecord }
  | { kind: "created"; order: PublicOrderRecord }
  /**
   * Issue #107 — also covers a `shipping.method: "courier"` selection whose
   * `{serviceId, cost}` does not match a non-expired
   * `awcms_commerce_shipping_rates` cache row (unknown service, rate
   * expired since the quote that offered it, or no cache row at all):
   * `quote.shipping` stays `null`, exactly like any other stale
   * price/stock/shipping mismatch, and the route answers the SAME
   * `409 CART_CHANGED` with a fresh quote — never a bespoke `400` (contract
   * alignment with `apps/storefront`'s #109, which only ever handles
   * `CART_CHANGED` for a stale shipping selection).
   */
  | { kind: "cart_changed"; quote: CartQuoteResult }
  | { kind: "invalid_phone" };

async function insertOrderWithRetryableCode(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  input: CreateOrderInput,
  quote: CartQuoteResult,
  now: Date,
  expiresAt: Date,
  affiliateId: string | null
): Promise<OrderHeaderRow> {
  const addressJson = input.address
    ? {
        recipientName: input.address.recipientName,
        phone: input.address.phone,
        provinceCode: input.address.provinceCode,
        provinceName: input.address.provinceName,
        cityCode: input.address.cityCode,
        cityName: input.address.cityName,
        districtCode: input.address.districtCode,
        districtName: input.address.districtName,
        postalCode: input.address.postalCode,
        street: input.address.street,
        latitude: input.address.latitude,
        longitude: input.address.longitude,
        notes: input.address.notes
      }
    : null;

  const dpAmount =
    input.payment.method === "dp" && quote.downPayment.available
      ? quote.downPayment.amount
      : null;

  for (let attempt = 0; attempt < MAX_ORDER_CODE_ATTEMPTS; attempt += 1) {
    const orderCode = generateOrderCode(now);
    try {
      const rows = (await tx`
        INSERT INTO awcms_commerce_orders (
          tenant_id, order_code, customer_id, status, payment_method, payment_status,
          shipping_method, shipping_service_name, shipping_cost, address,
          subtotal, discount, voucher_code, voucher_discount, insurance_fee, tax, total,
          dp_amount, notes, expires_at, affiliate_id
        )
        VALUES (
          ${tenantId}, ${orderCode}, ${customerId}, 'pending_payment', ${input.payment.method}, 'unpaid',
          ${quote.shipping?.method ?? input.shipping?.method ?? "self_pickup"},
          ${quote.shipping?.name ?? null}, ${quote.shipping?.cost ?? "0.00"}, ${addressJson}::jsonb,
          ${quote.subtotal}, ${quote.discount}, ${quote.voucher?.code ?? null},
          ${quote.voucher?.valid ? quote.voucher.discount : "0.00"},
          ${quote.insurance.fee}, ${quote.tax.amount}, ${quote.total},
          ${dpAmount}, ${input.notes}, ${expiresAt}, ${affiliateId}
        )
        RETURNING id, order_code, customer_id, status, payment_method, payment_status,
                  shipping_method, shipping_service_name, shipping_cost, address,
                  subtotal, discount, voucher_code, voucher_discount, insurance_fee, tax, total,
                  dp_amount, notes, paid_at, shipped_at, completed_at, cancelled_at, expires_at, created_at
      `) as Omit<
        OrderHeaderRow,
        "customer_name" | "customer_phone" | "customer_email"
      >[];

      return {
        ...rows[0]!,
        // Every order `createOrderFromCart` inserts is `channel: "storefront"`
        // (the column's own DEFAULT, Issue #116/sql/931) — never re-selected
        // here since nothing downstream in THIS function reads it; the real
        // stored value is what `fetchOrderDetailByWhere` returns later.
        channel: "storefront",
        customer_name: "",
        customer_phone: "",
        customer_email: null
      };
    } catch (error) {
      const isCollision =
        error instanceof Bun.SQL.PostgresError &&
        String(error.errno) === POSTGRES_UNIQUE_VIOLATION &&
        error.constraint === ORDER_CODE_CONSTRAINT;
      if (!isCollision || attempt === MAX_ORDER_CODE_ATTEMPTS - 1) throw error;
    }
  }

  throw new Error("Failed to generate a unique order code.");
}

/**
 * `POST …/storefront/orders`. Re-quotes the cart INSIDE this transaction
 * (never trusts a price the client sent, there is none to send — ADR-0003 +
 * the storefront contract) and fails closed with `cart_changed` on anything
 * that no longer validates, rather than guessing at the client's intent.
 */
export async function createOrderFromCart(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  input: CreateOrderInput,
  now: Date = new Date(),
  correlationId?: string,
  /**
   * Issue #91 — set by the route ONLY after a valid bearer session was
   * presented (`requireCustomerSession`). When present, the order's
   * customer is that account's OWN customer row — the phone the shopper
   * typed at checkout is still validated for shape (the route already did
   * that before calling here) but is otherwise IGNORED for identity
   * purposes, per the contract's own "ignore any phone-based lookup for the
   * customer identity" rule; `findOrCreateCustomerByPhone` (which would
   * create a SECOND, unrelated guest row for the same phone if it differs
   * from the account's own) is never called in this branch.
   */
  accountCustomerId?: string
): Promise<CreateOrderOutcome> {
  const requestHash = computeRequestHash({
    action: IDEMPOTENCY_SCOPE,
    customer: input.customer,
    address: input.address,
    lines: input.lines,
    shipping: input.shipping,
    payment: input.payment,
    voucherCode: input.voucherCode,
    insurance: input.insurance,
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
      order: existing.responseBody as PublicOrderRecord
    };
  }

  const phoneResult = normalizePhoneNumber(input.customer.phone);
  if (!phoneResult.valid) return { kind: "invalid_phone" };
  const normalizedPhone = phoneResult.value;

  // Issue #118 — the level lookup happens BEFORE the re-quote (not after,
  // as `customer` used to be fetched) so `buildCartQuote` can price this
  // line the SAME `price_level_{n}` the shopper's own earlier
  // `POST .../cart/quote` call already showed them — a bearer customer's
  // quote and their order must never disagree on price. Guest checkouts
  // (`accountCustomerId` absent) always price at level 1 (ordinary retail):
  // there is no account yet to carry a level, and `findOrCreateCustomerByPhone`
  // below always creates one at the schema default (`level = 1`, `sql/913`).
  const accountCustomer = accountCustomerId
    ? await fetchCustomerById(tx, tenantId, accountCustomerId)
    : null;
  const customerLevel =
    accountCustomer && accountCustomer.level >= 1 && accountCustomer.level <= 4
      ? (accountCustomer.level as 1 | 2 | 3 | 4)
      : null;

  const quote = await buildCartQuote(
    tx,
    tenantId,
    mediaPort,
    {
      lines: input.lines,
      shipping: input.shipping,
      voucherCode: input.voucherCode,
      insurance: input.insurance,
      // Issue #107 — the re-quote inside THIS write transaction never calls
      // a live provider (no `providerSql` argument below): a chosen
      // courier option is only ever honoured against an ALREADY-cached
      // rate, keyed off the delivery address's own district code.
      destination: input.address
        ? { districtCode: input.address.districtCode }
        : null,
      customerLevel
    },
    now
  );

  const paymentAvailable = quote.paymentMethods.some(
    (method) => method.method === input.payment.method && method.available
  );
  const shippingResolved = input.shipping === null || quote.shipping !== null;

  if (!quote.canCheckout || !paymentAvailable || !shippingResolved) {
    return { kind: "cart_changed", quote };
  }

  const settings = await fetchStoreSettings(tx, tenantId);
  const expiresAt = new Date(
    now.getTime() + settings.orders.expiryHours * 60 * 60 * 1000
  );

  const customer = accountCustomer
    ? accountCustomer
    : await findOrCreateCustomerByPhone(
        tx,
        tenantId,
        input.customer.name,
        normalizedPhone,
        input.customer.email,
        correlationId
      );

  // Issue #92 — unknown/suspended `?ref=` code resolves to `null`, never an
  // error: a bad referral code must never block a checkout.
  const affiliateId = await resolveAffiliateForOrder(
    tx,
    tenantId,
    input.affiliateCode
  );

  const header = await insertOrderWithRetryableCode(
    tx,
    tenantId,
    customer.id,
    input,
    quote,
    now,
    expiresAt,
    affiliateId
  );

  // Sequential — one reserved `tx` connection (`tenant-route.ts`'s header).
  for (const line of quote.lines) {
    await tx`
      INSERT INTO awcms_commerce_order_items (
        tenant_id, order_id, product_id, variant_id, flash_sale_id,
        name, variant_name, sku, unit_price, quantity, weight_grams,
        service_form_values, line_total
      )
      VALUES (
        ${tenantId}, ${header.id}, ${line.productId}, ${line.variantId}, ${line.flashSaleId},
        ${line.name}, ${line.variantName}, ${line.sku}, ${line.unitPrice}, ${line.quantity},
        ${line.weightGrams}, ${line.serviceFormValues}::jsonb, ${line.lineTotal}
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

  if (quote.voucher?.valid) {
    await tx`
      UPDATE awcms_commerce_vouchers
      SET used_count = used_count + 1, updated_at = now()
      WHERE tenant_id = ${tenantId} AND code = ${quote.voucher.code} AND deleted_at IS NULL
    `;

    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_VOUCHER_REDEEMED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_VOUCHER_AGGREGATE_TYPE,
      aggregateId: header.id,
      producerModule: PRODUCER_MODULE,
      correlationId,
      payload: { orderCode: header.order_code, voucherCode: quote.voucher.code }
    });
  }

  await tx`
    INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor)
    VALUES (${tenantId}, ${header.id}, NULL, 'pending_payment', 'customer')
  `;

  if (input.address) {
    await saveCustomerAddress(tx, tenantId, customer.id, {
      label: null,
      recipientName: input.address.recipientName,
      phone: input.address.phone,
      provinceCode: input.address.provinceCode,
      provinceName: input.address.provinceName,
      cityCode: input.address.cityCode,
      cityName: input.address.cityName,
      districtCode: input.address.districtCode,
      districtName: input.address.districtName,
      postalCode: input.address.postalCode,
      street: input.address.street,
      latitude: input.address.latitude,
      longitude: input.address.longitude,
      notes: input.address.notes
    });
  }

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: header.id,
    message: `Order ${header.order_code} created via storefront checkout.`,
    attributes: { orderCode: header.order_code, total: quote.total },
    correlationId
  });

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_ORDER_CREATED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: header.id,
    producerModule: PRODUCER_MODULE,
    correlationId,
    payload: {
      orderId: header.id,
      orderCode: header.order_code,
      total: quote.total
    }
  });

  const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    id: header.id
  });
  const publicRecord = await toPublicOrderRecord(tx, tenantId, detail!);

  await saveIdempotencyRecord(
    tx,
    tenantId,
    IDEMPOTENCY_SCOPE,
    input.idempotencyKey,
    requestHash,
    201,
    publicRecord
  );

  return { kind: "created", order: publicRecord };
}

// ---------------------------------------------------------------------------
// Payment confirmations
// ---------------------------------------------------------------------------

export async function createPaymentConfirmation(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string,
  input: {
    method: "manual_bank" | "manual_qris";
    amount: string;
    bankName: string | null;
    accountName: string | null;
    transferredAt: string | null;
    proofMediaObjectId: string | null;
  },
  correlationId?: string
): Promise<PublicOrderRecord | null> {
  const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    orderCode
  });
  if (!detail || detail.customer.phone !== phone) return null;

  if (!isOrderPayable(detail.status)) {
    throw new OrderNotPayableError();
  }

  await tx`
    INSERT INTO awcms_commerce_payment_confirmations (
      tenant_id, order_id, method, amount, bank_name, account_name,
      transferred_at, proof_media_object_id
    )
    VALUES (
      ${tenantId}, ${detail.id}, ${input.method}, ${input.amount}, ${input.bankName}, ${input.accountName},
      ${input.transferredAt}, ${input.proofMediaObjectId}
    )
  `;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "create",
    resourceType: "payment_confirmation",
    resourceId: detail.id,
    message: `Payment confirmation submitted for order ${detail.orderCode}.`,
    attributes: {
      orderCode: detail.orderCode,
      method: input.method,
      amount: input.amount
    },
    correlationId
  });

  const refreshed = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    orderCode
  });
  return toPublicOrderRecord(tx, tenantId, refreshed!);
}

/** Admin accept/reject of a payment confirmation — also drives the order's own status when accepted. */
export async function reviewPaymentConfirmation(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  confirmationId: string,
  decision: "accepted" | "rejected",
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_commerce_payment_confirmations
    SET status = ${decision}, reviewed_by = ${actorTenantUserId}, reviewed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${confirmationId} AND order_id = ${orderId}
      AND deleted_at IS NULL AND status = 'submitted'
    RETURNING id, amount
  `) as { id: string; amount: string }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: "payment_confirmation",
    resourceId: confirmationId,
    message: `Payment confirmation ${decision} by admin.`,
    attributes: { orderId, decision },
    correlationId
  });

  if (decision === "accepted") {
    // Only drives the order's own status while it is still awaiting payment
    // — accepting a SECOND confirmation on an order already moved past
    // `pending_payment` (e.g. a DP top-up confirmation after the order was
    // already marked `paid`) records the acceptance without attempting an
    // illegal same-status/backwards transition, which would otherwise throw
    // and roll back the acceptance itself.
    const orderRows = (await tx`
      SELECT status FROM awcms_commerce_orders
      WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
    `) as { status: string }[];

    if (orderRows[0]?.status === "pending_payment") {
      await transitionOrderStatus(
        tx,
        tenantId,
        actorTenantUserId,
        "admin",
        orderId,
        "paid",
        "Payment confirmation accepted.",
        correlationId
      );
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Status transitions (cancel / admin status / system expiry)
// ---------------------------------------------------------------------------

async function transitionOrderStatus(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string | undefined,
  actor: OrderStatusActor,
  orderId: string,
  to: OrderStatus,
  note: string | null,
  correlationId?: string
): Promise<OrderHeaderRow | null> {
  const rows = (await tx`
    SELECT status, order_code FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as { status: string; order_code: string }[];
  const current = rows[0];
  if (!current) return null;

  const from = current.status as OrderStatus;
  const transition = applyOrderStatusTransition(actor, from, to);
  if (!transition.valid) {
    throw new IllegalOrderStatusTransitionError(transition.errors);
  }

  const timestampColumn: Partial<
    Record<
      OrderStatus,
      "paid_at" | "shipped_at" | "completed_at" | "cancelled_at"
    >
  > = {
    paid: "paid_at",
    shipped: "shipped_at",
    completed: "completed_at",
    cancelled: "cancelled_at"
  };
  const column = timestampColumn[to];

  const paymentStatus = to === "paid" ? "paid" : undefined;

  // `column` is drawn from the fixed 4-entry `timestampColumn` map above —
  // never user input — so splicing its NAME via `tx.unsafe` here is safe;
  // the VALUE that column gets (`now()`) is a SQL literal, not a bound
  // parameter, since every one of these four columns is a plain stamp.
  const timestampSetSql = column ? `${column} = now(),` : "";

  const updated = (await tx`
    UPDATE awcms_commerce_orders
    SET status = ${to},
        payment_status = COALESCE(${paymentStatus ?? null}, payment_status),
        ${tx.unsafe(timestampSetSql)}
        updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
    RETURNING order_code
  `) as { order_code: string }[];

  await tx`
    INSERT INTO awcms_commerce_order_events (tenant_id, order_id, from_status, to_status, actor, note)
    VALUES (${tenantId}, ${orderId}, ${from}, ${to}, ${actor}, ${note})
  `;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: orderId,
    message: `Order ${current.order_code} moved ${from} -> ${to} (${actor}).`,
    attributes: { orderCode: current.order_code, from, to, actor },
    correlationId
  });

  const eventPayload = { orderId, orderCode: current.order_code, from, to };

  if (to === "paid") {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
      aggregateId: orderId,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: eventPayload
    });
  } else if (to === "cancelled") {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
      aggregateId: orderId,
      producerModule: PRODUCER_MODULE,
      correlationId,
      actorTenantUserId,
      payload: eventPayload
    });
    await restockCancelledOrRefreshedOrder(tx, tenantId, orderId);
    // Issue #92 — a defensive no-op under the current order-status graph
    // (`completed` has no outgoing edge), kept for a future
    // refund/cancel-after-completion path. See `affiliate-directory.ts`'s
    // `voidAffiliateCommissionForOrder` header.
    await voidAffiliateCommissionForOrder(tx, tenantId, orderId, correlationId);
  } else if (to === "completed") {
    // Issue #92 (contract #86's D5) — the ONE place a commission is ever
    // created: the moment the referenced order reaches `completed`. No-op
    // when the order carries no affiliate, or on self-referral/a suspended
    // affiliate (`affiliate-directory.ts`'s own gates).
    await recordAffiliateCommissionOnOrderCompleted(
      tx,
      tenantId,
      orderId,
      correlationId
    );
  } else if (to === "expired") {
    await appendDomainEvent(tx, tenantId, {
      eventType: COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
      eventVersion: COMMERCE_EVENT_VERSION,
      aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
      aggregateId: orderId,
      producerModule: PRODUCER_MODULE,
      payload: eventPayload
    });
    await restockCancelledOrRefreshedOrder(tx, tenantId, orderId);
  }

  await appendDomainEvent(tx, tenantId, {
    eventType: COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
    eventVersion: COMMERCE_EVENT_VERSION,
    aggregateType: COMMERCE_ORDER_AGGREGATE_TYPE,
    aggregateId: orderId,
    producerModule: PRODUCER_MODULE,
    correlationId,
    actorTenantUserId,
    payload: eventPayload
  });

  return updated.length > 0
    ? ({ order_code: updated[0]!.order_code } as OrderHeaderRow)
    : null;
}

/** Restocks every line of a cancelled/expired order and un-redeems its voucher, if any. */
async function restockCancelledOrRefreshedOrder(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string
): Promise<void> {
  const items = (await tx`
    SELECT product_id, variant_id, quantity, flash_sale_id
    FROM awcms_commerce_order_items
    WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND deleted_at IS NULL
  `) as {
    product_id: string;
    variant_id: string | null;
    quantity: number;
    flash_sale_id: string | null;
  }[];

  for (const item of items) {
    if (item.variant_id) {
      await tx`
        UPDATE awcms_commerce_product_variants
        SET stock = stock + ${item.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${item.variant_id}
      `;
    } else {
      await tx`
        UPDATE awcms_commerce_products
        SET stock = stock + ${item.quantity}, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${item.product_id}
      `;
    }

    if (item.flash_sale_id) {
      await tx`
        UPDATE awcms_commerce_flash_sale_products
        SET sold = GREATEST(sold - ${item.quantity}, 0), updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND flash_sale_id = ${item.flash_sale_id}
          AND product_id = ${item.product_id}
          AND variant_id IS NOT DISTINCT FROM ${item.variant_id}
      `;
    }
  }

  const orderRows = (await tx`
    SELECT voucher_code FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId}
  `) as { voucher_code: string | null }[];
  const voucherCode = orderRows[0]?.voucher_code;

  if (voucherCode) {
    await tx`
      UPDATE awcms_commerce_vouchers
      SET used_count = GREATEST(used_count - 1, 0), updated_at = now()
      WHERE tenant_id = ${tenantId} AND code = ${voucherCode}
    `;
  }
}

/** `POST …/storefront/orders/{orderCode}/cancel` — customer-initiated. */
export async function cancelOrderByCustomer(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderCode: string,
  phone: string,
  reason: string | null,
  correlationId?: string
): Promise<PublicOrderRecord | null> {
  const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    orderCode
  });
  if (!detail || detail.customer.phone !== phone) return null;

  if (!isOrderCancellableByCustomer(detail.status)) {
    throw new OrderNotCancellableError();
  }

  await transitionOrderStatus(
    tx,
    tenantId,
    undefined,
    "customer",
    detail.id,
    "cancelled",
    reason,
    correlationId
  );

  const refreshed = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    orderCode
  });
  return toPublicOrderRecord(tx, tenantId, refreshed!);
}

/** Admin status change — `PATCH .../orders/{id}/status`. */
export async function updateOrderStatusByAdmin(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  to: OrderStatus,
  note: string | null,
  correlationId?: string
): Promise<boolean> {
  const result = await transitionOrderStatus(
    tx,
    tenantId,
    actorTenantUserId,
    "admin",
    orderId,
    to,
    note,
    correlationId
  );
  return result !== null;
}

/**
 * `createPosOrder` (Issue #116, `application/pos-directory.ts`)'s own call
 * to move its freshly-inserted `pending_payment` counter sale straight to
 * `paid` — reuses the SAME `transitionOrderStatus` every other admin status
 * change goes through (status timestamp, `order_events` row, audit event,
 * `COMMERCE_ORDER_PAID_EVENT_TYPE`/`COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE`
 * domain events), rather than `pos-directory.ts` hand-rolling a second copy
 * of that bookkeeping. Actor is always `"admin"` — a POS sale is staff-rung,
 * never `"customer"`/`"system"` — with `actorTenantUserId` carrying WHICH
 * staff member (the audit trail's own actor column; `order_events.actor`
 * itself only ever records the role, see `sql/913`'s own table header).
 */
export async function applyPosOrderPaidTransition(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  orderId: string,
  correlationId?: string
): Promise<void> {
  await transitionOrderStatus(
    tx,
    tenantId,
    actorTenantUserId,
    "admin",
    orderId,
    "paid",
    "POS counter sale — paid at the register.",
    correlationId
  );
}

/** `commerce:orders:expire` job's own per-order call — see `scripts/commerce-orders-expire.ts`. */
export async function expireOrderBySystem(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  correlationId?: string
): Promise<void> {
  await transitionOrderStatus(
    tx,
    tenantId,
    undefined,
    "system",
    orderId,
    "expired",
    "Payment window elapsed.",
    correlationId
  );
}

/**
 * `markOrderPaidBySystem` (Issue #113, contract #106's D2/D3) — the ONE
 * place the payment-gateway webhook intake route
 * (`src/pages/api/v1/commerce/webhooks/[provider]/[endpointToken].ts`) and
 * the `commerce:payments:reconcile` job apply a verified gateway "paid"
 * outcome to an order. Actor is always `"system"` — never the gateway's own
 * identity, which this platform does not model as a principal.
 *
 * Idempotent by construction, for two independent replay paths:
 *
 * 1. The webhook route's own `INSERT … ON CONFLICT DO NOTHING` on
 *    `awcms_commerce_payment_events` already turns a REDELIVERED callback
 *    into a no-op before this function is ever called a second time for the
 *    same `eventKey`.
 * 2. This function ALSO checks the order's own current status first and
 *    returns `{ applied: false, reason: "already_paid" }` without writing
 *    anything when it is already `"paid"` — the second independent guard
 *    contract #106 asks for, covering a genuinely concurrent webhook +
 *    reconcile race (both read `pending_payment` before either commits is
 *    impossible under `transitionOrderStatus`'s row lock via the UPDATE …
 *    WHERE, but the SELECT this function does first is not itself
 *    serialising, so a caller must not assume the FIRST check alone is
 *    race-free — it is a fast path, not the sole guard).
 *
 * An order found in any status OTHER than `pending_payment`/`paid` (e.g.
 * `cancelled`, `expired`) is also a no-op, never a thrown error — a gateway
 * confirming payment for an order the shop already cancelled is an
 * out-of-band race this function must absorb quietly (the payment EVENT
 * itself is still recorded by the caller either way; this function is only
 * ever reached once that record already exists).
 *
 * `gateway_provider`/`gateway_ref` (`sql/926`) are stamped on the order row
 * in the SAME transaction the status transition runs in, so an admin
 * reading the order detail screen's payment panel always sees a consistent
 * pair.
 */
export type MarkOrderPaidBySystemInput = {
  provider: string;
  providerRef: string;
  /** `awcms_commerce_payment_events.event_key` — carried through only for the audit message/correlation, never re-checked here (the caller's own `ON CONFLICT DO NOTHING` already did that). */
  eventKey: string;
};

export type MarkOrderPaidBySystemResult =
  | { applied: true }
  | { applied: false; reason: "already_paid" | "not_payable" };

export async function markOrderPaidBySystem(
  tx: Bun.SQL,
  tenantId: string,
  orderId: string,
  gateway: MarkOrderPaidBySystemInput,
  correlationId?: string
): Promise<MarkOrderPaidBySystemResult> {
  const rows = (await tx`
    SELECT status FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `) as { status: string }[];
  const current = rows[0];
  if (!current) return { applied: false, reason: "not_payable" };

  if (current.status === "paid") {
    return { applied: false, reason: "already_paid" };
  }
  if (current.status !== "pending_payment") {
    return { applied: false, reason: "not_payable" };
  }

  await tx`
    UPDATE awcms_commerce_orders
    SET gateway_provider = ${gateway.provider}, gateway_ref = ${gateway.providerRef}
    WHERE tenant_id = ${tenantId} AND id = ${orderId} AND deleted_at IS NULL
  `;

  await transitionOrderStatus(
    tx,
    tenantId,
    undefined,
    "system",
    orderId,
    "paid",
    `Payment confirmed by ${gateway.provider} (ref ${gateway.providerRef}, event ${gateway.eventKey}).`,
    correlationId
  );

  return { applied: true };
}

/** Every `pending_payment` order in `tenantId` whose `expires_at` has passed — the expiry job's own scan. */
export async function listExpirableOrderIds(
  tx: Bun.SQL,
  tenantId: string,
  now: Date,
  limit = 500
): Promise<string[]> {
  const rows = (await tx`
    SELECT id FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId} AND status = 'pending_payment' AND expires_at IS NOT NULL AND expires_at <= ${now}
    ORDER BY expires_at ASC
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `) as { id: string }[];
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Admin surface — list / detail
// ---------------------------------------------------------------------------

export type OrderAdminSummary = {
  id: string;
  orderCode: string;
  status: OrderStatus;
  paymentStatus: string;
  customerName: string;
  customerPhoneMasked: string;
  total: string;
  createdAt: string;
};

export type OrderAdminListPage = {
  items: OrderAdminSummary[];
  nextCursor: string | null;
};

export async function listOrdersForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  cursor: KeysetCursor | null,
  filters: { status?: OrderStatus; paymentStatus?: string } = {}
): Promise<OrderAdminListPage> {
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;
  const statusParam = filters.status ?? null;
  const paymentStatusParam = filters.paymentStatus ?? null;

  const rows = (await tx`
    SELECT o.id, o.order_code, o.status, o.payment_status, o.total, o.created_at,
           c.name AS customer_name, c.phone AS customer_phone,
           ${tx.unsafe(keysetCursorCreatedAtSql("o"))} AS created_at_cursor
    FROM awcms_commerce_orders o
    JOIN awcms_commerce_customers c ON c.id = o.customer_id
    WHERE o.tenant_id = ${tenantId}
      AND o.deleted_at IS NULL
      AND (${statusParam}::text IS NULL OR o.status = ${statusParam})
      AND (${paymentStatusParam}::text IS NULL OR o.payment_status = ${paymentStatusParam})
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (o.created_at, o.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${ORDER_LIST_LIMIT}
  `) as {
    id: string;
    order_code: string;
    status: string;
    payment_status: string;
    total: string;
    created_at: Date;
    customer_name: string;
    customer_phone: string;
    created_at_cursor: string;
  }[];

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === ORDER_LIST_LIMIT && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      orderCode: row.order_code,
      status: row.status as OrderStatus,
      paymentStatus: row.payment_status,
      customerName: row.customer_name,
      customerPhoneMasked: maskPhone(row.customer_phone),
      total: normalizeMoney(row.total),
      createdAt: row.created_at.toISOString()
    })),
    nextCursor
  };
}

/**
 * Admin detail view — the same shape `toPublicOrderRecord` builds, with the
 * customer's/address's phone UNMASKED (owner/staff context, not a public
 * read) plus `customerId` so the admin screen can link to the customer
 * record.
 */
export type OrderAdminDetailRecord = PublicOrderRecord & {
  customerId: string;
  customer: PublicOrderRecord["customer"] & { phone: string };
  address: (PublicOrderRecord["address"] & { phone: string }) | null;
};

export async function toAdminOrderRecord(
  tx: Bun.SQL,
  tenantId: string,
  detail: OrderDetail
): Promise<OrderAdminDetailRecord> {
  const publicRecord = await toPublicOrderRecord(tx, tenantId, detail);
  return {
    ...publicRecord,
    customerId: detail.customerId,
    customer: { ...publicRecord.customer, phone: detail.customer.phone },
    address: detail.address
      ? { ...publicRecord.address!, phone: detail.address.phone }
      : null
  };
}

/** Admin detail — unmasked phone (owner/staff context, not a public read). */
export async function fetchOrderDetailForAdmin(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  orderId: string
): Promise<OrderDetail | null> {
  return fetchOrderDetailByWhere(tx, tenantId, mediaPort, { id: orderId });
}

// ---------------------------------------------------------------------------
// commerce:orders:expire — the scheduled job's per-tenant work, mirroring
// `flash-sale-directory.ts`'s `tickFlashSalesForTenant` shape (own
// transaction via `withTenantOrThrow`, `FOR UPDATE SKIP LOCKED` batch,
// bounded per tick, idempotent — an order already moved out of
// `pending_payment` is simply absent from the next scan).
// ---------------------------------------------------------------------------

export type ExpireOrdersResult = { expiredCount: number; partial: boolean };

export async function expireOrdersForTenant(
  sql: Bun.SQL,
  tenantId: string,
  now: Date,
  correlationId?: string,
  batchLimit = 500
): Promise<ExpireOrdersResult> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const orderIds = await listExpirableOrderIds(
        tx,
        tenantId,
        now,
        batchLimit
      );
      for (const orderId of orderIds) {
        await expireOrderBySystem(tx, tenantId, orderId, correlationId);
      }
      return {
        expiredCount: orderIds.length,
        partial: orderIds.length === batchLimit
      };
    },
    { workClass: "background_sync" }
  );
}

/** Stable, non-reversible hash used only to correlate log lines about the same phone without printing it — never sent to a client. */
export function hashPhoneForLogs(phone: string): string {
  return createHash("sha256").update(phone).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Issue #91 (C3) — the account's OWN order history, bearer-secured
// (`account/orders/index.ts`, `account/orders/{orderCode}.ts`). Ownership
// AND the `history_from` window are both enforced INSIDE the query below
// (contract's own requirement) — never merely in the route's `prepare` — so
// an order that predates the account's own history window, or belongs to a
// different customer entirely, is indistinguishable from one that does not
// exist at all.
// ---------------------------------------------------------------------------

export type AccountOrderListPage = {
  items: PublicOrderRecord[];
  nextCursor: string | null;
};

export const ACCOUNT_ORDER_LIST_MAX_LIMIT = 50;
export const ACCOUNT_ORDER_LIST_DEFAULT_LIMIT = 20;

/** `GET /account/orders` — keyset, newest first, `created_at >= historyFrom`. Reuses `toPublicOrderRecord` per row (same shape `GET .../orders/{code}?phone=` returns) rather than a lighter admin-style summary — the contract's own "same list item shape as the tracking endpoint minus nothing sensitive". */
export async function listOrdersForAccount(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  customerId: string,
  historyFrom: Date,
  cursor: KeysetCursor | null,
  limit: number = ACCOUNT_ORDER_LIST_DEFAULT_LIMIT
): Promise<AccountOrderListPage> {
  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    ACCOUNT_ORDER_LIST_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT o.id, ${tx.unsafe(keysetCursorCreatedAtSql("o"))} AS created_at_cursor
    FROM awcms_commerce_orders o
    WHERE o.tenant_id = ${tenantId}
      AND o.customer_id = ${customerId}
      AND o.deleted_at IS NULL
      AND o.created_at >= ${historyFrom}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (o.created_at, o.id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT ${boundedLimit}
  `) as { id: string; created_at_cursor: string }[];

  const items: PublicOrderRecord[] = [];
  for (const row of rows) {
    const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
      id: row.id
    });
    if (detail) items.push(await toPublicOrderRecord(tx, tenantId, detail));
  }

  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { items, nextCursor };
}

/** `GET /account/orders/{orderCode}` — `null` for an unknown code, another customer's order, or one that predates `historyFrom` (all indistinguishable, the route's own neutral `404`). */
export async function fetchOrderForAccount(
  tx: Bun.SQL,
  tenantId: string,
  mediaPort: MediaLibraryPort,
  customerId: string,
  historyFrom: Date,
  orderCode: string
): Promise<PublicOrderRecord | null> {
  const rows = (await tx`
    SELECT id FROM awcms_commerce_orders
    WHERE tenant_id = ${tenantId}
      AND order_code = ${orderCode}
      AND customer_id = ${customerId}
      AND created_at >= ${historyFrom}
      AND deleted_at IS NULL
  `) as { id: string }[];

  const row = rows[0];
  if (!row) return null;

  const detail = await fetchOrderDetailByWhere(tx, tenantId, mediaPort, {
    id: row.id
  });
  if (!detail) return null;

  return toPublicOrderRecord(tx, tenantId, detail);
}
