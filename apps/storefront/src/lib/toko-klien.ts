/**
 * The anonymous cross-origin commerce client — the ONLY file that talks to
 * `<cms>/api/v1/commerce/storefront/*` from the BROWSER, per ADR-0007
 * (revised, issue #30) and the #29⇄#30 contract
 * (`commerce-storefront-endpoints.md` in the manager's scratchpad, which
 * this file follows byte-for-byte: paths, request/response field names, and
 * error codes).
 *
 * This is the deliberate counterpart to `src/lib/awcms/client.ts`
 * (`awcmsGet`): that file runs at BUILD time, on the server, with a bearer
 * token, and never ships to the browser. This file runs IN the browser,
 * anonymously, and is bundled into `src/scripts/*.ts` — never imported from
 * `.astro` frontmatter.
 *
 * ## Every request, the same way, on purpose
 *
 * - `mode: "cors"` — this is a cross-origin request to `PUBLIC_AWCMS_ORIGIN`
 *   (`src/lib/awcms/toko-origin.ts`), never same-origin.
 * - `credentials: "omit"` — no cookie, ever. The CMS resolves the tenant
 *   from the request `Origin` header, which the BROWSER sets and no script
 *   can override; nothing here can accidentally widen that to "on behalf of
 *   a signed-in admin session".
 * - The only request header this file ever sets is `Content-Type:
 *   application/json` on a request that has a body — no `Authorization`
 *   (there is nothing to send; anonymous is the point), no custom header at
 *   all. A "simple" CORS request with no extra headers keeps every route's
 *   `OPTIONS` preflight trivial to answer correctly; a custom header here
 *   would be one more thing the CMS's preflight handler has to echo back in
 *   `Access-Control-Allow-Headers` or the browser drops the real request
 *   with no server-visible trace at all.
 * - `Access-Control-Allow-Credentials` is never set by the CMS (the
 *   contract's own words) and this file never asks for it — `credentials:
 *   "omit"` already means the browser would ignore that header if it were.
 *
 * ## Errors
 *
 * Every non-2xx and every network failure surfaces as one `TokoApiError`
 * carrying the envelope's `code`/`message`/`details` (validation field
 * errors, or a fresh quote on `CART_CHANGED`) — never a bare thrown
 * `Response` or a raw `fetch` rejection, so every caller (`src/scripts/
 * keranjang.ts`, `checkout.ts`, `pesanan.ts`) can `catch` one shape and
 * switch on `.code`.
 *
 * The request/envelope plumbing itself (`kirimPermintaan`, `TokoApiError`)
 * now lives in `src/lib/toko-permintaan.ts` (issue #88), extracted so
 * `src/lib/akun-klien.ts`'s bearer-authenticated `/account/*` calls reuse it
 * rather than duplicating it. This file's own public exports and behaviour
 * are unchanged by that split — see `toko-permintaan.ts`'s own docblock.
 */
import { kirimPermintaan } from "./toko-permintaan";
export { TokoApiError } from "./toko-permintaan";
export type { ValidationErrorDetail } from "./toko-permintaan";

// ---------------------------------------------------------------------------
// Shared shapes — copied field-for-field from commerce-storefront-endpoints.md
// ---------------------------------------------------------------------------

export type CartLineRequest = {
  productId: string;
  variantId: string | null;
  quantity: number;
  serviceFormValues: Record<string, string> | null;
};

export type ShippingSelection =
  | { method: "alternative"; serviceId: string }
  | { method: "self_pickup" }
  | { method: "courier" }
  | null;

export type QuoteRequest = {
  lines: CartLineRequest[];
  shipping: ShippingSelection;
  voucherCode: string | null;
  insurance: boolean;
};

export type CartLineStatus =
  | "ok"
  | "price_changed"
  | "out_of_stock"
  | "quantity_reduced"
  | "unavailable"
  | "min_purchase"
  | "service_form_invalid";

export type QuoteLine = {
  productId: string;
  variantId: string | null;
  slug: string;
  name: string;
  variantName: string | null;
  sku: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  weightGrams: number;
  image: { url: string; alt: string } | null;
  flashSaleId: string | null;
  allowDp: boolean;
  allowFreeShipping: boolean;
  withInsurance: boolean;
  insuranceRequired: boolean;
  status: CartLineStatus;
  previousUnitPrice: string | null;
  availableStock: number;
  minPurchase: number;
  serviceFormErrors: { fieldId: string; message: string }[];
};

export type ShippingOption = {
  method: "alternative" | "self_pickup" | "courier";
  serviceId: string | null;
  name: string;
  cost: string | null;
  available: boolean;
};

export type QuoteVoucher = {
  code: string;
  valid: boolean;
  discount: string;
  freeShipping: boolean;
  reason: string | null;
} | null;

export type PaymentMethodAvailability = {
  method: "manual_qris" | "manual_bank" | "dp";
  available: boolean;
};

export type CartQuote = {
  lines: QuoteLine[];
  subtotal: string;
  weightGrams: number;
  shippingOptions: ShippingOption[];
  shipping: { method: string; serviceId: string | null; name: string; cost: string } | null;
  freeShippingApplied: boolean;
  voucher: QuoteVoucher;
  insurance: { available: boolean; required: boolean; selected: boolean; fee: string };
  tax: { active: boolean; percent: number; amount: string };
  discount: string;
  total: string;
  downPayment: { available: boolean; percent: number; amount: string };
  paymentMethods: PaymentMethodAvailability[];
  canCheckout: boolean;
  quotedAt: string;
};

export type OrderCustomerInput = { name: string; phone: string; email: string | null };

export type OrderAddressInput = {
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  postalCode: string;
  street: string;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
};

export type OrderPaymentInput = { method: "manual_qris" | "manual_bank" | "dp" };

export type CreateOrderRequest = {
  idempotencyKey: string;
  customer: OrderCustomerInput;
  address: OrderAddressInput | null;
  lines: CartLineRequest[];
  shipping: Exclude<ShippingSelection, null>;
  payment: OrderPaymentInput;
  voucherCode: string | null;
  insurance: boolean;
  notes: string | null;
};

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "processing"
  | "shipped"
  | "completed"
  | "cancelled"
  | "expired";

export type OrderLine = {
  name: string;
  variantName: string | null;
  sku: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
  image: { url: string; alt: string } | null;
  serviceFormValues: Record<string, string> | null;
};

export type PaymentConfirmation = {
  id: string;
  method: string;
  amount: string;
  status: string;
  submittedAt: string;
};

export type OrderTimelineEntry = { status: string; at: string; note: string | null };

export type Order = {
  orderCode: string;
  status: OrderStatus;
  paymentStatus: string;
  paymentMethod: string;
  shippingMethod: string;
  shippingServiceName: string | null;
  customer: { name: string; phoneMasked: string; email: string | null };
  address: (Omit<OrderAddressInput, "phone"> & { phone: string }) | null;
  lines: OrderLine[];
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
    expiresAt: string;
    proofUpload: boolean;
  } | null;
  paymentConfirmations: PaymentConfirmation[];
  timeline: OrderTimelineEntry[];
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

export type PaymentConfirmationRequest = {
  phone: string;
  method: "manual_bank" | "manual_qris";
  amount: string;
  bankName: string | null;
  accountName: string | null;
  transferredAt: string;
  proofMediaObjectId: string | null;
};

export type UploadSession = {
  sessionId: string;
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  mediaObjectId: string;
  expiresAt: string;
};

export type ReviewRequest = {
  orderCode: string;
  phone: string;
  productId: string;
  rating: number;
  body: string;
};

// ---------------------------------------------------------------------------
// One function per endpoint (commerce-storefront-endpoints.md)
// ---------------------------------------------------------------------------

/** `POST …/cart/quote` — re-prices/re-validates the cart against live stock, vouchers, and shipping. */
export function quoteCart(input: QuoteRequest): Promise<CartQuote> {
  return kirimPermintaan<CartQuote>("/cart/quote", "POST", input);
}

/**
 * `POST …/orders` — places the order. `201`, or `200` for a REPEATED
 * `idempotencyKey` on the same tenant (the same order comes back, not a
 * duplicate).
 *
 * `bearerToken` is OPTIONAL and additive (issue #90, #86's own "existing
 * `POST /storefront/orders` … accept an optional Bearer"): every existing
 * caller that omits it keeps calling this exactly as before (anonymous
 * guest checkout, unchanged). `checkout.ts` passes the signed-in shopper's
 * session token (`akun-sesi.ts`'s `bacaSesi()?.token`) when one exists, so
 * the created order is bound to that account.
 */
export function createOrder(input: CreateOrderRequest, bearerToken?: string): Promise<Order> {
  return kirimPermintaan<Order>(
    "/orders",
    "POST",
    input,
    bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined
  );
}

/** `GET …/orders/{orderCode}?phone=` — order tracking. `404 NOT_FOUND` (the same neutral body as an unresolvable tenant) for an unknown code, a wrong phone, or another tenant's order — this function does not, and cannot, tell those apart, by design. */
export function getOrder(orderCode: string, phone: string): Promise<Order> {
  return kirimPermintaan<Order>(`/orders/${encodeURIComponent(orderCode)}?phone=${encodeURIComponent(phone)}`, "GET");
}

/** `POST …/orders/{orderCode}/payment-confirmations` — reports a manual transfer/QRIS payment. `409 ORDER_NOT_PAYABLE` when the order left `pending_payment` before this reached the CMS. */
export function submitPaymentConfirmation(
  orderCode: string,
  input: PaymentConfirmationRequest
): Promise<Order> {
  return kirimPermintaan<Order>(`/orders/${encodeURIComponent(orderCode)}/payment-confirmations`, "POST", input);
}

/** `POST …/orders/{orderCode}/payment-proof/upload-sessions` — step 1 of the proof-of-payment upload. `503 MEDIA_UNAVAILABLE` when R2 is not configured on this deployment (also reflected in the public store settings' `payment.proofUpload`). */
export function createPaymentProofUploadSession(
  orderCode: string,
  input: { phone: string; contentType: string; byteLength: number }
): Promise<UploadSession> {
  return kirimPermintaan<UploadSession>(
    `/orders/${encodeURIComponent(orderCode)}/payment-proof/upload-sessions`,
    "POST",
    input
  );
}

/** `POST …/orders/{orderCode}/payment-proof/upload-sessions/{sessionId}/finalize` — step 3, after the browser has `PUT`-uploaded the file directly to `uploadUrl` (step 2 is that raw upload, not routed through this client — it is not a `…/storefront/*` call at all). */
export function finalizePaymentProofUpload(
  orderCode: string,
  sessionId: string,
  input: { phone: string; sha256: string }
): Promise<{ mediaObjectId: string }> {
  return kirimPermintaan<{ mediaObjectId: string }>(
    `/orders/${encodeURIComponent(orderCode)}/payment-proof/upload-sessions/${encodeURIComponent(sessionId)}/finalize`,
    "POST",
    input
  );
}

/** `POST …/orders/{orderCode}/cancel` — `409 ORDER_NOT_CANCELLABLE` once the order has left a cancellable state. */
export function cancelOrder(orderCode: string, input: { phone: string; reason: string | null }): Promise<Order> {
  return kirimPermintaan<Order>(`/orders/${encodeURIComponent(orderCode)}/cancel`, "POST", input);
}

/**
 * `POST …/reviews` — `409 REVIEW_NOT_ALLOWED` when the order is not
 * `completed`, the product is not on it, or a review already exists.
 *
 * `bearerToken` is OPTIONAL, the SAME additive pattern `createOrder` above
 * uses (issue #90) — a review submitted with no session behaves exactly as
 * before (matched to the order by `orderCode`+`phone` alone); one submitted
 * with a session is additionally bound to that account, so it appears on
 * `/akun/ulasan`.
 */
export function submitReview(input: ReviewRequest, bearerToken?: string): Promise<{ id: string; status: string }> {
  return kirimPermintaan<{ id: string; status: string }>(
    "/reviews",
    "POST",
    input,
    bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined
  );
}
