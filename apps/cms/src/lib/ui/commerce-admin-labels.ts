/**
 * One shared presentation module for every commerce enum/status rendered on
 * an admin screen (Issue #243, part of the commerce admin v2 epic #249).
 * This issue changes NO screen — issues #245/#246/#247 adopt this module
 * screen by screen. A full sweep of every `apps/cms/src/pages/admin/
 * commerce*.astro` file plus `commerce-orders/[id].astro` (every `<option>`
 * text, table cell, status/tone badge, detail field, and filter-tab label
 * that shows an enum value) found the same defect repeated across sixteen
 * screens: `commerce-inbox.astro` (conversation status), `commerce-
 * dashboard.astro` (order status), `commerce-affiliates.astro` (affiliate
 * and commission status), `commerce-reports.astro` (projection freshness
 * and rebuild-run status), `commerce-orders.astro` + `commerce-orders/
 * [id].astro` (order status, channel, payment status, gateway session
 * status/provider, payment-event provider/outcome), `commerce.astro`
 * (product status and type), `commerce-whatsapp.astro` (message status),
 * `commerce-pos.astro` (order status), `commerce-reviews.astro` (review
 * status), `commerce-campaigns.astro` (campaign status and channel),
 * `commerce-vouchers.astro` (voucher type and status), `commerce-flash-
 * sales.astro` (flash-sale status), `commerce-customers.astro` (customer
 * status), `commerce-popup.astro` (popup frequency), and `commerce-
 * settings.astro` (webhook endpoint provider) — a raw English/snake_case
 * value rendered straight from the database instead of a translated label,
 * each screen either redefining its own ad hoc map or skipping one
 * entirely. This module is the one place every such value is labelled once.
 *
 * ## Why `src/lib/ui/`, not `src/modules/commerce/…`
 *
 * `bun run modules:dag:check` (`scripts/validate-module-graph.ts`) only
 * rejects a `src/lib/<x>` DIRECTORY NAME that collides with a module key (via
 * `LIB_NAMESPACE_ALIASES`/`LIB_NAMESPACE_EXCEPTIONS`) — `ui` is neither, and
 * every existing `src/lib/ui/*.ts` file (`admin-form-client.ts`,
 * `media-picker-client.ts`, …) is already exactly this: presentation-layer
 * TypeScript reused across admin screens. Several `src/lib/<x>/*.ts` files
 * already import types from `src/modules/**` the same direction this file
 * does (`src/lib/security/security-headers.ts` imports
 * `modules/media-library/domain/media-public-origin`,
 * `src/lib/auth/admin-screen.ts` imports
 * `modules/identity-access/domain/access-control`) — there is no rule
 * against a `lib` file reading a module's exported TYPES, only against a
 * `lib` namespace being a second, ungated MODULE. `i18n:catalog:check`'s
 * harvester scans every `.ts`/`.tsx`/`.astro` file under `src/` for literal
 * `t(...)` calls (`SOURCE_EXTENSIONS`/`SOURCE_ROOTS` in
 * `scripts/i18n-catalog-check.ts`), so the literal calls in
 * {@link createCommerceLabels} below are harvested exactly like any
 * `.astro` template's.
 *
 * ## API
 *
 * - {@link createCommerceLabels}`(t)` — call once per request with the
 *   page's own `t` (`getTranslatorFor(Astro.locals.locale).t`), exactly the
 *   value every `.astro` screen already holds. Returns one object of typed
 *   label maps, each `satisfies Record<TheEnumType, string>` — adding a new
 *   value to the enum's own union without adding it here is a **compile
 *   error**, not a silently-missing label.
 * - {@link commerceLabel}`(map, raw)` — the lookup a screen actually calls
 *   per row: `commerceLabel(labels.orderStatus, order.status)`. Falls back to
 *   `raw` itself (or `""` for `null`/`undefined`) rather than throwing, so an
 *   unexpected value already in the database (a status this catalog has not
 *   caught up with yet) still renders instead of crashing the screen.
 * - Tone maps (`orderStatusTone`, `affiliateStatusTone`,
 *   `commissionStatusTone`, `reviewStatusTone`, `reportFreshnessTone`,
 *   `reportRunStatusTone`) — plain constants, not functions of `t` (a tone is
 *   a CSS variant name, never user-facing text). Extracted from the
 *   `STATUS_TONE`/`FRESHNESS_VARIANT` maps that already exist, redundantly,
 *   on `commerce-dashboard.astro`, `commerce-orders/[id].astro`,
 *   `commerce-affiliates.astro` and `commerce-reports.astro` — one source
 *   once the adoption issues switch those screens over. Not every enum below
 *   gets a tone map: only the ones an existing screen already colour-codes.
 *   A screen with its own additional tones (e.g. `commerce-orders.astro`'s
 *   `primary` for `shipped`) is unaffected — these are the SAME values.
 *
 * ## Usage
 *
 * ```ts
 * import { getTranslatorFor } from "../../lib/i18n";
 * import {
 *   createCommerceLabels,
 *   commerceLabel,
 *   orderStatusTone
 * } from "../../lib/ui/commerce-admin-labels";
 *
 * const { t } = getTranslatorFor(Astro.locals.locale);
 * const labels = createCommerceLabels(t);
 * // …
 * <span class="admin-status-pill" data-tone={orderStatusTone[order.status] ?? "neutral"}>
 *   {commerceLabel(labels.orderStatus, order.status)}
 * </span>
 * ```
 *
 * ## Where each union comes from
 *
 * Most enums below already have an exported TS type or const array
 * somewhere in the commerce (or, for the two report statuses, `reporting`)
 * module — imported here, never redeclared. A few have no exported name at
 * all, and are derived instead, each with its own comment explaining why:
 * `OrderChannel`, `PaymentGatewaySessionProvider` and `PaymentEventOutcome`
 * (no TS type anywhere — derived from the column's own database `CHECK`
 * constraint), and `ConversationStatus`/`AffiliateStatus`/
 * `CommissionStatus`/`CustomerStatus` (a union that already exists, publicly,
 * as one field of an exported row type — derived via indexed access rather
 * than redeclared). Reusing the exported (or derived) type is what makes the
 * `satisfies Record<X, string>` below a REAL exhaustiveness check: if a
 * future issue widens e.g. `OrderStatus`, this file fails to compile until
 * the new value is labelled, because TypeScript is checking against the SAME
 * union the domain layer owns — a locally-redeclared copy would silently
 * drift instead.
 */
import type { Translator } from "../i18n";

import type { OrderStatus } from "../../modules/commerce/domain/order-status";
import type { PaymentStatus } from "../../modules/commerce/domain/commerce-order-types";
import type {
  PaymentAllocationKind,
  PaymentAllocationStatus,
  PaymentTenderType
} from "../../modules/commerce/domain/payment-allocation";
import type { ProductStatus } from "../../modules/commerce/domain/product-status";
import type { ProductType } from "../../modules/commerce/domain/product-type";
import type { AttributeAppliesTo } from "../../modules/commerce/domain/attribute-definition";
import type { AttributeValueType } from "../../modules/commerce/domain/attribute-value";
import type { ImportRowAction } from "../../modules/commerce/domain/catalog-import";
import type {
  VoucherType,
  VoucherStatus
} from "../../modules/commerce/domain/voucher-validation";
import type {
  CampaignChannel,
  CampaignStatus
} from "../../modules/commerce/domain/campaign-validation";
import type { FlashSaleStatus } from "../../modules/commerce/domain/flash-sale-status";
import type {
  RegisterCloseDecision,
  RegisterMovementDirection,
  RegisterMovementType,
  RegisterSessionStatus
} from "../../modules/commerce/domain/register";
import type {
  HeldSaleStatus,
  IssuedDocumentType,
  QuotationStatus,
  WorkOrderPriority,
  WorkOrderStatus
} from "../../modules/commerce/domain/documents";
import type {
  StoredValueAccountStatus,
  StoredValueEntryKind,
  StoredValueKind
} from "../../modules/commerce/domain/stored-value";
import type { PopupFrequency } from "../../modules/commerce/domain/popup-validation";
import type { PaymentGatewayStatus } from "../../modules/commerce/domain/payment-gateway-provider";
import type { ReviewStatus } from "../../modules/commerce/application/review-directory";
import type { WhatsappMessageStatus } from "../../modules/commerce/application/whatsapp-message-directory";
import type {
  AdminAffiliateRecord,
  AdminAffiliateCommissionRecord
} from "../../modules/commerce/application/affiliate-directory";
import type { AdminConversationRecord } from "../../modules/commerce/application/conversation-directory";
import type { CustomerAdminRecord } from "../../modules/commerce/application/customer-directory";
import type { WebhookEndpointProvider } from "../../modules/commerce/application/webhook-endpoint-directory";
import type {
  RefundDestination,
  RefundSettledVia,
  RefundStatus,
  ReturnDisposition,
  ReturnKind,
  ReturnReason,
  ReturnStatus
} from "../../modules/commerce/domain/returns";
import type {
  LoyaltyEntryKind,
  LoyaltyProgramStatus
} from "../../modules/commerce/domain/loyalty";
import type { ProjectionFreshnessStatus } from "../../modules/reporting/domain/freshness";
import type { RebuildRunStatus } from "../../modules/reporting/application/rebuild-run-store";

/**
 * `awcms_commerce_orders.channel` has no exported TS union today — every
 * call site types the column as plain `string`
 * (`application/order-directory.ts`'s `AdminOrderRecord.channel` /
 * `OrderDetail.channel` / `PublicOrderRecord.channel`). Derived here from
 * the database's own CHECK constraint
 * (`sql/931_awcms_commerce_pos_schema.sql`'s
 * `awcms_commerce_orders_channel_check`, "`channel IN ('storefront',
 * 'pos')`"): `storefront` for every anonymous/bearer checkout,
 * `pos` for a counter sale rung up via `POST /api/v1/commerce/pos/orders`.
 */
export type OrderChannel = "storefront" | "pos";

/**
 * `domain/conversation-validation.ts`'s `validateConversationStatusInput`
 * returns an inline `{status: "open" | "closed"}` rather than a named
 * export. `application/conversation-directory.ts`'s `AdminConversationRecord`
 * DOES export the same union as a field, so it is derived via indexed access
 * rather than redeclared — the same choice `AffiliateStatus`/
 * `CommissionStatus` below make, for the same reason.
 */
export type ConversationStatus = AdminConversationRecord["status"];

/**
 * `application/affiliate-directory.ts` never named this union — every row
 * type (`AdminAffiliateRecord`, `AccountAffiliateRecord`, the module-local
 * `AffiliateRow`) repeats the literal `"active" | "suspended"` inline.
 * `AdminAffiliateRecord["status"]` derives the exact same union via indexed
 * access without adding a new exported name to that file for a screen-layer
 * concern.
 */
export type AffiliateStatus = AdminAffiliateRecord["status"];

/**
 * Same shape as {@link AffiliateStatus}: `application/affiliate-directory.ts`
 * declares `type CommissionStatus = "pending" | "approved" | "paid" |
 * "void";` as a MODULE-PRIVATE type (never exported — only
 * `AdminAffiliateCommissionRecord.status` and `AccountAffiliateCommission`
 * carry the union publicly), so it is derived via indexed access here rather
 * than either exporting the private type (a commerce-module change this
 * issue does not otherwise need) or redeclaring the four literals by hand.
 */
export type CommissionStatus = AdminAffiliateCommissionRecord["status"];

/**
 * `application/customer-directory.ts` never named this union either —
 * `CustomerAdminRecord.status` and the module-private `CustomerRow` both
 * repeat the literal `"active" | "blocked"` inline (`sql/913`'s and
 * `sql/917`'s own `CHECK (status IN ('active', 'blocked'))`). Derived via
 * indexed access, same as {@link AffiliateStatus} above.
 */
export type CustomerStatus = CustomerAdminRecord["status"];

/**
 * `awcms_commerce_payment_gateway_sessions.provider` and
 * `awcms_commerce_payment_events.provider` share one CHECK constraint
 * (`sql/926_awcms_commerce_payment_gateway_schema.sql`'s
 * `awcms_commerce_payment_gateway_sessions_provider_check` /
 * `_payment_events_provider_check`, both `provider IN ('midtrans', 'log')`)
 * — `application/payment-gateway-directory.ts` types it only as an inline
 * function parameter (`createGatewaySession`'s `providerKey: "midtrans" |
 * "log"`), never as a named export. Deliberately NOT the same type as the
 * imported `WebhookEndpointProvider`: that column's own CHECK constraint
 * (`_webhook_endpoints_provider_check`) allows only `'midtrans'` — a webhook
 * SUBSCRIPTION is always for a real provider, while a gateway SESSION/EVENT
 * may also be the `log` adapter's own synthetic row (`infrastructure/
 * log-payment-gateway-provider.ts`, the deterministic dev/CI stand-in).
 */
export type PaymentGatewaySessionProvider = "midtrans" | "log";

/**
 * `application/payment-gateway-directory.ts`'s `PaymentEventSummary.outcome`
 * is plain `string` — derived here from
 * `sql/926_awcms_commerce_payment_gateway_schema.sql`'s
 * `awcms_commerce_payment_events_outcome_check`
 * (`outcome IN ('applied', 'ignored', 'replay')`). `order-status.ts`'s own
 * header explains the domain meaning: `applied` the first time an event key
 * is seen, `replay` for a repeat delivery of one already applied, `ignored`
 * for one this deployment's webhook intake chose not to act on.
 */
export type PaymentEventOutcome = "applied" | "ignored" | "replay";

/** CSS badge/pill tone name — the same small vocabulary every commerce admin screen's own `STATUS_TONE`/`FRESHNESS_VARIANT` map already uses (`data-tone` on `.admin-status-pill`). */
export type CommerceTone =
  "success" | "warning" | "info" | "primary" | "danger" | "neutral";

/**
 * One object of translated label maps, built fresh from the caller's own
 * `t` — never cached across requests/locales, exactly like every `.astro`
 * screen's own inline `STATUS_TONE`-adjacent label objects it replaces.
 */
export function createCommerceLabels(t: Translator["t"]) {
  const orderStatus = {
    pending_payment: t("Pending payment"),
    paid: t("Paid"),
    processing: t("Processing"),
    shipped: t("Shipped"),
    completed: t("Completed"),
    cancelled: t("Cancelled"),
    expired: t("Expired")
  } satisfies Record<OrderStatus, string>;

  const paymentStatus = {
    unpaid: t("Unpaid"),
    partially_paid: t("Partially paid"),
    dp_paid: t("Down payment paid"),
    paid: t("Paid"),
    refunded: t("Refunded")
  } satisfies Record<PaymentStatus, string>;

  const orderChannel = {
    storefront: t("Storefront"),
    pos: t("POS")
  } satisfies Record<OrderChannel, string>;

  /**
   * `active` reads "Published" rather than "Active" — `commerce.astro`'s own
   * existing quick-filter tab (`?status=active`) already labels this exact
   * value "Published" (a product that is `active` is what a shopper sees on
   * the storefront); matching it here means the adoption issue does not
   * change what a merchant already reads on that tab.
   */
  const productStatus = {
    draft: t("Draft"),
    active: t("Published"),
    inactive: t("Inactive"),
    archived: t("Archived")
  } satisfies Record<ProductStatus, string>;

  const productType = {
    physical: t("Physical"),
    digital: t("Digital"),
    service: t("Service"),
    subscription: t("Subscription"),
    digital_ebook: t("Digital ebook"),
    digital_program: t("Digital program"),
    mentoring: t("Mentoring"),
    bundle: t("Bundle"),
    event: t("Event")
  } satisfies Record<ProductType, string>;

  /** Issue #291 — a catalog attribute's value type (`domain/attribute-value.ts`). */
  const attributeValueType = {
    text: t("Text"),
    integer: t("Whole number"),
    decimal: t("Decimal number"),
    boolean: t("Yes/No"),
    date: t("Date"),
    enum: t("Choice list")
  } satisfies Record<AttributeValueType, string>;

  /** Issue #291 — which catalog entity an attribute definition applies to. */
  const attributeAppliesTo = {
    product: t("Products"),
    variant: t("Variants"),
    both: t("Products and variants")
  } satisfies Record<AttributeAppliesTo, string>;

  /** Issue #291 — the catalog import dry-run's per-row verdict. */
  const importRowAction = {
    create: t("Create"),
    update: t("Update"),
    unchanged: t("Unchanged"),
    error: t("Error")
  } satisfies Record<ImportRowAction, string>;

  const voucherType = {
    percentage: t("Percentage"),
    nominal: t("Nominal"),
    free_shipping: t("Free shipping")
  } satisfies Record<VoucherType, string>;

  const campaignStatus = {
    draft: t("Draft"),
    scheduled: t("Scheduled"),
    sending: t("Sending"),
    sent: t("Sent"),
    cancelled: t("Cancelled")
  } satisfies Record<CampaignStatus, string>;

  const campaignChannel = {
    email: t("Email"),
    whatsapp: t("WhatsApp")
  } satisfies Record<CampaignChannel, string>;

  /**
   * `pending` reads "Awaiting moderation", not the generic "Pending" other
   * maps below reuse — `apps/storefront/src/scripts/akun-ulasan.ts`'s own
   * `STATUS_LABELS.pending` ("Menunggu moderasi") already made this call for
   * the shopper-facing side of the SAME field, and a bare "Pending" leaves a
   * moderator to guess pending WHAT.
   */
  const reviewStatus = {
    pending: t("Awaiting moderation"),
    published: t("Published"),
    rejected: t("Rejected")
  } satisfies Record<ReviewStatus, string>;

  const affiliateStatus = {
    active: t("Active"),
    suspended: t("Suspended")
  } satisfies Record<AffiliateStatus, string>;

  /**
   * `commerce-affiliates.astro`'s own commission-status filter `<select>`
   * already spells these four values "Pending"/"Approved"/"Paid"/"Void" —
   * reused verbatim rather than the (more narrative) "Menunggu" the
   * storefront's own `akun-afiliasi.ts` uses for the same field, since this
   * map exists specifically to replace that screen's remaining raw renders
   * with what its OWN filter already calls them.
   */
  const commissionStatus = {
    pending: t("Pending"),
    approved: t("Approved"),
    paid: t("Paid"),
    void: t("Void")
  } satisfies Record<CommissionStatus, string>;

  /** Reuses the exact same two msgids `commerce-inbox.astro`'s own filter tabs and the storefront's `akun-pesan.ts` already both call "Open"/"Closed". */
  const conversationStatus = {
    open: t("Open"),
    closed: t("Closed")
  } satisfies Record<ConversationStatus, string>;

  const whatsappMessageStatus = {
    queued: t("Queued"),
    sending: t("Sending"),
    sent: t("Sent"),
    failed: t("Failed")
  } satisfies Record<WhatsappMessageStatus, string>;

  const reportRunStatus = {
    running: t("Running"),
    completed: t("Completed"),
    failed: t("Failed"),
    cancelled: t("Cancelled")
  } satisfies Record<RebuildRunStatus, string>;

  const reportFreshnessStatus = {
    current: t("Current"),
    delayed: t("Delayed"),
    stale: t("Stale"),
    rebuilding: t("Rebuilding"),
    failed: t("Failed")
  } satisfies Record<ProjectionFreshnessStatus, string>;

  /** Reuses `commerce-vouchers.astro`'s own status `<select>` options — "Active"/"Inactive" — verbatim. */
  const voucherStatus = {
    active: t("Active"),
    inactive: t("Inactive")
  } satisfies Record<VoucherStatus, string>;

  /**
   * All four values reuse an msgid already declared elsewhere in the
   * catalog — `draft`/`scheduled` the same as {@link campaignStatus} above,
   * `active` the same as {@link voucherStatus}/{@link customerStatus},
   * `ended` the existing "Ended" entry `newsletter.astro`'s own "Ended"
   * column already declared — zero new msgids for this map.
   */
  const flashSaleStatus = {
    draft: t("Draft"),
    scheduled: t("Scheduled"),
    active: t("Active"),
    ended: t("Ended")
  } satisfies Record<FlashSaleStatus, string>;

  /** The RAW gateway session state (`session.status` on `commerce-orders.astro`/`commerce-orders/[id].astro`'s payment-gateway panel) — distinct from {@link orderStatus}: a session can be `pending` while the ORDER is still `pending_payment`, and stays `expired`/`failed` even after an admin moves the order on manually. */
  const paymentGatewayStatus = {
    pending: t("Pending"),
    paid: t("Paid"),
    expired: t("Expired"),
    failed: t("Failed"),
    refunded: t("Refunded")
  } satisfies Record<PaymentGatewayStatus, string>;

  /** No CMS admin screen colour-codes this field; the table cell is plain text, so the two values reuse the same `<select>` options `commerce-customers.astro` already declares. */
  const customerStatus = {
    active: t("Active"),
    blocked: t("Blocked")
  } satisfies Record<CustomerStatus, string>;

  /** Reuses `commerce-popup.astro`'s own create-form `<select>` options verbatim. */
  const popupFrequency = {
    once_per_session: t("Once per session"),
    once_per_day: t("Once per day"),
    always: t("Always")
  } satisfies Record<PopupFrequency, string>;

  /** Reuses `commerce-settings.astro`'s own webhook-creation form's `t("Midtrans")` — the only value today, kept as a real map (not a constant string) so a second provider is a compile error here until labelled, same as every other map in this file. */
  const webhookEndpointProvider = {
    midtrans: t("Midtrans")
  } satisfies Record<WebhookEndpointProvider, string>;

  /** `log` only ever appears outside production (`COMMERCE_PAYMENT_GATEWAY_PROVIDER=log`, the deterministic dev/CI adapter) — still labelled, never left to fall back to the raw string, since `commerceLabel` has no way to know an operator is looking at a dev environment. */
  const paymentGatewaySessionProvider = {
    midtrans: t("Midtrans"),
    log: t("Log adapter (development)")
  } satisfies Record<PaymentGatewaySessionProvider, string>;

  /** Issue #285 - the payment-allocation ledger's tender vocabulary (`domain/payment-allocation.ts`). `gateway` is created only by the hosted-checkout flow, never typed by staff, but still labelled: it appears in every ledger. */
  const paymentTenderType = {
    cash: t("Cash"),
    manual_qris: t("QRIS"),
    manual_bank_transfer: t("Bank transfer"),
    gateway: t("Payment gateway"),
    gift_card: t("Gift card"),
    store_credit: t("Store credit")
  } satisfies Record<PaymentTenderType, string>;

  /** Issue #285 - a ledger row's own state; only `succeeded` legs count toward settlement. */
  const paymentAllocationStatus = {
    pending: t("Pending"),
    succeeded: t("Succeeded"),
    failed: t("Failed")
  } satisfies Record<PaymentAllocationStatus, string>;

  /** Issue #285 - a ledger row is a payment, or a compensating reversal of one. */
  const paymentAllocationKind = {
    payment: t("Payment"),
    reversal: t("Reversal")
  } satisfies Record<PaymentAllocationKind, string>;

  /** Issue #284 - a register session's status (`domain/register.ts`). `closing` means a close awaits a supervisor's approval; `corrected` means a compensating correction exists on a closed session. */
  const registerSessionStatus = {
    open: t("Open"),
    closing: t("Awaiting approval"),
    closed: t("Closed"),
    corrected: t("Corrected")
  } satisfies Record<RegisterSessionStatus, string>;

  /** Issue #284 - the drawer movement types (cash only). */
  const registerMovementType = {
    cash_in: t("Cash in"),
    cash_out: t("Cash out"),
    safe_drop: t("Safe drop"),
    expense: t("Expense"),
    transfer: t("Transfer"),
    correction: t("Correction")
  } satisfies Record<RegisterMovementType, string>;

  /** Issue #284 - which way a movement moved the cash. */
  const registerMovementDirection = {
    in: t("In"),
    out: t("Out")
  } satisfies Record<RegisterMovementDirection, string>;

  /** Issue #284 - a close request's decision: `auto` = within the threshold, closed on the spot. */
  const registerCloseDecision = {
    auto: t("Within threshold"),
    pending: t("Pending approval"),
    approved: t("Approved"),
    rejected: t("Rejected")
  } satisfies Record<RegisterCloseDecision, string>;

  /** Issue #288 - the two kinds of closed-loop stored value (`domain/stored-value.ts`). Same wording as the `gift_card` / `store_credit` payment tenders. */
  const storedValueKind = {
    gift_card: t("Gift card"),
    store_credit: t("Store credit")
  } satisfies Record<StoredValueKind, string>;

  /** Issue #288 - a stored-value account's status; `expired` is terminal. */
  const storedValueAccountStatus = {
    active: t("Active"),
    disabled: t("Disabled"),
    expired: t("Expired")
  } satisfies Record<StoredValueAccountStatus, string>;

  /** Issue #288 - what a stored-value ledger entry did to the balance. */
  const storedValueEntryKind = {
    issue: t("Issued"),
    load: t("Loaded"),
    redeem: t("Redeemed"),
    refund: t("Refunded to card"),
    adjust: t("Adjusted"),
    expire: t("Expired"),
    disable: t("Disabled"),
    enable: t("Enabled")
  } satisfies Record<StoredValueEntryKind, string>;

  /** Issue #286 - a quotation's status (`domain/documents.ts`). */
  const quotationStatus = {
    draft: t("Draft"),
    sent: t("Sent"),
    accepted: t("Accepted"),
    rejected: t("Rejected"),
    expired: t("Expired"),
    converted: t("Converted to order"),
    cancelled: t("Cancelled")
  } satisfies Record<QuotationStatus, string>;

  /** Issue #286 - a work order's operational status. */
  const workOrderStatus = {
    received: t("Received"),
    scheduled: t("Scheduled"),
    in_progress: t("In progress"),
    on_hold: t("On hold"),
    ready: t("Ready"),
    completed: t("Completed"),
    cancelled: t("Cancelled")
  } satisfies Record<WorkOrderStatus, string>;

  const workOrderPriority = {
    low: t("Low"),
    normal: t("Normal"),
    high: t("High"),
    urgent: t("Urgent")
  } satisfies Record<WorkOrderPriority, string>;

  /** Issue #286 - a held (parked) sale's effective status. */
  const heldSaleStatus = {
    held: t("Held"),
    resumed: t("Resumed"),
    discarded: t("Discarded"),
    expired: t("Expired")
  } satisfies Record<HeldSaleStatus, string>;

  /** Issue #286 - the two issuable legal documents. */
  const documentType = {
    receipt: t("Receipt"),
    invoice: t("Invoice")
  } satisfies Record<IssuedDocumentType, string>;

  /** `domain/order-status.ts`'s own header documents the domain meaning behind each of these three values — see {@link PaymentEventOutcome}'s own comment above. */
  const paymentEventOutcome = {
    applied: t("Applied"),
    ignored: t("Ignored"),
    replay: t("Replay")
  } satisfies Record<PaymentEventOutcome, string>;

  /** Issue #289 — the ledger entry kinds of the loyalty points ledger (`restore`: Issue #363). */
  const loyaltyEntryKind = {
    earn: t("Earned"),
    redeem: t("Redeemed"),
    expire: t("Expired"),
    adjustment: t("Adjustment"),
    reversal: t("Reversal"),
    restore: t("Points restored")
  } satisfies Record<LoyaltyEntryKind, string>;

  /** Issue #287 (ADR-0033) - why goods came back. */
  const returnReason = {
    defective: t("Defective or faulty"),
    wrong_item: t("Wrong item sent"),
    not_as_described: t("Not as described"),
    damaged_in_transit: t("Damaged in transit"),
    changed_mind: t("Customer changed their mind"),
    size_fit: t("Size or fit"),
    duplicate_order: t("Duplicate order"),
    other: t("Other reason")
  } satisfies Record<ReturnReason, string>;

  /** Issue #287 - what happens to a returned unit. Only `restock` makes it sellable again. */
  const returnDisposition = {
    restock: t("Restock (sellable again)"),
    damaged: t("Damaged (written off)"),
    quarantine: t("Quarantine (held, not sellable)")
  } satisfies Record<ReturnDisposition, string>;

  const returnKind = {
    return: t("Return"),
    exchange: t("Exchange")
  } satisfies Record<ReturnKind, string>;

  const returnStatus = {
    open: t("Open"),
    completed: t("Completed")
  } satisfies Record<ReturnStatus, string>;

  const refundStatus = {
    pending: t("Waiting"),
    processing: t("With the payment provider"),
    succeeded: t("Refunded"),
    failed: t("Failed")
  } satisfies Record<RefundStatus, string>;

  const refundDestination = {
    original_tender: t("Original payment method"),
    store_credit: t("Store credit")
  } satisfies Record<RefundDestination, string>;

  const refundSettledVia = {
    ledger: t("Handed back / booked"),
    provider: t("Payment provider"),
    offline: t("Made outside the system"),
    store_credit: t("Store credit")
  } satisfies Record<RefundSettledVia, string>;

  /** Issue #289 — a loyalty program version's lifecycle. `draft`/`active` reuse existing msgids; `retired` is new. */
  const loyaltyProgramStatus = {
    draft: t("Draft"),
    active: t("Active"),
    retired: t("Retired")
  } satisfies Record<LoyaltyProgramStatus, string>;

  return {
    orderStatus,
    paymentStatus,
    orderChannel,
    productStatus,
    productType,
    attributeValueType,
    attributeAppliesTo,
    importRowAction,
    voucherType,
    campaignStatus,
    campaignChannel,
    reviewStatus,
    affiliateStatus,
    commissionStatus,
    conversationStatus,
    whatsappMessageStatus,
    reportRunStatus,
    reportFreshnessStatus,
    voucherStatus,
    flashSaleStatus,
    paymentGatewayStatus,
    customerStatus,
    popupFrequency,
    webhookEndpointProvider,
    paymentGatewaySessionProvider,
    paymentEventOutcome,
    paymentTenderType,
    paymentAllocationStatus,
    paymentAllocationKind,
    registerSessionStatus,
    registerMovementType,
    registerMovementDirection,
    registerCloseDecision,
    quotationStatus,
    workOrderStatus,
    workOrderPriority,
    heldSaleStatus,
    documentType,
    loyaltyEntryKind,
    returnReason,
    returnDisposition,
    returnKind,
    returnStatus,
    refundStatus,
    refundDestination,
    refundSettledVia,
    loyaltyProgramStatus,
    storedValueKind,
    storedValueAccountStatus,
    storedValueEntryKind
  };
}

/** The object {@link createCommerceLabels} returns — the type a screen names when it wants to accept `labels` as a parameter rather than calling the factory itself. */
export type CommerceLabels = ReturnType<typeof createCommerceLabels>;

/**
 * Looks `raw` up in `map`, falling back to `raw` itself — NEVER throws, and
 * never returns `undefined`, so a value already in the database that this
 * catalog has not caught up with yet (a status added to the domain union
 * before this file's own next edit) still renders as its own raw text
 * instead of crashing the screen. `null`/`undefined` (an optional/nullable
 * field with no value at all) render as `""` — there is no "raw value" to
 * fall back to for either.
 */
export function commerceLabel<K extends string>(
  map: Readonly<Record<K, string>>,
  raw: string | null | undefined
): string {
  if (raw === null || raw === undefined) return "";
  return (map as Readonly<Record<string, string>>)[raw] ?? raw;
}

/** Exact copy of `commerce-dashboard.astro`'s and `commerce-orders/[id].astro`'s own (identical) `STATUS_TONE`. */
export const returnStatusTone: Record<ReturnStatus, CommerceTone> = {
  open: "warning",
  completed: "success"
};

export const refundStatusTone: Record<RefundStatus, CommerceTone> = {
  pending: "warning",
  processing: "info",
  succeeded: "success",
  failed: "danger"
};

export const orderStatusTone: Record<OrderStatus, CommerceTone> = {
  pending_payment: "warning",
  paid: "info",
  processing: "info",
  shipped: "primary",
  completed: "success",
  cancelled: "danger",
  expired: "neutral"
};

/** Issue #284 - a register session's tone: open is live, `closing` needs a supervisor, closed is done, corrected is a closed session that was amended. */
export const registerSessionStatusTone: Record<
  RegisterSessionStatus,
  CommerceTone
> = {
  open: "success",
  closing: "warning",
  closed: "neutral",
  corrected: "info"
};

/** Issue #288 - a stored-value account's tone: active is live, disabled needs attention, expired is over. */
export const storedValueAccountStatusTone: Record<
  StoredValueAccountStatus,
  CommerceTone
> = {
  active: "success",
  disabled: "warning",
  expired: "neutral"
};

/** Issue #286 - quotation tone: a live offer is info, an accepted/converted one is a success, a lapsed one a warning. */
export const quotationStatusTone: Record<QuotationStatus, CommerceTone> = {
  draft: "neutral",
  sent: "info",
  accepted: "success",
  rejected: "danger",
  expired: "warning",
  converted: "success",
  cancelled: "neutral"
};

/** Issue #286 - work-order tone. */
export const workOrderStatusTone: Record<WorkOrderStatus, CommerceTone> = {
  received: "neutral",
  scheduled: "info",
  in_progress: "info",
  on_hold: "warning",
  ready: "success",
  completed: "success",
  cancelled: "neutral"
};

/** Issue #286 - held-sale tone. */
export const heldSaleStatusTone: Record<HeldSaleStatus, CommerceTone> = {
  held: "info",
  resumed: "success",
  discarded: "neutral",
  expired: "warning"
};

/** The affiliate half of `commerce-affiliates.astro`'s combined `STATUS_TONE`. */
export const affiliateStatusTone: Record<AffiliateStatus, CommerceTone> = {
  active: "success",
  suspended: "danger"
};

/** The commission half of `commerce-affiliates.astro`'s combined `STATUS_TONE`. */
export const commissionStatusTone: Record<CommissionStatus, CommerceTone> = {
  pending: "warning",
  approved: "info",
  paid: "success",
  void: "neutral"
};

/** Mirrors the storefront's own `akun-ulasan.ts` `STATUS_TONES` (pending → warning, published → success, rejected → danger) — no CMS admin screen colour-codes this field yet, so this is the first, not an extraction. */
export const reviewStatusTone: Record<ReviewStatus, CommerceTone> = {
  pending: "warning",
  published: "success",
  rejected: "danger"
};

/** Exact copy of `commerce-reports.astro`'s own `FRESHNESS_VARIANT`. */
export const reportFreshnessTone: Record<
  ProjectionFreshnessStatus,
  CommerceTone
> = {
  current: "success",
  delayed: "warning",
  stale: "warning",
  rebuilding: "info",
  failed: "danger"
};

/**
 * Generalises `commerce-reports.astro`'s own inline ternary
 * (`run.status === "completed" ? "success" : "danger"`) into a tone per
 * value rather than a binary one — `running`/`cancelled` were previously
 * unstyled (falling into the same "danger" branch as `failed`).
 */
export const reportRunStatusTone: Record<RebuildRunStatus, CommerceTone> = {
  running: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral"
};

/** Issue #289 — a draft is awaiting activation (warning), the open active version is success, a retired one is neutral. */
export const loyaltyProgramStatusTone: Record<
  LoyaltyProgramStatus,
  CommerceTone
> = {
  draft: "warning",
  active: "success",
  retired: "neutral"
};
