/**
 * One shared presentation module for every commerce enum/status rendered on
 * an admin screen (Issue #243, part of the commerce admin v2 epic). This
 * issue changes NO screen — issues #245/#246/#247 adopt this module on the
 * 12 screens the pattern audit (`docs/…` scratchpad, §3b) found rendering a
 * raw English/snake_case value instead of a translated label:
 * `commerce-inbox.astro`, `commerce-dashboard.astro`,
 * `commerce-affiliates.astro`, `commerce-reports.astro`,
 * `commerce-orders.astro` + `commerce-orders/[id].astro`, `commerce.astro`,
 * `commerce-whatsapp.astro`, `commerce-pos.astro`, `commerce-reviews.astro`,
 * `commerce-campaigns.astro`, `commerce-vouchers.astro`.
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
 * <span class="status-badge" data-tone={orderStatusTone[order.status] ?? "neutral"}>
 *   {commerceLabel(labels.orderStatus, order.status)}
 * </span>
 * ```
 *
 * ## Where each union comes from
 *
 * Every enum below already has an exported TS type or const array somewhere
 * in the commerce (or, for the two report statuses, `reporting`) module —
 * imported here, never redeclared — **except** `OrderChannel` and
 * `ConversationStatus`/`AffiliateStatus`/`CommissionStatus`, which are
 * derived rather than imported directly (see each section's own comment for
 * why). Reusing the exported type is what makes the `satisfies
 * Record<X, string>` below a REAL exhaustiveness check: if a future issue
 * widens e.g. `OrderStatus`, this file fails to compile until the new value
 * is labelled, because TypeScript is checking against the SAME union the
 * domain layer owns — a locally-redeclared copy would silently drift
 * instead.
 */
import type { Translator } from "../i18n";

import type { OrderStatus } from "../../modules/commerce/domain/order-status";
import type { PaymentStatus } from "../../modules/commerce/domain/commerce-order-types";
import type { ProductStatus } from "../../modules/commerce/domain/product-status";
import type { ProductType } from "../../modules/commerce/domain/product-type";
import type { VoucherType } from "../../modules/commerce/domain/voucher-validation";
import type {
  CampaignChannel,
  CampaignStatus
} from "../../modules/commerce/domain/campaign-validation";
import type { ReviewStatus } from "../../modules/commerce/application/review-directory";
import type { WhatsappMessageStatus } from "../../modules/commerce/application/whatsapp-message-directory";
import type {
  AdminAffiliateRecord,
  AdminAffiliateCommissionRecord
} from "../../modules/commerce/application/affiliate-directory";
import type { AdminConversationRecord } from "../../modules/commerce/application/conversation-directory";
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

/** CSS badge/pill tone name — the same small vocabulary every commerce admin screen's own `STATUS_TONE`/`FRESHNESS_VARIANT` map already uses (`data-tone`/`data-variant` on `.status-badge`/`.admin-status-pill`). */
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
    subscription: t("Subscription")
  } satisfies Record<ProductType, string>;

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

  return {
    orderStatus,
    paymentStatus,
    orderChannel,
    productStatus,
    productType,
    voucherType,
    campaignStatus,
    campaignChannel,
    reviewStatus,
    affiliateStatus,
    commissionStatus,
    conversationStatus,
    whatsappMessageStatus,
    reportRunStatus,
    reportFreshnessStatus
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
export const orderStatusTone: Record<OrderStatus, CommerceTone> = {
  pending_payment: "warning",
  paid: "info",
  processing: "info",
  shipped: "primary",
  completed: "success",
  cancelled: "danger",
  expired: "neutral"
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
