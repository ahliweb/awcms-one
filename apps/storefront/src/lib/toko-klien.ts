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
  | { method: "courier"; serviceId: string | null }
  | null;

export type QuoteRequest = {
  lines: CartLineRequest[];
  shipping: ShippingSelection;
  voucherCode: string | null;
  insurance: boolean;
  /**
   * Issue #109 (contract: #106 D4) — the shopper's chosen district, sent as
   * soon as the checkout address step's district `<select>` has a value.
   * `undefined`/`null`/absent means "no destination known yet" — the CMS
   * (and this repo's own stub) then answers with the single disabled
   * `{available:false}` courier placeholder rather than real rates, exactly
   * as it does when `shipping.courier.enabled` is off.
   */
  destination?: { districtCode: string } | null;
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
  /**
   * Issue #109 (contract: #106 D4) — the courier's estimated delivery time
   * (e.g. `"2-3 hari"`), shown beside the price. `null`/absent for a
   * non-courier option, or for the disabled placeholder row.
   */
  etd?: string | null;
  /**
   * Issue #109 — a human-readable reason the SINGLE disabled courier
   * placeholder row is unavailable (courier disabled, no destination yet, or
   * the provider could not price this destination) — shown as the row's own
   * visible help text, not just a "Segera hadir" label with no explanation.
   * `null`/absent on every other option.
   */
  note?: string | null;
};

export type QuoteVoucher = {
  code: string;
  valid: boolean;
  discount: string;
  freeShipping: boolean;
  reason: string | null;
} | null;

export type PaymentMethodAvailability = {
  /**
   * `"gateway"` (issue #112, contract: #106 D3) is listed, `available:true`,
   * only when the tenant's public store settings carry `payment.
   * gatewayEnabled: true` (`src/lib/awcms/pemasaran.ts`'s `PaymentSettings`)
   * — an awcms that predates #106/#110 simply never sends it, and this
   * union member exists for the CMS to send at all, not for this app to
   * infer it from anything else.
   */
  method: "manual_qris" | "manual_bank" | "dp" | "gateway";
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

/** `"gateway"` (issue #112) places the order in `pending_payment` exactly like every other method — the CMS starts it with no gateway session at all; `checkout.ts` creates one immediately afterwards via `createGatewaySession`, a separate call, never a field on this request. */
export type OrderPaymentInput = { method: "manual_qris" | "manual_bank" | "dp" | "gateway" };

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
  /**
   * Issue #93 (S3 of #32) — the referral code captured by `afiliasi-
   * tangkap.ts`, per #86's own "existing `POST /storefront/orders` … also
   * accepts an optional `affiliateCode`". `null` when no (valid, unexpired)
   * referral was captured — the same as never having clicked a referral
   * link. The CMS ignores an unknown/suspended code entirely (#86's D5): a
   * bad code here never blocks or changes checkout, only whether a
   * commission is later attributed.
   */
  affiliateCode: string | null;
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
  /**
   * Issue #112 (contract: #106 D3) — present only for a `paymentMethod:
   * "gateway"` order, and only once a session has actually been created
   * (`createGatewaySession` below); `null`/absent for every order this
   * app's own gateway flow has not touched yet, and for every order made
   * with a different `paymentMethod` at all. `status` tracks the gateway's
   * OWN lifecycle, not this app's order status — a `"paid"` gateway with an
   * order still `pending_payment` is a state the CMS's webhook/reconciler
   * closes shortly after, not something this client reconciles itself.
   */
  gateway?: { provider: string; status: "created" | "pending" | "paid" | "expired" | "failed" } | null;
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

/** `POST …/orders/{orderCode}/payment-gateway/sessions` — issue #112, contract: #106 D3. */
export type GatewaySession = { redirectUrl: string; expiresAt: string; providerRef: string };

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

/**
 * `POST …/orders/{orderCode}/payment-gateway/sessions` — issue #112,
 * contract: #106 D3. Starts (or, per that contract's own "idempotent per
 * order", re-reads) the gateway session for a `pending_payment`,
 * `paymentMethod: "gateway"` order and hands back the hosted page to send
 * the shopper's whole browser to (`checkout.ts`/`pesanan.ts`/`akun-
 * pesanan.ts` all `window.location.assign` it, never embed it — see this
 * repo's own `docs/adr/0010-*.md`).
 *
 * `phone` is required for an ANONYMOUS caller (the same ownership proof
 * `getOrder`/`cancelOrder`/`submitPaymentConfirmation` already ask for) and
 * ignored when `bearerToken` is given instead (a signed-in shopper's own
 * order, `/akun/pesanan`'s detail view) — passing `null` for `phone` when a
 * bearer token is supplied sends no `phone` field at all, matching this
 * contract's own "`{phone}` (or `Authorization: Bearer`)".
 *
 * `409 PAYMENT_NOT_APPLICABLE` — the order is not a `gateway` order, or has
 * left `pending_payment`. `503 GATEWAY_UNAVAILABLE` — the deployment's own
 * provider is unreachable/misconfigured. Both are ordinary `TokoApiError`s,
 * switched on `.code` like every other error this file throws.
 */
export function createGatewaySession(
  orderCode: string,
  phone: string | null,
  bearerToken?: string
): Promise<GatewaySession> {
  return kirimPermintaan<GatewaySession>(
    `/orders/${encodeURIComponent(orderCode)}/payment-gateway/sessions`,
    "POST",
    phone ? { phone } : {},
    bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined
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
