import { defineModule } from "../_shared/module-contract";
import { DEFAULT_COMMERCE_FEATURES } from "./domain/commerce-features";
import { DEFAULT_CASH_UP_APPROVAL_THRESHOLD } from "./domain/register";
import { DEFAULT_EXPENSE_APPROVAL_THRESHOLD } from "./domain/expense";
import {
  EXPENSE_DATA_LIFECYCLE,
  EXPENSE_SUBJECT_DATA
} from "./domain/expense-lifecycle";
import {
  OPERATIONAL_REPORT_DATA_LIFECYCLE,
  OPERATIONAL_REPORT_SUBJECT_DATA
} from "./domain/operational-report-lifecycle";
import {
  REGISTER_DATA_LIFECYCLE,
  REGISTER_SUBJECT_DATA
} from "./domain/register-lifecycle";
import {
  RETURNS_DATA_LIFECYCLE,
  RETURNS_SUBJECT_DATA
} from "./domain/returns-lifecycle";
import {
  STORED_VALUE_DATA_LIFECYCLE,
  STORED_VALUE_SUBJECT_DATA
} from "./domain/stored-value-lifecycle";
import {
  DOCUMENT_DATA_LIFECYCLE,
  DOCUMENT_SUBJECT_DATA
} from "./domain/documents-lifecycle";
import {
  COMMERCE_CATEGORIES_ACTIVITY_CODE,
  COMMERCE_CATEGORY_PERMISSIONS,
  COMMERCE_FLASH_SALES_ACTIVITY_CODE,
  COMMERCE_FLASH_SALE_PERMISSIONS,
  COMMERCE_POPUPS_ACTIVITY_CODE,
  COMMERCE_POPUP_PERMISSIONS,
  COMMERCE_PRODUCTS_ACTIVITY_CODE,
  COMMERCE_PRODUCT_PERMISSIONS,
  COMMERCE_SETTINGS_ACTIVITY_CODE,
  COMMERCE_SETTINGS_PERMISSIONS,
  COMMERCE_SLIDERS_ACTIVITY_CODE,
  COMMERCE_SLIDER_PERMISSIONS,
  COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
  COMMERCE_TESTIMONIAL_PERMISSIONS,
  COMMERCE_VOUCHERS_ACTIVITY_CODE,
  COMMERCE_VOUCHER_PERMISSIONS,
  COMMERCE_ORDERS_ACTIVITY_CODE,
  COMMERCE_ORDER_PERMISSIONS,
  COMMERCE_CUSTOMERS_ACTIVITY_CODE,
  COMMERCE_CUSTOMER_PERMISSIONS,
  COMMERCE_REVIEWS_ACTIVITY_CODE,
  COMMERCE_REVIEW_PERMISSIONS,
  COMMERCE_AFFILIATES_ACTIVITY_CODE,
  COMMERCE_AFFILIATE_PERMISSIONS,
  COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE,
  COMMERCE_AFFILIATE_COMMISSION_PERMISSIONS,
  COMMERCE_WHATSAPP_ACTIVITY_CODE,
  COMMERCE_WHATSAPP_PERMISSIONS,
  COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
  COMMERCE_CONVERSATION_PERMISSIONS,
  COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
  COMMERCE_CAMPAIGN_PERMISSIONS,
  COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE,
  COMMERCE_WEBHOOK_ENDPOINT_PERMISSIONS,
  COMMERCE_POS_ACTIVITY_CODE,
  COMMERCE_POS_PERMISSIONS,
  COMMERCE_POS_DUE_ACTIVITY_CODE,
  COMMERCE_POS_DUE_PERMISSIONS,
  COMMERCE_PAYMENTS_ACTIVITY_CODE,
  COMMERCE_PAYMENT_PERMISSIONS,
  COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
  COMMERCE_EXPENSE_CATEGORY_PERMISSIONS,
  COMMERCE_EXPENSES_ACTIVITY_CODE,
  COMMERCE_EXPENSE_PERMISSIONS,
  COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
  COMMERCE_EXPENSE_POSTING_PERMISSIONS,
  COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE,
  COMMERCE_EXPENSE_REVERSAL_PERMISSIONS,
  COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_DELIVERY_PERMISSIONS,
  COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_DELIVERY_OVERRIDE_PERMISSIONS,
  COMMERCE_EXPENSE_RECEIPT_PERMISSIONS,
  COMMERCE_REGISTERS_ACTIVITY_CODE,
  COMMERCE_REGISTER_PERMISSIONS,
  COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
  COMMERCE_REGISTER_SESSION_PERMISSIONS,
  COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REGISTER_CASH_UP_PERMISSIONS,
  COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE,
  COMMERCE_REGISTER_CORRECTION_PERMISSIONS,
  COMMERCE_HELD_SALES_ACTIVITY_CODE,
  COMMERCE_HELD_SALE_PERMISSIONS,
  COMMERCE_QUOTATIONS_ACTIVITY_CODE,
  COMMERCE_QUOTATION_PERMISSIONS,
  COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE,
  COMMERCE_QUOTATION_CONVERSION_PERMISSIONS,
  COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
  COMMERCE_WORK_ORDER_PERMISSIONS,
  COMMERCE_DOCUMENTS_ACTIVITY_CODE,
  COMMERCE_BARCODES_ACTIVITY_CODE,
  COMMERCE_INVENTORY_ACTIVITY_CODE,
  COMMERCE_DOCUMENT_PERMISSIONS,
  COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_PROGRAM_PERMISSIONS,
  COMMERCE_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_PERMISSIONS,
  COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_ADJUSTMENT_PERMISSIONS,
  COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE,
  COMMERCE_STORED_VALUE_RECONCILE_PERMISSIONS,
  COMMERCE_ENTITLEMENTS_ACTIVITY_CODE,
  COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
  COMMERCE_ATTRIBUTE_PERMISSIONS,
  COMMERCE_LOYALTY_ACTIVITY_CODE,
  COMMERCE_LOYALTY_ADJUSTMENTS_ACTIVITY_CODE,
  COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE,
  COMMERCE_RETURNS_ACTIVITY_CODE,
  COMMERCE_REFUNDS_ACTIVITY_CODE,
  COMMERCE_REFUNDS_OFFLINE_ACTIVITY_CODE,
  COMMERCE_REPORT_TENDERS_ACTIVITY_CODE,
  COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
  COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
  COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
  COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
  COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
  COMMERCE_REPORT_RETURN_PERMISSIONS,
  COMMERCE_REPORT_TENDER_PERMISSIONS,
  COMMERCE_REPORT_CASH_UP_PERMISSIONS,
  COMMERCE_REPORT_EXPENSE_PERMISSIONS,
  COMMERCE_REPORT_LOYALTY_PERMISSIONS,
  COMMERCE_REPORT_STORED_VALUE_PERMISSIONS
} from "./domain/commerce-permissions";
import {
  COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE,
  COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE,
  COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
  COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_PRODUCT_UPDATED_EVENT_TYPE,
  COMMERCE_ORDER_CREATED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
  COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
  COMMERCE_QUOTATION_ACCEPTED_EVENT_TYPE,
  COMMERCE_QUOTATION_CONVERTED_EVENT_TYPE,
  COMMERCE_WORK_ORDER_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_DOCUMENT_ISSUED_EVENT_TYPE,
  COMMERCE_VOUCHER_REDEEMED_EVENT_TYPE,
  COMMERCE_REVIEW_PUBLISHED_EVENT_TYPE,
  COMMERCE_PAYMENT_RECORDED_EVENT_TYPE,
  COMMERCE_PAYMENT_REVERSED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_OPENED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_MOVEMENT_RECORDED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_CLOSED_EVENT_TYPE,
  COMMERCE_REGISTER_SESSION_CORRECTED_EVENT_TYPE,
  COMMERCE_LOYALTY_ENTRY_RECORDED_EVENT_TYPE,
  COMMERCE_STORED_VALUE_ENTRY_RECORDED_EVENT_TYPE,
  COMMERCE_EXPENSE_POSTED_EVENT_TYPE,
  COMMERCE_EXPENSE_REVERSED_EVENT_TYPE,
  COMMERCE_DOCUMENT_DELIVERY_REQUESTED_EVENT_TYPE,
  COMMERCE_RETURN_RECORDED_EVENT_TYPE,
  COMMERCE_REFUND_SETTLED_EVENT_TYPE
} from "./domain/commerce-events";
import {
  SALES_BY_CATEGORY_PROJECTION_KEY,
  SALES_BY_PRODUCT_PROJECTION_KEY,
  SALES_DAILY_PROJECTION_KEY,
  SALES_ORDER_EVENTS_STREAM_KEY,
  SALES_REPORT_METRIC_KEYS
} from "./domain/sales-report-keys";
import {
  OPERATIONAL_METRIC_KEYS,
  OPERATIONAL_STREAM_KEYS,
  POS_CASH_UP_VARIANCE_PROJECTION_KEY,
  POS_EXPENSE_DAILY_PROJECTION_KEY,
  POS_LOYALTY_DAILY_PROJECTION_KEY,
  POS_RETURNS_DAILY_PROJECTION_KEY,
  POS_STORED_VALUE_DAILY_PROJECTION_KEY,
  POS_TENDER_DAILY_PROJECTION_KEY
} from "./domain/operational-report-keys";
import {
  CASH_UP_CLOSE_SINK,
  CASH_UP_CORRECTION_SINK,
  CASH_UP_DIMENSIONAL,
  EXPENSE_DIMENSIONAL,
  EXPENSE_POSTED_SINK,
  EXPENSE_REVERSED_SINK,
  LOYALTY_DIMENSIONAL,
  LOYALTY_SINK,
  REFUND_LEGS_SINK,
  RETURN_LINES_SINK,
  RETURNS_DIMENSIONAL,
  RETURNS_SINK,
  STORED_VALUE_DIMENSIONAL,
  STORED_VALUE_SINK,
  TENDER_DIMENSIONAL,
  TENDER_SINK
} from "./application/operational-report-projection";
import {
  SALES_BY_CATEGORY_DIMENSIONAL,
  SALES_BY_CATEGORY_SINK,
  SALES_BY_PRODUCT_DIMENSIONAL,
  SALES_BY_PRODUCT_SINK,
  SALES_DAILY_DIMENSIONAL,
  SALES_DAILY_SINK
} from "./application/sales-report-projection";
import type {
  ProjectionCursorStream,
  ProjectionDescriptor
} from "../_shared/module-contract";

/**
 * Issue #117 (epic #33 C8, contract #106 / ADR-0017 D7) — the one source
 * stream all three sales-report projections read: `awcms_commerce_order_events`,
 * an append-only status-transition log (the ONLY kind of source the
 * `cursor_table` strategy is correct for — `reporting/README.md`
 * §Projections). The scalar `metrics` rule counts consumed `-> paid` events
 * (the figure the generic projection card and the engine's own `COUNT(*)`
 * reconciliation see); the dimensional `sink` is where the money goes. One
 * factory, three descriptors: each projection keeps its OWN cursor row under
 * the same stream key, so a rebuild of one never disturbs the other two.
 */
function salesOrderEventsStream(
  sink: ProjectionCursorStream["dimensional"]
): ProjectionCursorStream {
  return {
    streamKey: SALES_ORDER_EVENTS_STREAM_KEY,
    tableName: "awcms_commerce_order_events",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: SALES_REPORT_METRIC_KEYS.paidEvents,
        effect: "increment",
        matchColumn: "to_status",
        matchValue: "paid"
      }
    ],
    dimensional: sink
  };
}

const SALES_REPORT_FRESHNESS = {
  // Same policy as `reporting`'s own cursor_table projections: the refresh
  // job runs every 2 minutes, so 5 minutes is one missed tick and 30 is a
  // worker that has stopped.
  targetSeconds: 300,
  staleAfterSeconds: 1800,
  errorAfterConsecutiveFailures: 3
} as const;

const SALES_REPORT_RETENTION_CLASS =
  "commerce.sales_daily / commerce.sales_by_product / commerce.sales_by_category (this module's own dataLifecycle descriptors, cursor `day`, same 3650-day ceiling as commerce.order_events): derived, fully rebuildable aggregates — a rebuild after the source's own retention purge recomputes from surviving events only, the same coupling reporting.access_audit_summary documents.";

function salesReportProjection(
  input: Pick<ProjectionDescriptor, "key" | "description" | "dimensional"> & {
    sink: NonNullable<ProjectionCursorStream["dimensional"]>;
    drillDownPath: string;
  }
): ProjectionDescriptor {
  return {
    key: input.key,
    version: 1,
    ownerModuleKey: "commerce",
    scope: "tenant",
    description: input.description,
    source: {
      strategy: "cursor_table",
      streams: [salesOrderEventsStream(input.sink)]
    },
    rebuildSource: { streams: [salesOrderEventsStream(input.sink)] },
    metricLabels: {
      [SALES_REPORT_METRIC_KEYS.paidEvents]: "Paid order events consumed"
    },
    // The generic projection surface (`GET /api/v1/reports/projections`,
    // rebuild/reconcile, `/admin/reporting`) is gated like every other
    // projection; the three business read routes and the reports screen sit
    // behind `reporting.dashboard.read` instead (contract #106).
    requiredPermission: "reporting.projections.read",
    freshness: SALES_REPORT_FRESHNESS,
    drillDownPath: input.drillDownPath,
    retentionClass: SALES_REPORT_RETENTION_CLASS,
    batchLimit: 500,
    dimensional: input.dimensional
  };
}

/**
 * Issue #296 (ADR-0035) - the six POS (five from #296, returns from #316) operational-report projections. One
 * factory like {@link salesReportProjection}; each descriptor lists its own
 * streams (cash-ups and expenses read two sources each) and the same list is
 * its `rebuildSource`, so a rebuild resets and replays every cursor it owns.
 * Each stream's scalar metric is a "rows consumed" counter whose `COUNT(*)`
 * equivalent the engine's own reconciliation can evaluate with an equality
 * match (a status or decision that is frozen once the cursor column is set),
 * so it never reports a false drift for a row the stream legitimately skips.
 */
const OPERATIONAL_REPORT_RETENTION_CLASS =
  "commerce.pos_tender_daily / _cash_up_variance / _expense_daily / _loyalty_daily / _stored_value_daily / _returns_daily (this module's own dataLifecycle descriptors, cursor `day`, same 3650-day ceiling as the sales projections): derived, fully rebuildable aggregates over append-only (or write-once) ledgers - a rebuild after a source's own retention purge recomputes from surviving rows only, the same coupling reporting.access_audit_summary documents.";

function operationalReportProjection(
  input: Pick<
    ProjectionDescriptor,
    "key" | "description" | "dimensional" | "metricLabels"
  > & {
    streams: readonly ProjectionCursorStream[];
    drillDownPath: string;
    /** The family's own `.read` key: a caller holding only the coarse `reporting.projections.read` still cannot see a family it has no report permission for (the second guard layer, `projection-permission-filter.ts`). */
    requiredPermission: string;
  }
): ProjectionDescriptor {
  return {
    key: input.key,
    version: 1,
    ownerModuleKey: "commerce",
    scope: "tenant",
    description: input.description,
    source: { strategy: "cursor_table", streams: input.streams },
    rebuildSource: { streams: input.streams },
    metricLabels: input.metricLabels,
    requiredPermission: input.requiredPermission,
    freshness: SALES_REPORT_FRESHNESS,
    drillDownPath: input.drillDownPath,
    retentionClass: OPERATIONAL_REPORT_RETENTION_CLASS,
    batchLimit: 500,
    dimensional: input.dimensional
  };
}

const TENDER_DAILY_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.allocations,
    tableName: "awcms_commerce_report_src_allocations",
    cursorColumn: "settled_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.tenderSucceeded,
        effect: "increment",
        matchColumn: "status",
        matchValue: "succeeded"
      }
    ],
    dimensional: TENDER_SINK
  }
];

const CASH_UP_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.closeRequests,
    tableName: "awcms_commerce_report_src_close_decisions",
    cursorColumn: "decided_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.cashUpAuto,
        effect: "increment",
        matchColumn: "decision",
        matchValue: "auto"
      },
      {
        metricKey: OPERATIONAL_METRIC_KEYS.cashUpApproved,
        effect: "increment",
        matchColumn: "decision",
        matchValue: "approved"
      }
    ],
    dimensional: CASH_UP_CLOSE_SINK
  },
  {
    streamKey: OPERATIONAL_STREAM_KEYS.corrections,
    tableName: "awcms_commerce_register_corrections",
    cursorColumn: "created_at",
    metrics: [
      { metricKey: OPERATIONAL_METRIC_KEYS.corrections, effect: "increment" }
    ],
    dimensional: CASH_UP_CORRECTION_SINK
  }
];

const EXPENSE_DAILY_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.expensesPosted,
    tableName: "awcms_commerce_report_src_expenses_posted",
    cursorColumn: "posted_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.expensePostedAuto,
        effect: "increment",
        matchColumn: "decision",
        matchValue: "auto"
      },
      {
        metricKey: OPERATIONAL_METRIC_KEYS.expensePostedApproved,
        effect: "increment",
        matchColumn: "decision",
        matchValue: "approved"
      }
    ],
    dimensional: EXPENSE_POSTED_SINK
  },
  {
    streamKey: OPERATIONAL_STREAM_KEYS.expensesReversed,
    tableName: "awcms_commerce_report_src_expenses_reversed",
    cursorColumn: "reversed_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.expenseReversed,
        effect: "increment",
        matchColumn: "status",
        matchValue: "reversed"
      }
    ],
    dimensional: EXPENSE_REVERSED_SINK
  }
];

const LOYALTY_DAILY_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.loyaltyLedger,
    tableName: "awcms_commerce_loyalty_ledger",
    cursorColumn: "created_at",
    metrics: [
      { metricKey: OPERATIONAL_METRIC_KEYS.loyaltyEntries, effect: "increment" }
    ],
    dimensional: LOYALTY_SINK
  }
];

const STORED_VALUE_DAILY_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.storedValueLedger,
    tableName: "awcms_commerce_stored_value_ledger",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.storedValueEntries,
        effect: "increment"
      }
    ],
    dimensional: STORED_VALUE_SINK
  }
];

/**
 * Issue #316 - the returns & refunds family: three streams, each over a source
 * whose cursor is NOT NULL from insert, so no `security_invoker` view of its
 * own (sql/945 could not name the sql/994 tables anyway). The refund-leg stream
 * rides the sql/998 payment-allocation view and counts the same
 * `status = 'succeeded'` rows its scalar reconciliation can evaluate; only the
 * reversal legs a refund points at become report rows.
 */
const RETURNS_DAILY_STREAMS: readonly ProjectionCursorStream[] = [
  {
    streamKey: OPERATIONAL_STREAM_KEYS.returns,
    tableName: "awcms_commerce_returns",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.returnsRecorded,
        effect: "increment"
      }
    ],
    dimensional: RETURNS_SINK
  },
  {
    streamKey: OPERATIONAL_STREAM_KEYS.returnLines,
    tableName: "awcms_commerce_return_lines",
    cursorColumn: "created_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.returnLinesRecorded,
        effect: "increment"
      }
    ],
    dimensional: RETURN_LINES_SINK
  },
  {
    streamKey: OPERATIONAL_STREAM_KEYS.allocations,
    tableName: "awcms_commerce_report_src_allocations",
    cursorColumn: "settled_at",
    metrics: [
      {
        metricKey: OPERATIONAL_METRIC_KEYS.refundLegsScanned,
        effect: "increment",
        matchColumn: "status",
        matchValue: "succeeded"
      }
    ],
    dimensional: REFUND_LEGS_SINK
  }
];

/**
 * `commerce` (Issue #4, part of epic #1; brought to full product-model parity
 * by Issue #23, part of epic #21) — tenant-scoped product categories
 * (hierarchical, self-referencing) and products, ported from the legacy
 * MySQL `commerce_bj_mart.{categories,products}` tables. Issue #4 took the
 * 13-column catalog CORE; Issue #23 adds every column that slice's own README
 * named as deliberately deferred (tiered pricing, cost price, weight,
 * ratings, insurance, promo banners, size charts, service forms,
 * subscriptions, digital downloads, deposits/free-shipping, variant
 * attributes, two explicit merchandising flags) plus the two related tables
 * a real product page cannot render without: `product_images` and
 * `product_variants`.
 *
 * `price`/`priceLevel2/3/4`/`costPrice`/`insuranceFee`/`finalPrice` are all
 * `numeric(14,2)`, never a float (`sql/901`'s header has the full
 * arithmetic-drift reasoning) — `Bun.SQL` hands each back as a STRING, and
 * this module never parses one to a number; `finalPrice` is computed in
 * integer cents (`domain/price-calculation.ts`).
 *
 * `dependencies` gains `media_library` in Issue #23: `product_images`
 * references `awcms_news_media_objects`, and the public DTO resolves it to a
 * public URL through `MediaLibraryPort` — the same capability
 * `blog_content` already consumes for exactly this reason.
 *
 * `costPrice` is admin-only — `application/product-directory.ts`'s public
 * `toRecord()` never puts it on the DTO a public route/storefront reads;
 * `toAdminRecord()` (the admin screen's own fetch) does. See `sql/904`'s
 * header for the column-level reasoning.
 */
export const commerceModule = defineModule({
  key: "commerce",
  name: "Commerce",
  version: "0.2.0",
  status: "active",
  description:
    "Full BjekMart product-model parity (Issue #23, epic #21) on top of the Issue #4 catalog core, now joined by the marketing surface BjekMart's home page and promotions run on (Issue #26): tenant-scoped product categories (hierarchical, self-referencing parent, with a computed productCount) and products (physical/digital/service/subscription) carrying tiered pricing, cost price (admin-only), weight, manual rating/sold-count, insurance, promo banners, a size chart (image or table), a service intake form, subscription period, a digital download link, deposit/free-shipping flags, variant attributes, and explicit is_featured/is_recommended merchandising flags — plus the product_images and product_variants tables a real product page needs; flash sales (with a time-derived status and a scheduled tick job), vouchers (percentage/nominal/free-shipping, validated in integer cents), sliders, testimonials, a single-active promo popup, and a versioned per-tenant store-settings blob. price/priceLevel2-4/costPrice/insuranceFee/finalPrice/flash-sale/voucher amounts are all numeric(14,2) and cross the wire as strings, never floats. Depends on media_library for product image references and this module's own slider/testimonial/popup/logo images. Ships restore endpoints for categories and products (Issue #23); the Issue #26 marketing tables ship soft delete only, no restore.",
  dependencies: [
    "tenant_admin",
    "identity_access",
    "domain_event_runtime",
    "media_library",
    // Issue #29 — `application/public-commerce-tenant.ts` calls
    // `fetchTenantModuleEntry` (`module_management`'s own application layer)
    // to fail-closed when a tenant has not enabled `commerce`, the same
    // dependency `newsletter`'s own public tenant resolver already declares
    // for the identical call.
    "module_management",
    // Issue #89 — `application/customer-otp-channel-adapters.ts` calls
    // `enqueueDirectAddressEmail` directly, the same way `newsletter`'s own
    // `subscribe.ts` calls it for its confirmation mail, rather than a port
    // owned by `email` (unlike `identity_access`'s `AuthNotificationPort`,
    // which exists because THAT module cannot depend on `email` at all).
    "email",
    // Issue #87 — `application/customer-account-store.ts` calls
    // `maskIdentifierValue` for the customer account e-mail, the SAME
    // masking `newsletter`/`comments`/`email` already depend on
    // `profile_identity` for, and for the same reason: one masking rule,
    // not a second copy that eventually disagrees with the first.
    "profile_identity",
    // Issue #282 (ADR-0038) - `application/commerce-inventory.ts` posts every
    // stock change of a `ledger`-mode tenant through `inventory`'s in-process
    // `InventoryLedgerPort` adapter, and `sql/947` holds a composite FK to its
    // locations. `inventory` does not depend on `commerce`, so this is a DAG edge.
    "inventory",
    // Issue #107 — `application/shipping-rate-directory.ts`'s
    // `resolveDestination` calls `getRegionByCode`
    // (`idn_admin_regions/application/region-lookup.ts`) to turn a
    // tenant's own district code into the district/city name pair a
    // courier provider's destination search needs.
    "idn_admin_regions",
    // Issue #293 (ADR-0039) — `application/tax-adapter-directory.ts` and
    // `domain/tax-adapter.ts` call the `tax` module's calculator, rule-version
    // resolver and snapshot finalise/reverse functions in process (the accepted
    // pattern, as with `email`); `tax` never depends on commerce.
    "tax"
  ],
  type: "domain",
  isCore: false,
  api: {
    openApiPath: "openapi/modules/commerce.openapi.yaml",
    basePath: "/api/v1/commerce",
    // Issue #117 — the three sales-report read routes live under the
    // `reporting` module's `/api/v1/reports` family by contract (#106: "read
    // through the reporting module's projection read path", gated on
    // `reporting.dashboard.read`), but their handlers read THIS module's
    // projection tables through this module's own application code, so this
    // module owns them (longest prefix wins over `reporting`'s claim).
    routes: ["/api/v1/commerce", "/api/v1/reports/commerce"]
  },
  /**
   * Issue #117 (C8, contract #106 / ADR-0017 D7) — three `cursor_table`
   * projections over the append-only order-event log, maintained by the
   * `reporting` engine (`bun run reporting:projections:refresh`) into this
   * module's own `awcms_commerce_sales_*` tables (sql/933). Delta rules:
   * `-> paid` adds the order's totals/items, `-> cancelled|refunded` after a
   * paid state subtracts them (`domain/sales-report-deltas.ts`, pure);
   * sinks/reset/reconcile/export hooks in
   * `application/sales-report-projection.ts`; read routes under
   * `/api/v1/reports/commerce/*`; screen `/admin/commerce-reports`.
   */
  reportingProjections: [
    salesReportProjection({
      key: SALES_DAILY_PROJECTION_KEY,
      description:
        "Per-day sales: paid order count, gross (sum of order subtotals), discount (order + voucher discounts), shipping and net (order totals), attributed to the day of each order's paid_at in the report time zone. A cancellation or refund of a paid order subtracts from the same day it was added to, so net is a true per-day net.",
      sink: SALES_DAILY_SINK,
      dimensional: SALES_DAILY_DIMENSIONAL,
      drillDownPath: "/api/v1/reports/commerce/sales-daily"
    }),
    salesReportProjection({
      key: SALES_BY_PRODUCT_PROJECTION_KEY,
      description:
        "Per-day, per-product quantity and gross (sum of line totals) from paid orders, with the product name as snapshotted on the order line; reversals subtract. The read route groups a date range by product.",
      sink: SALES_BY_PRODUCT_SINK,
      dimensional: SALES_BY_PRODUCT_DIMENSIONAL,
      drillDownPath: "/api/v1/reports/commerce/sales-by-product"
    }),
    salesReportProjection({
      key: SALES_BY_CATEGORY_PROJECTION_KEY,
      description:
        "Per-day, per-category quantity and gross from paid orders, attributed through the product's category at processing time (a product without a category lands in the uncategorised bucket); reversals subtract. The read route groups a date range by category.",
      sink: SALES_BY_CATEGORY_SINK,
      dimensional: SALES_BY_CATEGORY_DIMENSIONAL,
      drillDownPath: "/api/v1/reports/commerce/sales-by-category"
    }),
    // Issue #296 (ADR-0035) - the six POS operational projections. Each is
    // rebuildable from its source ledger, reconciles by control totals, and
    // is read through `/api/v1/reports/commerce/operational-*`.
    operationalReportProjection({
      key: POS_TENDER_DAILY_PROJECTION_KEY,
      description:
        "Per-day, per-register, per-tender money movement from the payment-allocation ledger: payment and reversal counts and sums (net is derived), attributed to the day each leg SETTLED in the report time zone. A leg that settles after midnight lands on the settlement day; a pending or failed leg never counts.",
      streams: TENDER_DAILY_STREAMS,
      dimensional: TENDER_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.tenderSucceeded]:
          "Succeeded payment legs consumed"
      },
      requiredPermission: COMMERCE_REPORT_TENDER_PERMISSIONS.read,
      drillDownPath: "/api/v1/reports/commerce/tender-mix"
    }),
    operationalReportProjection({
      key: POS_CASH_UP_VARIANCE_PROJECTION_KEY,
      description:
        "Per register session and tender: the expected and counted amounts of the close that closed it (auto-approved or approved attempts only) plus the signed corrections applied after, attributed to the day the session closed. Variance is counted with corrections minus expected; negative is short.",
      streams: CASH_UP_STREAMS,
      dimensional: CASH_UP_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.cashUpAuto]: "Auto-approved cash-ups consumed",
        [OPERATIONAL_METRIC_KEYS.cashUpApproved]: "Approved cash-ups consumed",
        [OPERATIONAL_METRIC_KEYS.corrections]: "Cash-up corrections consumed"
      },
      requiredPermission: COMMERCE_REPORT_CASH_UP_PERMISSIONS.read,
      drillDownPath: "/api/v1/commerce/register-sessions"
    }),
    operationalReportProjection({
      key: POS_EXPENSE_DAILY_PROJECTION_KEY,
      description:
        "Per business day, expense category and tender: posted expense counts and sums, with a reversal added to the reversed columns of the SAME day row its posting landed on (the day is the expense's occurred-on date, not an instant). Drafts, pending and cancelled expenses never count.",
      streams: EXPENSE_DAILY_STREAMS,
      dimensional: EXPENSE_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.expensePostedAuto]:
          "Auto-posted expenses consumed",
        [OPERATIONAL_METRIC_KEYS.expensePostedApproved]:
          "Approved expenses consumed",
        [OPERATIONAL_METRIC_KEYS.expenseReversed]: "Expense reversals consumed"
      },
      requiredPermission: COMMERCE_REPORT_EXPENSE_PERMISSIONS.read,
      drillDownPath: "/api/v1/commerce/expenses/summary"
    }),
    operationalReportProjection({
      key: POS_LOYALTY_DAILY_PROJECTION_KEY,
      description:
        "Per day and bucket (earned, redeemed, expired, adjusted up/down, reversed up/down): entries and signed points from the append-only loyalty ledger, attributed to the day each entry was written. Outstanding points are the running sum of every bucket.",
      streams: LOYALTY_DAILY_STREAMS,
      dimensional: LOYALTY_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.loyaltyEntries]:
          "Loyalty ledger entries consumed"
      },
      requiredPermission: COMMERCE_REPORT_LOYALTY_PERMISSIONS.read,
      drillDownPath: "/api/v1/commerce/loyalty/accounts"
    }),
    operationalReportProjection({
      key: POS_STORED_VALUE_DAILY_PROJECTION_KEY,
      description:
        "Per day, account kind (gift card, store credit) and bucket (issued, loaded, redeemed, refunded, expired, adjusted up/down): entries and signed amounts from the append-only stored-value ledger. Outstanding liability is the running sum of every bucket.",
      streams: STORED_VALUE_DAILY_STREAMS,
      dimensional: STORED_VALUE_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.storedValueEntries]:
          "Stored-value ledger entries consumed"
      },
      requiredPermission: COMMERCE_REPORT_STORED_VALUE_PERMISSIONS.read,
      drillDownPath: "/api/v1/reports/commerce/stored-value"
    }),
    // Issue #316 - the returns & refunds family (ADR-0035 D1's returns
    // contract), gated on the `returns` feature.
    operationalReportProjection({
      key: POS_RETURNS_DAILY_PROJECTION_KEY,
      description:
        "Per day and register: returns and exchanges recorded (count and refund total), returned lines by stock disposition (restocked, damaged/written off, quarantined: lines, units, value) and settled refund legs by tender and destination (original tender or store credit). Returns and lines land on the day they were recorded and the register of the original sale; a refund leg on the day it settled.",
      streams: RETURNS_DAILY_STREAMS,
      dimensional: RETURNS_DIMENSIONAL,
      metricLabels: {
        [OPERATIONAL_METRIC_KEYS.returnsRecorded]: "Returns recorded consumed",
        [OPERATIONAL_METRIC_KEYS.returnLinesRecorded]:
          "Returned lines consumed",
        [OPERATIONAL_METRIC_KEYS.refundLegsScanned]:
          "Succeeded ledger legs scanned for refunds"
      },
      requiredPermission: COMMERCE_REPORT_RETURN_PERMISSIONS.read,
      drillDownPath: "/api/v1/commerce/returns"
    })
  ],
  events: {
    asyncApiPath: "asyncapi/awcms-domain-events.asyncapi.yaml",
    publishes: [
      COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
      COMMERCE_PRODUCT_UPDATED_EVENT_TYPE,
      COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
      COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE,
      COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE,
      COMMERCE_ORDER_CREATED_EVENT_TYPE,
      COMMERCE_ORDER_PAID_EVENT_TYPE,
      COMMERCE_ORDER_STATUS_CHANGED_EVENT_TYPE,
      COMMERCE_ORDER_CANCELLED_EVENT_TYPE,
      COMMERCE_QUOTATION_ACCEPTED_EVENT_TYPE,
      COMMERCE_QUOTATION_CONVERTED_EVENT_TYPE,
      COMMERCE_WORK_ORDER_STATUS_CHANGED_EVENT_TYPE,
      COMMERCE_DOCUMENT_ISSUED_EVENT_TYPE,
      COMMERCE_ORDER_EXPIRED_EVENT_TYPE,
      COMMERCE_VOUCHER_REDEEMED_EVENT_TYPE,
      COMMERCE_REVIEW_PUBLISHED_EVENT_TYPE,
      COMMERCE_PAYMENT_RECORDED_EVENT_TYPE,
      COMMERCE_PAYMENT_REVERSED_EVENT_TYPE,
      COMMERCE_REGISTER_SESSION_OPENED_EVENT_TYPE,
      COMMERCE_REGISTER_SESSION_MOVEMENT_RECORDED_EVENT_TYPE,
      COMMERCE_REGISTER_SESSION_CLOSED_EVENT_TYPE,
      COMMERCE_REGISTER_SESSION_CORRECTED_EVENT_TYPE,
      COMMERCE_LOYALTY_ENTRY_RECORDED_EVENT_TYPE,
      COMMERCE_STORED_VALUE_ENTRY_RECORDED_EVENT_TYPE,
      COMMERCE_EXPENSE_POSTED_EVENT_TYPE,
      COMMERCE_EXPENSE_REVERSED_EVENT_TYPE,
      COMMERCE_DOCUMENT_DELIVERY_REQUESTED_EVENT_TYPE,
      COMMERCE_RETURN_RECORDED_EVENT_TYPE,
      COMMERCE_REFUND_SETTLED_EVENT_TYPE
    ]
  },
  /**
   * `commerce:flash-sales:tick` (Issue #26) — the only job this module
   * declares. Every tenant, every non-draft/non-ended flash sale,
   * recomputes `domain/flash-sale-status.ts`'s `deriveFlashSaleStatus` and
   * persists it when it changed, firing `flash_sale.{started,ended}` on the
   * transition — see `scripts/commerce-flash-sales-tick.ts`. `bounded`: one
   * run costs no more than any later run (a bounded scan of live,
   * non-terminal rows, never an unbounded backlog), matching
   * `blog:publish:scheduled`'s own classification for the same reason.
   */
  jobs: [
    {
      command: "bun run commerce:flash-sales:tick",
      schedule: { mode: "cron", expression: "*/5 * * * *", backlog: "bounded" },
      purpose:
        "Recompute every active tenant's non-draft, non-ended flash sales against now() and persist the derived status, firing commerce.flash_sale.started/.ended on the transition. Idempotent — a sale whose derived status has not changed since the last tick is a no-op on re-run.",
      recommendedSchedule: "Every 1-5 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database transition, safe to run in any deployment profile.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:orders:expire",
      schedule: { mode: "cron", expression: "*/5 * * * *", backlog: "bounded" },
      purpose:
        "Move every pending_payment order in every active tenant whose expires_at has elapsed to expired, restocking its line items and un-redeeming its voucher (if any). Idempotent — an order already moved out of pending_payment is simply absent from the next tick's scan (FOR UPDATE SKIP LOCKED, bounded batch).",
      recommendedSchedule: "Every 1-5 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database transition, safe to run in any deployment profile.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:customer-auth:purge",
      schedule: {
        mode: "cron",
        expression: "*/15 * * * *",
        backlog: "bounded"
      },
      purpose:
        "Deletes every expired customer OTP and every expired or revoked-more-than-7-days-ago customer session, across all tenants (Issue #87). Idempotent and bounded — a row already deleted is simply absent from the next run's scan.",
      recommendedSchedule: "Every 5-15 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database DELETE, safe to run in any deployment profile.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:shipping-rates:purge",
      schedule: {
        mode: "cron",
        expression: "0 * * * *",
        backlog: "bounded"
      },
      purpose:
        "Deletes every expired awcms_commerce_shipping_rates row across all active tenants (Issue #107). Idempotent and bounded — a row already deleted is simply absent from the next run's scan.",
      recommendedSchedule: "Hourly via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database DELETE, safe to run in any deployment profile.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:whatsapp:dispatch",
      schedule: { mode: "cron", expression: "*/2 * * * *", backlog: "bounded" },
      purpose:
        "Drain the due WhatsApp delivery queue (claim-lease, retry/backoff, circuit breaker) for every active tenant (Issue #108).",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        'No-op when COMMERCE_WHATSAPP_ENABLED is not "true" — safe to schedule regardless of deployment profile (e.g. offline/LAN).',
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:whatsapp:purge",
      schedule: {
        mode: "cron",
        expression: "*/15 * * * *",
        backlog: "bounded"
      },
      purpose:
        "Deletes terminal (sent/failed) WhatsApp outbox messages and delivery attempts past their retention window, across all tenants (Issue #108). Idempotent and bounded.",
      recommendedSchedule: "Every 5-15 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database DELETE, safe to run in any deployment profile.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:payments:reconcile",
      schedule: { mode: "cron", expression: "*/2 * * * *", backlog: "bounded" },
      purpose:
        "Polls every payment-gateway session still pending more than 2 minutes across every active tenant (provider.fetchStatus, outside any DB transaction, timeout + circuit breaker), applying the same paid/expired transition path the webhook intake route uses; also expires every session past expires_at regardless of fetchStatus (Issue #113, contract #106 D2 — 'webhooks get lost'). Idempotent — a session already moved out of pending is simply absent from the next scan.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        "No-op when COMMERCE_PAYMENT_GATEWAY does not resolve to a configured provider — safe to schedule regardless of deployment profile (e.g. offline/LAN).",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:campaigns:dispatch",
      schedule: { mode: "cron", expression: "*/2 * * * *", backlog: "bounded" },
      purpose:
        "Fans a scheduled/sending campaign out into the same e-mail/WhatsApp outboxes D5/D7 already dispatch from, in pages of 200 (Issue #114). Resumable: a crash mid-dispatch is picked back up on the next tick from wherever awcms_commerce_campaign_recipients left off.",
      recommendedSchedule: "Every 1-2 minutes via cron/systemd timer.",
      environmentNotes:
        "No external provider call itself — only inserts into the e-mail/WhatsApp outbox tables; safe to schedule regardless of deployment profile (e.g. offline/LAN).",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:loyalty:expire",
      schedule: {
        mode: "cron",
        expression: "10 * * * *",
        backlog: "bounded"
      },
      purpose:
        "Expires every loyalty earn lot whose expires_at has passed across every active tenant, appending one `expire` ledger entry per lot (a zero-point marker when the lot was already fully spent) — never a delete or an update (Issue #289). Idempotent: a lot with an expire entry is anti-joined out of the next scan and cannot get a second one (unique index, sql/950). Bounded: 200 accounts per tenant per run, each in its own short transaction.",
      recommendedSchedule: "Hourly via cron/systemd timer.",
      environmentNotes:
        "No external provider call — pure database appends, safe to run in any deployment profile. Correctness does not depend on the cadence: a redemption or reversal expires the account's due lots itself under the account lock before it acts.",
      safeInOfflineLan: true
    },
    {
      command: "bun run commerce:loyalty:reconcile",
      schedule: {
        mode: "cron",
        expression: "40 2 * * *",
        backlog: "bounded"
      },
      purpose:
        "Recomputes every active tenant's loyalty balances from the append-only ledger and reports any account whose projected balance/version disagrees with it, plus any ledger row whose running balance_after is not the running sum (Issue #289). READ-ONLY: it never writes — repair is the authenticated POST /api/v1/commerce/loyalty/reconcile with repair:true. Exits non-zero (status partial) when drift is found so the scheduler surfaces it.",
      recommendedSchedule: "Daily, off-peak, via cron/systemd timer.",
      environmentNotes:
        "No external provider call — read-only database scan (bounded to 1000 findings per tenant), safe to run in any deployment profile.",
      safeInOfflineLan: true
    }
  ],
  /**
   * Issue #118 (epic #33 C9, contract #106 D10) — BjekMart's "Features"
   * screen. `schemaVersion: 1` because `commerce` never declared a
   * `settings` contract before this issue — there is no PRIOR commerce
   * settings row anywhere to migrate away from (`updateModuleSettings`'s own
   * `INSERT ... ON CONFLICT` always writes the descriptor's CURRENT
   * `schemaVersion`, and no `awcms_module_settings` row with
   * `module_key = 'commerce'` exists in any deployed database yet — grep the
   * `sql/9xx` range). The "schemaVersion bump" the issue names is this
   * declaration's very first version, not a bump away from an earlier one.
   *
   * The migration-free upgrade path for a tenant that saved a `commerce`
   * settings row BEFORE this issue does not exist YET either (same reason);
   * it is the FUTURE-FACING half of the design that matters here — a later
   * issue adding a sixth feature flag needs no migration and no schema
   * bump, because `domain/commerce-features.ts`'s `resolveCommerceFeatures`
   * resolves each flag independently against
   * `DEFAULT_COMMERCE_FEATURES`, never assumes the whole `features` object
   * exists, and `module-settings.ts`'s own shallow top-level merge already
   * guarantees a tenant who has never opened "Fitur" gets these defaults
   * verbatim (`mergeEffectiveSettings(defaults, {})` is the empty override
   * case; `defaults` — including `features` — passes straight through).
   *
   * Every flag but `register` (Issue #284, default OFF: it adds the
   * obligation of an open register session to every POS sale) defaults
   * `true`: shipping this settings document changes
   * NOTHING for an existing tenant that never opens the new "Fitur"
   * section (see `commerce-features.ts`'s own header for the full
   * reasoning). `pos` is enforced by issue #116's owner routes
   * (`pages/api/v1/commerce/pos/orders/index.ts`, 409 `FEATURE_DISABLED`
   * when off) and by the `/admin/commerce-pos` navigation entry below.
   */
  settings: {
    schemaVersion: 1,
    defaults: {
      features: { ...DEFAULT_COMMERCE_FEATURES },
      // Issue #284 (ADR-0028) — the cash-up variance above which a close needs
      // a user holding `commerce.register_cash_ups.approve`. `"0.00"` = any
      // discrepancy needs a supervisor (strict by default); read defensively
      // by `domain/register.ts`'s `resolveCashUpSettings`. A new top-level
      // key, so no schemaVersion bump: a tenant that never touches it gets
      // this default through `mergeEffectiveSettings`.
      //
      // `allowSelfApproval` (default `false`): the cashier who counted may not
      // approve their own variance unless the tenant opts in (SoD).
      cashUp: {
        approvalThreshold: DEFAULT_CASH_UP_APPROVAL_THRESHOLD,
        allowSelfApproval: false
      },
      // Issue #294 (ADR-0031) - the expense amount above which posting needs
      // a user holding `commerce.expense_postings.approve` who did not create
      // the expense. `"0.00"` = every expense needs a second person (strict by
      // default); read defensively by `domain/expense.ts`'s
      // `resolveExpenseSettings`. Same shallow-merge rule as `cashUp`.
      expenses: { approvalThreshold: DEFAULT_EXPENSE_APPROVAL_THRESHOLD },
      // Issue #292 (ADR-0032) - the tenant's default POS keyboard shortcut
      // overrides (`{ action: "Alt+Shift+S" }`), layered over the built-in map
      // and under each cashier's own. Empty = the built-in map. Read
      // defensively by `domain/pos-shortcuts.ts`'s `readTenantShortcutSettings`
      // (an invalid or colliding entry is dropped, never trusted).
      posShortcuts: {}
    }
  },
  // Full CRUD screens: two as of Issue #23 (`src/pages/admin/commerce.astro`,
  // `commerce-categories.astro`), six more added by Issue #26 for the
  // marketing surface — every ACTIVE module must have at least one screen
  // (`admin-media-page-contract.test.ts`'s "no active module is left without
  // an admin screen — ZERO exceptions"), and every one of this module's
  // fourteen declared permissions is now claimed by one of the eight.
  // `admin.menu_type.commerce` (`sidebar-menu.ts`) predates this module by
  // design — ADR-0035 reserved the slot.
  navigation: [
    // Issue #171 — the commerce overview: today's orders/revenue, the 14-day
    // sales-report trend, and a real "needs attention" list. Gated on
    // `orders.read` (the same permission `commerce-orders.astro` uses) since
    // that is the narrowest permission that already covers the page's own
    // primary content; the page's own `can()` checks additionally hide each
    // "needs attention" entry a viewer cannot read.
    {
      labelKey: "admin.layout.nav_commerce_dashboard",
      path: "/admin/commerce-dashboard",
      order: 0,
      requiredPermission: "commerce.orders.read"
    },
    {
      labelKey: "admin.layout.nav_commerce",
      path: "/admin/commerce",
      order: 1,
      requiredPermission: "commerce.products.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_categories",
      path: "/admin/commerce-categories",
      order: 2,
      requiredPermission: "commerce.categories.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_flash_sales",
      path: "/admin/commerce-flash-sales",
      order: 3,
      requiredPermission: "commerce.flash_sales.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_vouchers",
      path: "/admin/commerce-vouchers",
      order: 4,
      requiredPermission: "commerce.vouchers.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_sliders",
      path: "/admin/commerce-sliders",
      order: 5,
      requiredPermission: "commerce.sliders.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_testimonials",
      path: "/admin/commerce-testimonials",
      order: 6,
      requiredPermission: "commerce.testimonials.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_popup",
      path: "/admin/commerce-popup",
      order: 7,
      requiredPermission: "commerce.popups.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_settings",
      path: "/admin/commerce-settings",
      order: 8,
      requiredPermission: "commerce.settings.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_orders",
      path: "/admin/commerce-orders",
      order: 9,
      requiredPermission: "commerce.orders.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_customers",
      path: "/admin/commerce-customers",
      order: 10,
      requiredPermission: "commerce.customers.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_reviews",
      path: "/admin/commerce-reviews",
      order: 11,
      requiredPermission: "commerce.reviews.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_affiliates",
      path: "/admin/commerce-affiliates",
      order: 12,
      requiredPermission: "commerce.affiliates.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_whatsapp",
      path: "/admin/commerce-whatsapp",
      order: 13,
      requiredPermission: "commerce.whatsapp.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_inbox",
      path: "/admin/commerce-inbox",
      order: 14,
      requiredPermission: "commerce.conversations.read",
      // Issue #118 — hidden the moment the tenant turns `features.inbox`
      // off, on top of the existing permission gate.
      requiredFeature: { moduleKey: "commerce", feature: "inbox" }
    },
    {
      labelKey: "admin.layout.nav_commerce_campaigns",
      path: "/admin/commerce-campaigns",
      order: 15,
      requiredPermission: "commerce.campaigns.read",
      requiredFeature: { moduleKey: "commerce", feature: "campaigns" }
    },
    // Issue #117 — the sales reports screen sits under Commerce but is gated
    // on `reporting.dashboard.read`, the same permission its three read
    // routes and the generic `/api/v1/reports/*` views use (contract #106).
    {
      labelKey: "admin.layout.nav_commerce_reports",
      path: "/admin/commerce-reports",
      order: 16,
      requiredPermission: "reporting.dashboard.read"
    },
    // Issue #116 — point of sale. Gated on the POS create permission (the
    // only permission-gated order-creation path) and hidden the moment the
    // tenant turns `features.pos` off (#118).
    {
      labelKey: "admin.layout.nav_commerce_pos",
      path: "/admin/commerce-pos",
      order: 17,
      requiredPermission: "commerce.pos.create",
      requiredFeature: { moduleKey: "commerce", feature: "pos" }
    },
    // Issue #284 (ADR-0028) - registers, sessions and cash-up. Gated on the
    // session-read permission and hidden the moment the tenant turns
    // `features.register` off (it defaults OFF).
    {
      labelKey: "admin.layout.nav_commerce_registers",
      path: "/admin/commerce-registers",
      order: 19,
      requiredPermission: "commerce.register_sessions.read",
      requiredFeature: { moduleKey: "commerce", feature: "register" }
    },
    // Issue #286 (ADR-0029) - held sales, quotations, work orders and
    // receipt/invoice documents. Gated on the document-read permission and
    // hidden the moment the tenant turns `features.documents` off (it defaults
    // OFF).
    {
      labelKey: "admin.layout.nav_commerce_documents",
      path: "/admin/commerce-documents",
      order: 22,
      requiredPermission: "commerce.documents.read",
      requiredFeature: { moduleKey: "commerce", feature: "documents" }
    },
    // Issue #291 — typed catalog attributes (definition management) and the
    // catalog CSV import/export screen.
    {
      labelKey: "admin.layout.nav_commerce_attributes",
      path: "/admin/commerce-attributes",
      order: 20,
      requiredPermission: "commerce.attributes.read"
    },
    {
      labelKey: "admin.layout.nav_commerce_catalog_import",
      path: "/admin/commerce-catalog-import",
      order: 21,
      requiredPermission: "commerce.products.import"
    },
    // Issue #289 — loyalty programs, balances and the points ledger. Gated on
    // `loyalty.read` and hidden unless the tenant turned `features.loyalty`
    // on (default OFF).
    {
      labelKey: "admin.layout.nav_commerce_loyalty",
      path: "/admin/commerce-loyalty",
      order: 18,
      requiredPermission: "commerce.loyalty.read",
      requiredFeature: { moduleKey: "commerce", feature: "loyalty" }
    },
    // Issue #288 (ADR-0030) - gift cards and store credit. Gated on the
    // account-read permission and hidden the moment the tenant turns
    // `features.storedValue` off (it defaults OFF).
    {
      labelKey: "admin.layout.nav_commerce_stored_value",
      path: "/admin/commerce-stored-value",
      order: 25,
      requiredPermission: "commerce.stored_value.read",
      requiredFeature: { moduleKey: "commerce", feature: "storedValue" }
    },
    // Issue #294 (ADR-0031) - petty cash and operational expenses. Gated on
    // the expense-read permission and hidden the moment the tenant turns
    // `features.expenses` off (it defaults OFF).
    {
      labelKey: "admin.layout.nav_commerce_expenses",
      path: "/admin/commerce-expenses",
      order: 26,
      requiredPermission: "commerce.expenses.read",
      requiredFeature: { moduleKey: "commerce", feature: "expenses" }
    },
    // Issue #292 (ADR-0032) - barcodes and label printing. Hidden the moment
    // the tenant turns `features.barcode` off (it defaults OFF).
    {
      labelKey: "admin.layout.nav_commerce_labels",
      path: "/admin/commerce-labels",
      order: 27,
      requiredPermission: "commerce.barcodes.read",
      requiredFeature: { moduleKey: "commerce", feature: "barcode" }
    }
  ],
  /**
   * ADR-0037 (`data_lifecycle`) — Issue #437's table-coverage gate requires
   * every table to answer the retention question. All four descriptors here
   * share the same shape Issue #4 established for the first two: a live
   * catalog row has no natural age limit, so the generic engine purges only
   * already-SOFT-DELETED rows once they age past the retention window, keyed
   * on `cursorColumn: "deleted_at"` (a live row's `deleted_at IS NULL` can
   * never match `deleted_at < $2` in SQL, so the engine is mathematically
   * incapable of reaching one — see the categories/products descriptors'
   * original comment, unchanged by Issue #23's restore endpoints: a row that
   * WAS restored has `deleted_at IS NULL` again, so it is just as
   * unreachable as one that was never deleted).
   */
  dataLifecycle: [
    {
      key: "commerce.categories",
      tableName: "awcms_commerce_categories",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // The window describes how long a SOFT-DELETED category may sit before
      // an operator's retention sweep may hard-purge it — not how long a live
      // one lives, which is forever. Wide, for the same reason
      // `blog_content.blog_institutions` picked this range: a wrongly-deleted
      // category is often noticed only when an old product page 404s.
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's category tree is bounded by its own merchandising, not by traffic — even a large catalog's category count reaches the low thousands, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A category is a name, a slug, an icon and a parent id — reconstructible from the tenant's own admin records and not evidence of anything. Nothing here is lost by a plain hard delete once purge-eligible."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row — see this array's header comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_categories_tenant_deleted_idx (sql/901) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above). A purge is irreversible outside a restore — the API-level restore (Issue #23) only un-deletes a row that HAS NOT yet been purged.",
      executionMode: "generic"
    },
    {
      key: "commerce.products",
      tableName: "awcms_commerce_products",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // Same window and the same reasoning as the category descriptor above
      // — see its comment.
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's product catalog is bounded by its own merchandising, not by traffic — even a large retail catalog reaches the low thousands of rows, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A product row is the merchant's own catalog description (sku, name, price, stock, ...) — reconstructible from their own records and not evidence of anything. Nothing here is lost by a plain hard delete once purge-eligible."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row — see this array's header comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_products_tenant_deleted_idx (sql/901) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above). A purge is irreversible outside a restore — the API-level restore (Issue #23) only un-deletes a row that HAS NOT yet been purged.",
      executionMode: "generic"
    },
    {
      key: "commerce.product_images",
      tableName: "awcms_commerce_product_images",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // Same window as the parent product table — an image's lifecycle
      // follows its product's, and a merchant who restores a product within
      // the window expects its pictures still there.
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the product catalog it illustrates — a few images per product, at the same low-thousands-of-products scale `commerce.products` already argues is not partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The row is only a (product, media object, sort order, alt text) join — the actual image bytes live in the media registry (`media_library`'s own retention governs those), so nothing irreplaceable is lost by hard-deleting this join row."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_product_images_tenant_deleted_idx (sql/905) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purge is irreversible; re-adding the image reference is the only recovery.",
      executionMode: "generic"
    },
    {
      key: "commerce.product_variants",
      tableName: "awcms_commerce_product_variants",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the product catalog — a handful of variants per product, the same low-thousands-of-products scale `commerce.products` already argues is not partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A variant row is the merchant's own catalog description (name/value/sku/price/stock) — reconstructible from their own records, same reasoning `commerce.products`' own descriptor gives."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_product_variants_tenant_deleted_idx (sql/905) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purge is irreversible.",
      executionMode: "generic"
    },
    {
      key: "commerce.flash_sales",
      tableName: "awcms_commerce_flash_sales",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's flash-sale calendar is bounded by its own merchandising cadence, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A flash sale is the merchant's own promotion description (name, slug, window) — reconstructible from their own records, not evidence of anything."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_flash_sales_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.flash_sale_products",
      tableName: "awcms_commerce_flash_sale_products",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the flash-sale calendar it belongs to — a handful of product lines per sale."
      },
      archive: {
        archivable: false,
        rationale:
          "A (flash sale, product, variant) join row with its own sale_price/quota/sold — reconstructible from the merchant's own records."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_flash_sale_products_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.vouchers",
      tableName: "awcms_commerce_vouchers",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's voucher catalog is bounded by its own promotion cadence, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A voucher is the merchant's own promotion description (code, discount rule, window, quota) — reconstructible from their own records."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_vouchers_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.sliders",
      tableName: "awcms_commerce_sliders",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's home-page slider deck is a handful of rows by construction, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A slider row is a (title, subtitle, media reference, link) tuple — the image bytes live in the media registry (its own retention governs those); nothing irreplaceable is lost by hard-deleting this row."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_sliders_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.testimonials",
      tableName: "awcms_commerce_testimonials",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's testimonial wall is a handful of rows by construction, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A short quote and rating an admin curated for marketing — reconstructible from the tenant's own records if ever needed again."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_testimonials_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.popups",
      tableName: "awcms_commerce_popups",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "At most one ACTIVE popup per tenant by construction (sql/909's own partial unique index); even the full history of past popups stays tiny."
      },
      archive: {
        archivable: false,
        rationale:
          "A popup row is marketing copy plus an optional media reference — reconstructible from the tenant's own records."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_popups_tenant_deleted_idx (sql/909) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      // One row per tenant, and `deleted_at` means "an owner reset the store to
      // defaults" (sql/910's header) — NOT that the tenant is gone. A live
      // settings row has no natural age limit (a courier fee set two years ago
      // and still charged is the healthy case), which is exactly why the cursor
      // is `deleted_at` and never `updated_at`: the engine's own `deleted_at <
      // $2` predicate is never true for NULL, so it cannot reach a live row.
      // `awcms_site_profile` answers the same question by exemption; this
      // table answers it with a column, because the exemption ledger is capped
      // and a column is the stronger answer.
      key: "commerce.store_settings",
      tableName: "awcms_commerce_store_settings",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "tenant_id is the primary key — the table can never hold more rows than awcms_tenants."
      },
      archive: {
        archivable: false,
        rationale:
          "A reset settings row is the merchant's own superseded configuration; the live configuration is whatever the next PUT wrote, and nothing here is evidence of anything."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here — a live (non-reset) row is unreachable."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_store_settings_tenant_deleted_idx (sql/910) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 100,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purged reset row is indistinguishable from a tenant that never saved settings — both read as the defaults.",
      executionMode: "generic"
    },
    /**
     * Issue #29's eight transactional tables. `commerce.orders` is the one
     * genuinely different shape in this array: an order is never
     * soft-deleted by this module's own code (`sql/913`'s header — the
     * `deleted_at` column exists only as a uniform cursor, always NULL), so
     * the "purge already-soft-deleted rows" story every OTHER descriptor
     * here tells does not apply to it at all. Its `retentionMaxDays` is
     * deliberately the widest in this file — fiscal/statutory retention,
     * not a housekeeping window — and `deletion.mode: "hard_delete"` stays
     * technically accurate only because it is, in practice, UNREACHABLE:
     * `cursorColumn: "deleted_at"` can never match a live order for the
     * same NULL-cursor reason every sibling descriptor already relies on.
     * `commerce.order_events` is the one exception in the OTHER direction:
     * an append-only audit trail with no `deleted_at` column at all, so its
     * cursor is `created_at` instead — a long window (it is evidence of
     * every state transition an order went through), never purged in
     * practice while the order it describes is still within ITS OWN
     * retention window.
     */
    {
      key: "commerce.customers",
      tableName: "awcms_commerce_customers",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant's guest-checkout customer roster is bounded by its own order volume, nowhere near partition-worthy volume for a single storefront."
      },
      archive: {
        archivable: false,
        rationale:
          "A name/phone/email/level/status row — reconstructible from the tenant's own order history and not evidence of anything on its own."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row — see this array's header comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_customers_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.customer_addresses",
      tableName: "awcms_commerce_customer_addresses",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own customer roster — a handful of saved addresses per customer at most."
      },
      archive: {
        archivable: false,
        rationale:
          "A saved shipping address snapshot — reconstructible from the customer's own order history."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_customer_addresses_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.orders",
      tableName: "awcms_commerce_orders",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // Fiscal/statutory retention, not a housekeeping window — an order is
      // the tenant's own transaction record. Widest window in this module
      // on purpose; see this array's header comment.
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own order volume — nowhere near partition-worthy for the deployment profile this module targets."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE: this module never soft-deletes an order (deleted_at stays NULL forever, sql/913's header) — the fiscal retention this descriptor exists to document is enforced by never matching the purge predicate, not by the predicate itself."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_orders_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. An order is never expected to reach this engine's purge predicate in practice.",
      executionMode: "generic"
    },
    {
      key: "commerce.order_items",
      tableName: "awcms_commerce_order_items",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale: "Bounded by its parent order's own line-item count."
      },
      archive: {
        archivable: false,
        rationale:
          "A per-line snapshot of a parent order this module never soft-deletes in practice."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Same practically-unreachable shape as its parent order (commerce.orders) — see that descriptor's comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_order_items_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.bundle_components",
      tableName: "awcms_commerce_bundle_components",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      // Issue #290 (ADR-0036). A bundle's component lines. A LIVE line has
      // `deleted_at IS NULL`, so the generic purge engine can never reach one;
      // only a line an edit REPLACED (soft-deleted) ages out, after the window
      // below. The window is the catalog family's "wide, a mistaken edit is
      // often noticed late" range.
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "At most 20 live lines per bundle product, admin-authored; replaced lines are short-lived. A catalog table, nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A bundle's definition is the merchant's own catalog description, reconstructible from their records; what a SOLD bundle was made of is the order's immutable snapshot (commerce.order_item_components), not this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe because the cursor column (deleted_at) is NULL for every live line, so a live line is never a purge candidate."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_bundle_components_tenant_deleted_idx (sql/953) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.order_item_components",
      tableName: "awcms_commerce_order_item_components",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #290 (ADR-0036). Append-only snapshot of a bundle order line's
      // components: no `deleted_at` column, so the cursor is `created_at`, the
      // same exception `commerce.order_events` takes. It is part of the order
      // record and follows its parent line's retention (ten years, the same
      // ceiling as `commerce.order_items`); a purged order item cascades its rows
      // away (sql/954), so this engine rarely reaches one.
      cursorColumn: "created_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by its parent order line: at most 20 rows per bundle line."
      },
      archive: {
        archivable: false,
        rationale:
          "A per-line snapshot of a parent order this module never soft-deletes in practice; it is what a later restock or return reads."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Same practically-unreachable shape as its parent order line (commerce.order_items); the rows also cascade with it."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_order_item_components_tenant_created_idx (sql/954) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.order_events",
      tableName: "awcms_commerce_order_events",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Append-only audit trail — no `deleted_at` column exists on this
      // table at all (sql/913's header), so the cursor is `created_at`
      // instead, the one exception to this array's usual `deleted_at`
      // convention (see this array's own header comment).
      cursorColumn: "created_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by its parent order's own status-transition count — a handful of rows per order at most."
      },
      archive: {
        archivable: false,
        rationale:
          "The order's own status timeline — evidence of what happened to a transaction the tenant already retains."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a genuinely old row (older than the parent order's own retention) is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_order_events_tenant_created_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by, keyed on created_at since this append-only table has no deleted_at."
        },
        {
          columns: ["order_id", "created_at"],
          purpose:
            "awcms_commerce_order_events_order_idx (sql/913) — this table's own timeline read."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.payment_confirmations",
      tableName: "awcms_commerce_payment_confirmations",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by its parent order's own confirmation count — usually one or two rows."
      },
      archive: {
        archivable: false,
        rationale:
          "A confirmation submission the tenant's own order record already retains."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Same practically-unreachable shape as its parent order — see commerce.orders' comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_payment_confirmations_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.reviews",
      tableName: "awcms_commerce_reviews",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale: "Bounded by a single storefront's own product/order volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A rating + free-text body a moderator already sees in the admin screen."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_reviews_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.wishlists",
      tableName: "awcms_commerce_wishlists",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own customer/product volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A bare (customer, product) saved-item pair — no route reads or writes it in this increment (see this module's README)."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe for the same NULL-cursor reason as every other descriptor here."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_wishlists_tenant_deleted_idx (sql/913) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.affiliates",
      tableName: "awcms_commerce_affiliates",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale: "Bounded by a single storefront's own customer volume."
      },
      archive: {
        archivable: false,
        rationale:
          "An enrolment row an owner already sees in the admin screen; this module never soft-deletes one in practice (PATCH only ever changes status/commission_rate)."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE the same way commerce.orders' descriptor already documents: deleted_at stays NULL forever in this increment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_affiliates_tenant_deleted_idx (sql/921) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.affiliate_commissions",
      tableName: "awcms_commerce_affiliate_commissions",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // Fiscal/payout-adjacent, same widest-window reasoning as
      // commerce.orders — a commission is money owed or paid to a real
      // customer.
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale: "Bounded by a single storefront's own referred-order volume."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE: this table's rows are never soft-deleted (a commission is voided via its own status column, never deleted_at) — deleted_at stays NULL forever, same shape commerce.orders' own descriptor documents."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_affiliate_commissions_tenant_deleted_idx (sql/921) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A commission is never expected to reach this engine's purge predicate in practice.",
      executionMode: "generic"
    },
    /**
     * Issue #87 (C1) — `awcms_commerce_customer_accounts` never soft-deletes
     * (a blocked account is `status = 'blocked'`, not purged) — the SAME
     * "safe cursor even though it always stays NULL" shape `commerce.orders`
     * above already uses, for the same reason: `data-lifecycle:table-coverage:check`
     * requires every table to answer the retention question, and `deleted_at`
     * (`sql/917`'s header) exists ONLY to give this descriptor a real,
     * honest column to name — the predicate `deleted_at < $cutoff` can
     * mathematically never match a row that stays `NULL` forever.
     */
    {
      key: "commerce.customer_accounts",
      tableName: "awcms_commerce_customer_accounts",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "operational_queue",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own registered-shopper volume — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE: this module never soft-deletes an account (deleted_at stays NULL forever, sql/917's header) — blocking (status='blocked') is how a stale/abusive account is actually handled."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_customer_accounts_tenant_deleted_idx (sql/917) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. An account is never expected to reach this engine's purge predicate in practice.",
      executionMode: "generic"
    },
    {
      key: "commerce.customer_otps",
      tableName: "awcms_commerce_customer_otps",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "expires_at",
      retentionClass: "operational_queue",
      retentionMinDays: 1,
      retentionMaxDays: 30,
      defaultRetentionDays: 7,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own OTP request volume — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A spent/expired one-time code — no evidentiary value once past its own TTL, nothing worth archiving."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches commerce:customer-auth:purge's own behaviour exactly — a straight DELETE of rows past expires_at, no cascading FK children."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["expires_at"],
          purpose:
            "awcms_commerce_customer_otps_expires_idx (sql/917) — the cursor commerce:customer-auth:purge's own DELETE filters on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run commerce:customer-auth:purge",
        purgeFunctionRef:
          "src/modules/commerce/application/customer-account-store.ts#consumeOtp (issuance/expiry) and scripts/commerce-customer-auth-purge.ts (deletion)",
        description:
          "Deletes every OTP whose expires_at has elapsed, across all tenants, in bounded batches, as awcms_worker (sql/918)."
      }
    },
    {
      key: "commerce.customer_sessions",
      tableName: "awcms_commerce_customer_sessions",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "expires_at",
      retentionClass: "operational_queue",
      retentionMinDays: 1,
      retentionMaxDays: 90,
      defaultRetentionDays: 37,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own active-session volume — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "An expired/revoked bearer session — no evidentiary value once dead, nothing worth archiving."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches commerce:customer-auth:purge's own behaviour exactly — deletes expired sessions and revoked sessions older than 7 days, no cascading FK children."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["expires_at"],
          purpose:
            "awcms_commerce_customer_sessions_expires_idx (sql/917) — the cursor commerce:customer-auth:purge's own DELETE filters on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run commerce:customer-auth:purge",
        purgeFunctionRef: "scripts/commerce-customer-auth-purge.ts",
        description:
          "Deletes every session whose expires_at has elapsed, and every revoked session older than 7 days, across all tenants, in bounded batches, as awcms_worker (sql/918)."
      }
    },
    {
      key: "commerce.courier_destinations",
      tableName: "awcms_commerce_courier_destinations",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "resolved_at",
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 365,
      defaultRetentionDays: 180,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the number of distinct districts a tenant ever ships to — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A district-code-to-provider-destination-id mapping — re-derivable at any time by a fresh provider name search, nothing lost by hard delete."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No cascading FK children; a stale row is simply re-resolved on its next cache miss (application/shipping-rate-directory.ts's resolveDestination)."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id"],
          purpose:
            "awcms_commerce_courier_destinations_tenant_idx (sql/924) — the tenant scan every purge/report over this table uses."
        },
        {
          columns: ["tenant_id", "resolved_at"],
          purpose:
            "awcms_commerce_courier_destinations_tenant_resolved_idx (sql/924) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. This table has no dedicated purge job today — resolved_at is retained for a future staleness sweep, and rows are otherwise only ever upserted, never deleted, by application code.",
      executionMode: "generic"
    },
    {
      key: "commerce.shipping_rates",
      tableName: "awcms_commerce_shipping_rates",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "expires_at",
      retentionClass: "operational_queue",
      retentionMinDays: 1,
      retentionMaxDays: 30,
      defaultRetentionDays: 1,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own (origin, destination, weight bucket, courier, service) combinations actually quoted — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A cached courier rate quote, valid for 6 hours — no evidentiary value once expired, nothing worth archiving."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Matches commerce:shipping-rates:purge's own behaviour exactly — a straight DELETE of rows past expires_at, no cascading FK children."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["expires_at"],
          purpose:
            "awcms_commerce_shipping_rates_expires_at_idx (sql/924) — the cursor commerce:shipping-rates:purge's own DELETE filters on."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run commerce:shipping-rates:purge",
        purgeFunctionRef:
          "src/modules/commerce/application/shipping-rate-directory.ts#purgeExpiredShippingRatesForTenant and scripts/commerce-shipping-rates-purge.ts",
        description:
          "Deletes every cached rate whose expires_at has elapsed, across all tenants, in bounded batches, as awcms_worker (sql/924)."
      }
    },
    // Issue #110, contract #106/ADR-0017 D2/D3 — the payment-gateway
    // schema's three new tables. None has a dedicated purge job in this
    // issue's scope (the reconciliation job is #113's own C5 follow-up);
    // each descriptor states that honestly rather than inventing one.
    {
      key: "commerce.payment_gateway_sessions",
      tableName: "awcms_commerce_payment_gateway_sessions",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "expires_at",
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 365,
      defaultRetentionDays: 90,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own gateway-checkout attempt volume — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "A hosted-checkout session record — the order it belongs to is the durable record of what was paid; this row is reconciliation metadata, nothing worth a standalone archive."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No cascading FK children; a session past its own expires_at has no further reconciliation value once #113's reconcile job (out of this issue's scope) has had a chance to poll it."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "expires_at"],
          purpose:
            "awcms_commerce_payment_gateway_sessions_tenant_expires_idx (sql/926) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. No purge job runs against this table yet — it is small and reconciliation-relevant for the lifetime of this issue's own scope.",
      executionMode: "generic"
    },
    {
      key: "commerce.payment_events",
      tableName: "awcms_commerce_payment_events",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "received_at",
      // Fiscal-adjacent — a payment provider's own callback about money
      // received/refunded on a real order — same widest-window reasoning
      // commerce.orders/commerce.affiliate_commissions already state.
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own inbound-webhook volume — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but this append-only replay-protection ledger (UNIQUE (tenant_id, provider, event_key)) is never expected to reach a purge predicate in practice within this issue's own retention window."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "received_at"],
          purpose:
            "awcms_commerce_payment_events_tenant_received_idx (sql/926) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. Nothing in this issue's scope writes to this table yet — the webhook INTAKE route (#113) is its first writer.",
      executionMode: "generic"
    },
    {
      key: "commerce.webhook_endpoints",
      tableName: "awcms_commerce_webhook_endpoints",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "revoked_at",
      retentionClass: "operational_queue",
      retentionMinDays: 30,
      retentionMaxDays: 365,
      defaultRetentionDays: 90,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own minted-token volume — an owner mints a handful of these, ever."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; a revoked endpoint carries no evidentiary value once its own audit-log entries (recordAuditEvent, this issue's create/revoke routes) already capture the lifecycle event."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "No cascading FK children; a revoked endpoint's token_hash is useless without the plaintext (never stored), so hard-deleting a long-revoked row loses nothing an operator could still act on."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "revoked_at"],
          purpose:
            "awcms_commerce_webhook_endpoints_tenant_revoked_idx (sql/926) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. No purge job runs against this table yet — a live (non-revoked) endpoint's revoked_at stays NULL forever and can never match this engine's age-based predicate.",
      executionMode: "generic"
    },
    // Issue #108, contract #106/ADR-0017 D5 — the WhatsApp outbox, same
    // "queue-shaped, purge-only, legalHold not applicable" treatment
    // `commerce.customer_otps`/`commerce.customer_sessions` above already
    // get: a spent delivery record carries no evidentiary value once dead.
    {
      key: "commerce.whatsapp_messages",
      tableName: "awcms_commerce_whatsapp_messages",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "updated_at",
      retentionClass: "operational_queue",
      retentionMinDays: 7,
      retentionMaxDays: 365,
      defaultRetentionDays: 90,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own WhatsApp send volume, drained continuously — the live set stays small."
      },
      archive: {
        archivable: false,
        rationale:
          "The row carries to_phone in the clear (same reasoning customers.phone and awcms_email_messages.to_address already document) — archiving would copy exactly that column into a second, longer-lived artefact."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Only terminal rows (sent/failed) are eligible; queued/sending rows are pending work, not history."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "status", "updated_at"],
          purpose:
            "awcms_commerce_whatsapp_messages_retention_idx (sql/925) — the purge's own path."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run commerce:whatsapp:purge",
        purgeFunctionRef:
          "src/modules/commerce/application/whatsapp-queue-purge.ts#purgeWhatsappQueue",
        description:
          "Deletes terminal (sent/failed) messages older than the cutoff in bounded batches, skipping any that still have attempt rows, as awcms_worker (sql/925)."
      }
    },
    {
      key: "commerce.whatsapp_delivery_attempts",
      tableName: "awcms_commerce_whatsapp_delivery_attempts",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "attempted_at",
      retentionClass: "operational_queue",
      retentionMinDays: 7,
      retentionMaxDays: 365,
      defaultRetentionDays: 30,
      partition: {
        eligible: false,
        rationale:
          "One row per ATTEMPT — drained continuously, short retention window, never range-scanned for history."
      },
      archive: {
        archivable: false,
        rationale:
          "A truncated, pre-redacted provider reply with a half-life of days — never contains the phone number or message body."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Append-only diagnostic rows with no status to transition to and no identifying column — the recipient never appears here, only a message FK."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "attempted_at"],
          purpose:
            "awcms_commerce_whatsapp_delivery_attempts_tenant_idx (sql/925) — the purge's own ascending scan path."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. The unique (message_id, attempt_no) constraint means a restore cannot produce duplicate attempt records for a message re-dispatched afterwards.",
      executionMode: "delegated",
      existingAdopter: {
        jobCommand: "bun run commerce:whatsapp:purge",
        purgeFunctionRef:
          "src/modules/commerce/application/whatsapp-queue-purge.ts#purgeWhatsappQueue",
        description:
          "Deletes attempt rows older than the cutoff in bounded batches, BEFORE the messages step so the foreign key ordering holds, as awcms_worker (sql/925)."
      }
    },
    // Issue #111, contract #106 D8 — the commerce inbox. `conversations`
    // follows the usual `deleted_at`-cursor convention (this increment ships
    // no route that ever sets it, the same "declared, unreachable in
    // practice" shape `commerce.categories`/`commerce.products` already have
    // — see this array's header comment); `messages` is append-only, like
    // `commerce.order_events` above, so its cursor is `created_at` instead.
    {
      key: "commerce.conversations",
      tableName: "awcms_commerce_conversations",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own customer-account count and support volume — nowhere near partition-worthy volume for a single storefront."
      },
      archive: {
        archivable: false,
        rationale:
          "A thread's own subject/status/unread flags — reconstructible from its own messages and not evidence of anything on its own."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row — see this array's header comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_conversations_tenant_deleted_idx (sql/927) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above).",
      executionMode: "generic"
    },
    {
      key: "commerce.messages",
      tableName: "awcms_commerce_messages",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: false,
        rationale:
          "Bounded by its parent conversation's own message count — a handful to a few dozen rows per thread."
      },
      archive: {
        archivable: false,
        rationale:
          "A message's own body — the conversation transcript the tenant's own support record already retains."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a genuinely old row (older than the parent conversation's own retention) is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_messages_tenant_created_idx (sql/927) — the (tenant, cursor) composite the generic purge engine filters + orders by, keyed on created_at since this append-only table has no deleted_at."
        },
        {
          columns: ["conversation_id", "created_at"],
          purpose:
            "awcms_commerce_messages_conversation_idx (sql/927) — this table's own thread transcript read."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    // Issue #114, contract #106 D9 — customer campaigns. `campaigns` follows
    // the usual `deleted_at`-cursor convention (no admin route ever sets it
    // in this increment, same "declared, unreachable in practice" shape
    // `commerce.categories`/`commerce.conversations` above already have);
    // `campaign_recipients` is append-only per campaign (a recipient row is
    // never edited once inserted), so its cursor is `created_at`, mirroring
    // `commerce.messages`' own choice just above.
    {
      key: "commerce.campaigns",
      tableName: "awcms_commerce_campaigns",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own campaign cadence — nowhere near partition-worthy volume for a single storefront."
      },
      archive: {
        archivable: false,
        rationale:
          "A campaign's own subject/body/audience filter — the tenant's own record of what it sent, reconstructible from its own drafting history and not evidence of anything beyond that."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode. Safe here specifically because the cursor column (deleted_at) is NULL for every live row — see this array's header comment."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_campaigns_tenant_deleted_idx (sql/929) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above).",
      executionMode: "generic"
    },
    {
      key: "commerce.campaign_recipients",
      tableName: "awcms_commerce_campaign_recipients",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "created_at",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own consented-audience size times campaign count — nowhere near partition-worthy volume for a single storefront."
      },
      archive: {
        archivable: false,
        rationale:
          "A masked address plus a dispatch status — the resumability/audit ledger a partial send relies on, not evidence of anything once the campaign it belongs to has aged out."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a genuinely old row (older than the parent campaign's own retention) is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "The (tenant, cursor) composite the generic purge engine filters + orders by, keyed on created_at since this append-only table has no deleted_at."
        },
        {
          columns: ["campaign_id"],
          purpose:
            "awcms_commerce_campaign_recipients_campaign_idx (sql/929) — the dispatcher's own per-campaign resolve/resume scan."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.sales_daily",
      tableName: "awcms_commerce_sales_daily",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #117 — a DERIVED reporting projection (sql/933): one row per
      // (tenant, day), maintained by the `reporting` engine from
      // `awcms_commerce_order_events` and fully rebuildable from it. The
      // cursor is the report `day` itself: a row older than the retention
      // window is unrecoverable by a rebuild anyway once `commerce.order_events`
      // (same ceiling, 3650 days) has purged the events behind it, so the
      // two windows are kept identical on purpose.
      cursorColumn: "day",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the calendar times the catalogue — a few rows per trading day per tenant."
      },
      archive: {
        archivable: false,
        rationale:
          "A derived aggregate; the evidence is the order-event log it is computed from, which has its own descriptor."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a projection row older than its own source's retention can never be rebuilt and is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "day"],
          purpose:
            "The primary key's own leading columns (sql/933) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact — a rebuild from the order-event log is the restore path.",
      executionMode: "generic"
    },
    {
      key: "commerce.sales_by_product",
      tableName: "awcms_commerce_sales_by_product",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #117 — a DERIVED reporting projection (sql/933): one row per
      // (tenant, day, product), maintained by the `reporting` engine from
      // `awcms_commerce_order_events` and fully rebuildable from it. The
      // cursor is the report `day` itself: a row older than the retention
      // window is unrecoverable by a rebuild anyway once `commerce.order_events`
      // (same ceiling, 3650 days) has purged the events behind it, so the
      // two windows are kept identical on purpose.
      cursorColumn: "day",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the calendar times the catalogue — a few rows per trading day per tenant."
      },
      archive: {
        archivable: false,
        rationale:
          "A derived aggregate; the evidence is the order-event log it is computed from, which has its own descriptor."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a projection row older than its own source's retention can never be rebuilt and is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "day"],
          purpose:
            "The primary key's own leading columns (sql/933) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        },
        {
          columns: ["tenant_id", "product_id"],
          purpose:
            "awcms_commerce_sales_by_product_product_idx (sql/933) — the grouped by-product read over a date range."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact — a rebuild from the order-event log is the restore path.",
      executionMode: "generic"
    },
    {
      key: "commerce.sales_by_category",
      tableName: "awcms_commerce_sales_by_category",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #117 — a DERIVED reporting projection (sql/933): one row per
      // (tenant, day, category), maintained by the `reporting` engine from
      // `awcms_commerce_order_events` and fully rebuildable from it. The
      // cursor is the report `day` itself: a row older than the retention
      // window is unrecoverable by a rebuild anyway once `commerce.order_events`
      // (same ceiling, 3650 days) has purged the events behind it, so the
      // two windows are kept identical on purpose.
      cursorColumn: "day",
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the calendar times the catalogue — a few rows per trading day per tenant."
      },
      archive: {
        archivable: false,
        rationale:
          "A derived aggregate; the evidence is the order-event log it is computed from, which has its own descriptor."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; a projection row older than its own source's retention can never be rebuilt and is safe to purge."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "day"],
          purpose:
            "The primary key's own leading columns (sql/933) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        },
        {
          columns: ["tenant_id", "category_id"],
          purpose:
            "awcms_commerce_sales_by_category_category_idx (sql/933) — the grouped by-category read over a date range."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact — a rebuild from the order-event log is the restore path.",
      executionMode: "generic"
    },
    {
      key: "commerce.entitlements",
      tableName: "awcms_commerce_entitlements",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "revoked_at",
      // Issue #267 (IRMbyDUS). Fiscal/proof-of-purchase adjacent, the same
      // reasoning `commerce.orders` above states for its own widest window:
      // a revoked grant is still evidence of what a customer once paid for,
      // relevant to exactly the kind of billing/access dispute
      // `awcms_tenant_entitlements`'s own descriptor (ADR-0084) already
      // reasons about for the unrelated SaaS-plan concept it covers.
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single storefront's own paid-order volume (at most one row per (order, product) — sql/936's own unique index) — nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE: this module never deletes a row — revocation is the status flip to 'revoked' (sql/936's header), so the cursor column never matches a purge predicate keyed on an actual deletion. Same 'sealed by never matching' shape commerce.customer_accounts' descriptor documents for its own blocked-not-deleted status column."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "revoked_at"],
          purpose:
            "awcms_commerce_entitlements_tenant_revoked_idx (sql/936) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        },
        {
          columns: ["tenant_id", "owner_customer_id", "product_id"],
          purpose:
            "awcms_commerce_entitlements_tenant_owner_product_idx (sql/936) — verifyEntitlement's own lookup shape."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.payment_allocations",
      tableName: "awcms_commerce_payment_allocations",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #285 (ADR-0025). Append-only ledger - no `deleted_at` (and no
      // `updated_at`): the cursor is `created_at`, the same exception
      // `commerce.order_events` documents for an append-only table.
      cursorColumn: "created_at",
      // Fiscal record: every row is evidence of money that changed hands, the
      // same reasoning `commerce.orders` states for its own widest window. The
      // floor is five years (a payment must outlive any billing/tax dispute
      // about the order it settled) and the ceiling ten.
      retentionClass: "system_event",
      retentionMinDays: 1825,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a tenant's own order volume (a handful of legs per order at most) - nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only mode. Reachable only past the ten-year ceiling, and only by the retention worker: awcms_app has no DELETE on this table (sql/940's REVOKE) and a trigger freezes every column of a row, so the ledger is append-only for every runtime path."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_payment_allocations_tenant_created_idx (sql/940) - the (tenant, cursor) composite the generic purge engine filters + orders by, and the tender-mix report's range scan."
        },
        {
          columns: ["tenant_id", "order_id", "created_at"],
          purpose:
            "awcms_commerce_payment_allocations_tenant_order_idx (sql/940) - an order's own ledger read and settlement sum."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. The ledger is the source of truth for settlement: restore it WITH awcms_commerce_orders (payment_status is a cache of it).",
      executionMode: "generic"
    },
    // Issue #284 (ADR-0028) - the six POS register tables; see
    // `domain/register-lifecycle.ts`.
    ...REGISTER_DATA_LIFECYCLE,
    // Issue #288 (ADR-0030) - the three closed-loop stored-value tables; see
    // `domain/stored-value-lifecycle.ts`.
    ...STORED_VALUE_DATA_LIFECYCLE,
    // Issue #296 (ADR-0035) - the six POS operational-report projection
    // tables; see `domain/operational-report-lifecycle.ts`.
    ...OPERATIONAL_REPORT_DATA_LIFECYCLE,
    // Issue #286 (ADR-0029) - held sales, quotations (+ versions), work orders
    // (+ events) and documents; see `domain/documents-lifecycle.ts`. The
    // numbering sequences deliberately declare none.
    ...DOCUMENT_DATA_LIFECYCLE,
    // Issue #294 (ADR-0031) - the two expense tables; see
    // `domain/expense-lifecycle.ts`.
    ...EXPENSE_DATA_LIFECYCLE,
    // Issue #287 (ADR-0033) - the four returns / refunds tables; see
    // `domain/returns-lifecycle.ts`.
    ...RETURNS_DATA_LIFECYCLE,
    {
      key: "commerce.protected_media_links",
      tableName: "awcms_commerce_protected_media_links",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "updated_at",
      // Issue #268 (IRMbyDUS). Every row is created/replaced by an
      // ADMINISTRATOR linking a product to its protected media object
      // (`PUT .../products/{id}/protected-media`), never by storefront
      // traffic — the ceiling is the tenant's own product catalogue size,
      // not a request volume, the same class of argument
      // `commerce.entitlements` above states for its own row. Unlike that
      // table, THIS one has a real, reachable hard-delete path
      // (`clearProtectedMediaLinkForProduct`), so a purge descriptor is not
      // a fiction here — it just needs a ceiling long enough that the
      // generic engine's age-based sweep never fires against a link a
      // product still actively uses. `retentionMaxDays: 3650` (10 years) is
      // that ceiling: a product whose protected-media link has not been
      // touched in a decade is, in practice, a discontinued product, not a
      // live entitlement gate an operator is relying on — the same
      // "long enough that the theoretical risk is not the practical one"
      // reasoning `commerce.sales_daily`/`_by_product`/`_by_category`'s own
      // descriptors state for their identical 3650-day ceiling.
      retentionClass: "system_event",
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "At most one row per product (sql/939's own unique index) — bounded by catalogue size, nowhere near partition-worthy."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "A straight DELETE, same as the admin-triggered clear path (`clearProtectedMediaLinkForProduct`) — no cascading FK children reference this table."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "updated_at"],
          purpose:
            "awcms_commerce_protected_media_links_tenant_updated_idx (sql/939) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.loyalty_ledger",
      tableName: "awcms_commerce_loyalty_ledger",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "created_at",
      // Issue #289 / ADR-0026. An append-only points ledger: every row is a
      // balance-affecting fact (earn, redeem, expire, adjustment, reversal)
      // and `awcms_commerce_loyalty_accounts.balance` is the SUM of it. The
      // retention floor is FIVE years and the ceiling/default TEN — the same
      // fiscal-record class `commerce.orders` states, because a point is a
      // liability the merchant owes the customer and a redemption is a
      // discount on a taxable sale. The floor is also an integrity floor: a
      // purge removes whole old rows, so `commerce:loyalty:reconcile` (which
      // checks `balance = SUM(points)`) would report drift for an account
      // whose early history was purged. Ten years is long enough that the
      // purge is a deliberate operator choice, never a surprise.
      retentionClass: "financial_tax",
      retentionMinDays: 1825,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "Bounded by the number of paid orders plus redemptions/expiries per tenant — at most a handful of rows per order. Nowhere near partition-worthy, and a partitioned table could not keep sql/950's composite (tenant_id, id) foreign key from `reverses_entry_id`."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only mode, run as awcms_worker (the only role that may DELETE here — awcms_app is REVOKEd UPDATE and DELETE by sql/950, and a trigger rejects every UPDATE). Rows are deleted whole and only past the retention window (default ten years); a reversal is deleted together with the earn it compensates (ON DELETE CASCADE on reverses_entry_id, sql/950), so a purge batch can never split the pair. See the retention note above for the reconcile consequence."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_loyalty_ledger_tenant_created_idx (sql/950) — the (tenant, cursor) composite the generic purge engine filters + orders by, and the reporting summary's date-range scan."
        },
        {
          columns: ["tenant_id", "account_id", "created_at"],
          purpose:
            "awcms_commerce_loyalty_ledger_account_created_idx (sql/950) — one account's history, newest first (admin ledger view, customer history)."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. The account projection is rebuilt from this table (commerce:loyalty:reconcile), so a restore of the ledger alone is sufficient.",
      executionMode: "generic"
    },
    {
      key: "commerce.loyalty_accounts",
      tableName: "awcms_commerce_loyalty_accounts",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #289 / ADR-0026. One row per customer, a PROJECTION of the
      // ledger. The cursor is `updated_at` — bumped by every ledger append —
      // so only an account UNTOUCHED for the whole window is ever eligible:
      // its newest ledger row is at most that old, and the ledger descriptor
      // above purges that history first. The ledger's FK to this table is
      // RESTRICT, so a pass that races ahead of the ledger purge fails that
      // batch harmlessly and succeeds on a later run, once the history is gone.
      cursorColumn: "updated_at",
      retentionClass: "financial_tax",
      retentionMinDays: 1825,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "At most one row per customer per tenant (unique index, sql/950) — bounded by commerce.customers."
      },
      archive: {
        archivable: false,
        rationale:
          "A projection, fully rebuildable from the ledger; the evidence is the ledger, which has its own descriptor."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only mode. Reaches only an account idle for the full retention window (default ten years); the composite RESTRICT foreign key from the ledger makes it impossible to delete an account that still has history."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "updated_at"],
          purpose:
            "awcms_commerce_loyalty_accounts_tenant_updated_idx (sql/950) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. Rebuilt from the ledger by commerce:loyalty:reconcile.",
      executionMode: "generic"
    },
    {
      key: "commerce.loyalty_programs",
      tableName: "awcms_commerce_loyalty_programs",
      ownerModuleKey: "commerce",
      scope: "tenant",
      // Issue #289 / ADR-0026. A rule VERSION. The cursor is `effective_to`,
      // which is NULL for a draft and for the open active version — a NULL
      // never satisfies `< cutoff`, so a live or not-yet-live rule is
      // unreachable by construction. Only a version RETIRED more than the
      // window ago is eligible, and every ledger row that cites it is older
      // still (an earn is stamped with a version that was in force when it was
      // written) and has been purged first; the ledger's composite FK to this
      // table is RESTRICT for the same reason as accounts above.
      cursorColumn: "effective_to",
      retentionClass: "financial_tax",
      retentionMinDays: 1825,
      retentionMaxDays: 3650,
      defaultRetentionDays: 3650,
      partition: {
        eligible: false,
        rationale:
          "A tenant has a handful of versions over its lifetime — each needs a human action to create."
      },
      archive: {
        archivable: false,
        rationale:
          "Tiny and human-authored; ordinary backup/restore is the artefact."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only mode. Reaches only a version retired for the full window; a draft or the open active version has effective_to NULL and can never match, and the ledger's RESTRICT FK refuses a version that still has history."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "effective_to"],
          purpose:
            "awcms_commerce_loyalty_programs_tenant_effective_to_idx (sql/950) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.attribute_definitions",
      tableName: "awcms_commerce_attribute_definitions",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      // Issue #291. Same window and reasoning as `commerce.categories`: the
      // window is how long a SOFT-DELETED definition may sit before a sweep
      // may hard-purge it (its values cascade away with it, `sql/960`).
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "A tenant is capped at 100 live definitions (MAX_ATTRIBUTE_DEFINITIONS_PER_TENANT) — a schema, not a traffic-driven table."
      },
      archive: {
        archivable: false,
        rationale:
          "A definition is tenant-authored metadata (key, labels, type, constraints) — reconstructible from the tenant's own records, not evidence of anything."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe because the cursor column (deleted_at) is NULL for every live row, so a live definition is never a purge candidate."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_attribute_definitions_tenant_deleted_idx (sql/960) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.product_attribute_values",
      tableName: "awcms_commerce_product_attribute_values",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "deleted_at",
      // Issue #291. A LIVE value has `deleted_at IS NULL`, so the generic
      // purge engine can never reach one; only a value the operator CLEARED
      // (a soft delete) ages out, after the window below. The window is the
      // same "wide, an accidental clear is often noticed late" range
      // `commerce.categories` uses. Values also cascade away with their
      // product, variant or purged definition (sql/960).
      retentionClass: "system_event",
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "At most one live row per (entity, definition) by unique index and 100 definitions per tenant, so a tenant's live values are bounded by catalogue size x 100 — a catalog table, nowhere near partition-worthy; cleared rows are short-lived."
      },
      archive: {
        archivable: false,
        rationale:
          "A value is the merchant's own catalog description of a product (colour, weight, material...) — reconstructible from their records and not evidence of anything; the audit log already records which attribute keys changed."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "The generic engine's only implemented mode; safe because the cursor column (deleted_at) is NULL for every live value, so a live value is never a purge candidate."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_commerce_product_attribute_values_tenant_deleted_idx (sql/960) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      key: "commerce.catalog_import_batches",
      tableName: "awcms_commerce_catalog_import_batches",
      ownerModuleKey: "commerce",
      scope: "tenant",
      cursorColumn: "created_at",
      // Issue #291. An append-only record of an applied import: audit-shaped
      // evidence of a bulk catalog change, so a long window like the audit log's.
      retentionClass: "system_event",
      retentionMinDays: 90,
      retentionMaxDays: 3650,
      defaultRetentionDays: 730,
      partition: {
        eligible: false,
        rationale:
          "One row per APPLIED import — an operator action, a handful per day at most, nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; the row's evidentiary content (file hash, counts) is also in the audit log."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "A straight DELETE once past retention; nothing references a batch row."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "created_at"],
          purpose:
            "awcms_commerce_catalog_import_batches_tenant_created_idx (sql/964) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    }
  ],
  /**
   * ADR-0094 wave-shape reuse: all four tables are catalog/business data, not
   * data about a person. None carries a `created_by`/`updated_by`/
   * `deleted_by` column at all (Issue #4's table-convention list, unchanged
   * by Issue #23) — WHO changed a row lives only in the audit log
   * (`recordAuditEvent`'s `actorTenantUserId`), so there is no column on any
   * of them that could join a row to a subject even in principle. A product
   * image's `alt_text` is an accessibility CAPTION of a product photo (e.g.
   * "Kopi Robusta 250g, front label") — describing MERCHANDISE, never a
   * person — same `unreachableBySubject`/`retain_under_obligation` shape
   * `tenant_admin.tenant_settings` uses for the same reason.
   */
  subjectData: [
    {
      key: "commerce.categories",
      tableName: "awcms_commerce_categories",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A tenant's product category tree — name, slug, icon, and its parent category. Merchandising structure the tenant authored, naming nobody and matchable to nobody; no column on this table identifies a person."
    },
    {
      key: "commerce.products",
      tableName: "awcms_commerce_products",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A tenant's product catalog — sku, name, price, stock, and the full Issue #23 parity column set (tiered pricing, insurance, promo banners, size charts, service forms, variant attributes, ...). Business/merchandising data the tenant authored about what it sells, not about a person; no column on this table identifies a person."
    },
    {
      key: "commerce.product_images",
      tableName: "awcms_commerce_product_images",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A (product, media object, sort order, alt text) join row. `alt_text` is an accessibility caption of the product photo, describing merchandise, not a person; no column identifies one."
    },
    {
      key: "commerce.product_variants",
      tableName: "awcms_commerce_product_variants",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A product variant's own catalog description — name, value, sku, price, stock. Merchandising data the tenant authored about what it sells, not about a person; no column identifies one."
    },
    {
      key: "commerce.flash_sales",
      tableName: "awcms_commerce_flash_sales",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A promotion's own name/slug/window — merchandising data the tenant authored, naming nobody."
    },
    {
      key: "commerce.flash_sale_products",
      tableName: "awcms_commerce_flash_sale_products",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A (flash sale, product, variant, sale price, quota, sold) join row — merchandising data, no column identifies a person."
    },
    {
      key: "commerce.vouchers",
      tableName: "awcms_commerce_vouchers",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A voucher's own code/discount-rule/window/quota — merchandising data the tenant authored, naming nobody. used_count is an aggregate, not a per-redeemer record (#29's own order rows are where a redeemer's identity, if any, would live)."
    },
    {
      key: "commerce.sliders",
      tableName: "awcms_commerce_sliders",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A home-page banner's title/subtitle/media reference — marketing copy, naming nobody."
    },
    {
      key: "commerce.testimonials",
      tableName: "awcms_commerce_testimonials",
      ownerModuleKey: "commerce",
      // `author_name`/`author_role`/`body` may name a real person BY TEXT —
      // see `domain/testimonial-validation.ts`'s header — but this table
      // carries no column that MATCHES to a tenant_user/identity/profile id
      // (unlike `awcms_offices.manager_tenant_user_id`, say). Marking
      // `unreachableBySubject: false`/populating `subjectColumns` here would
      // be a fiction the automated per-id erasure engine cannot perform; this
      // is the SAME shape `module-contract.ts`'s own header uses for
      // `awcms_comments_reports` ("stores a hash of the reporter's address
      // and nothing else... those rows are personal data, so NO_SUBJECT_DATA
      // would be a lie — and they are unreachable, so a subjectColumns entry
      // would be a fiction"). `subject-data:registry:check` requires
      // `exportable: false`/`erasure: "retain_under_obligation"` whenever
      // `unreachableBySubject` is `true` — a genuine erasure request naming a
      // specific testimonial (found by CONTENT, not by subject id) is handled
      // as an ordinary admin edit/delete, outside this automated engine's
      // scope by construction, same as the comments precedent.
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A testimonial's author_name/authorRole/body may name a real customer in free text an admin typed (or copied from their own words), but no column on this table can be MATCHED to a tenant_user/identity/profile id — a subject cannot be found here by id lookup, the same unreachable-but-personal shape awcms_comments_reports already has in this base."
    },
    {
      key: "commerce.popups",
      tableName: "awcms_commerce_popups",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A popup's own title/body/media reference — marketing copy, naming nobody."
    },
    {
      key: "commerce.store_settings",
      tableName: "awcms_commerce_store_settings",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "One jsonb settings blob per tenant — store identity, shipping/payment configuration, promo copy. The tenant's OWN business configuration, including its OWN bank account holder names (never a customer's), naming nobody but the merchant itself; no column identifies a natural person who is a data subject of this platform."
    },
    /**
     * Issue #29 — the first tables in this module (indeed, one of the first
     * in this REPO) that hold real personal data: a guest customer's name,
     * phone and e-mail. All eight are still `unreachableBySubject: true`,
     * and that is a deliberate, careful reading of ADR-0094's own subject
     * vocabulary rather than an oversight: `SubjectDataColumn.references`
     * is `"tenant_user" | "identity" | "profile" | "principal"` — every one
     * of them a STAFF-side identity concept from `identity_access`/
     * `profile_identity`. A guest storefront customer, identified only by a
     * phone number they typed into a checkout form, has none of those rows
     * at all in this increment (accounts are Issue #32) — there is no
     * `tenant_user_id`/`identity_id`/`profile_id` this module could
     * honestly put in `subjectColumns`, because none exists to put there.
     *
     * This is the EXACT shape `commerce.testimonials`' own descriptor above
     * already documents for this module ("no column on this table can be
     * MATCHED to a tenant_user/identity/profile id") and the same one
     * `module-contract.ts`'s own header cites for `awcms_comments_reports`.
     * Marking these `unreachableBySubject: false` with an invented
     * `subjectColumns` entry pointing at, say, `customers.phone` would be
     * the fiction that flag exists to prevent — this system has no "phone
     * number" reference kind, and inventing one here would silently claim a
     * capability (automated per-id export/erasure) the engine cannot
     * actually perform for a phone-identified guest.
     *
     * A genuine subject-rights request naming a specific phone number is
     * handled as an ordinary admin lookup/edit (`GET/PATCH
     * /api/v1/commerce/customers/{id}`) — outside this automated engine's
     * scope by construction, exactly the comments/testimonials precedent.
     * `exportable: false` + `erasure: "retain_under_obligation"` is the
     * pairing `subject-data:registry:check` requires whenever
     * `unreachableBySubject` is `true`; it is not a claim that this data is
     * legally exempt from a real request, only that THIS automated engine
     * cannot address it by id.
     */
    {
      key: "commerce.customers",
      tableName: "awcms_commerce_customers",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A guest checkout customer's own name/phone/e-mail — real personal data, but identified only by a phone number typed into a checkout form, not by a tenant_user/identity/profile id this system's subject vocabulary can name (accounts are Issue #32). See this array's header comment."
    },
    {
      key: "commerce.customer_addresses",
      tableName: "awcms_commerce_customer_addresses",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A saved shipping address — recipient name, phone, street — real personal data, same unreachable-by-this-engine's-vocabulary shape as commerce.customers above (a row is keyed by customer_id, never a tenant_user/identity/profile/principal id this registry can name). Since Issue #91, an account holder reaches this table directly through their own bearer-secured GET/POST/PATCH/DELETE /account/addresses routes — the honest self-service path this table's phone-only vocabulary gap made impossible before an account existed — the same way commerce.customer_accounts below is addressed today by an ordinary admin lookup; this automated engine still cannot walk it by id."
    },
    {
      key: "commerce.orders",
      tableName: "awcms_commerce_orders",
      ownerModuleKey: "commerce",
      // Issue #116 — a POS counter sale stamps the cashier's tenant user id
      // (`pos_cashier_tenant_user_id`, sql/931), so this table IS reachable
      // by the tenant_user vocabulary now — for the STAFF member who rang
      // the sale up, never for the customer (whose reasoning is unchanged
      // and stays in the rationale below).
      subjectColumns: [
        { column: "pos_cashier_tenant_user_id", references: "tenant_user" }
      ],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "An order's own address-snapshot jsonb column carries the same recipient name/phone/street as commerce.customer_addresses, plus the transaction itself is the tenant's fiscal record — retain_under_obligation on both grounds. The CUSTOMER stays unreachable by this engine's tenant_user/identity/profile vocabulary for the same reason as commerce.customers. The only subject column is the POS cashier stamp (Issue #116): which staff member took the cash is part of the same fiscal record, so it is retained too, and resolves to nobody once identity_access.identities anonymises."
    },
    {
      key: "commerce.order_items",
      tableName: "awcms_commerce_order_items",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A line item's own product/variant/price/quantity snapshot — names no person directly, but is part of the same order record as commerce.orders and inherits its reasoning."
    },
    {
      key: "commerce.order_item_components",
      tableName: "awcms_commerce_order_item_components",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #290 — the component snapshot of a bundle order line (product ids, text as sold, units, allocated value). Names no person; part of the same order record as commerce.order_items and inherits its reasoning."
    },
    {
      key: "commerce.bundle_components",
      tableName: "awcms_commerce_bundle_components",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #290 — a bundle's definition (which products and how many). Catalog description the tenant authored; actor_tenant_user_id is the last editor, an administrative-act stamp retained like the audit log, not subject data."
    },
    {
      key: "commerce.order_events",
      tableName: "awcms_commerce_order_events",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "The order's own status timeline — from/to status, actor kind (customer/admin/system), an optional free-text note. Names no person by id; part of the same order record as commerce.orders."
    },
    {
      key: "commerce.payment_confirmations",
      tableName: "awcms_commerce_payment_confirmations",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A payment confirmation's own method/amount/bank details/reviewer — bank_name/account_name here are the CUSTOMER's own transfer details (unlike commerce.store_settings' merchant-owned bank accounts), part of the same order record as commerce.orders and inheriting its reasoning."
    },
    // Issue #110, contract #106/ADR-0017 D2/D3 — the payment-gateway
    // schema's three new tables, addressed by ORDER (like
    // commerce.payment_confirmations just above) or not by a person at
    // all, never by a per-tenant subject id.
    {
      key: "commerce.payment_gateway_sessions",
      tableName: "awcms_commerce_payment_gateway_sessions",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A hosted-checkout session's own provider/reference/redirect URL/status, part of the same order record as commerce.orders and inheriting its reasoning. raw_status is the provider's own response snippet — may echo back transaction/customer details Midtrans itself already holds, never exported, redacted here for the same reason commerce.whatsapp_messages redacts its own provider payload.",
      redactedColumns: ["raw_status"]
    },
    {
      key: "commerce.payment_events",
      tableName: "awcms_commerce_payment_events",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "An inbound provider webhook's own replay-protection record — event_key/provider_ref/outcome, optionally linked to an order the same way commerce.payment_confirmations is. payload is the provider's own callback body (may echo transaction/customer details Midtrans already holds) and is never exported, same redaction reasoning as commerce.payment_gateway_sessions.raw_status.",
      redactedColumns: ["payload"]
    },
    {
      key: "commerce.webhook_endpoints",
      tableName: "awcms_commerce_webhook_endpoints",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "An owner-minted integration secret's own metadata — provider/label/created_by/revoked_at. created_by names a STAFF tenant_user (an operator, not a customer/subject) the same way commerce.payment_confirmations.reviewed_by does; token_hash is a one-way hash of a secret, not personal data, and is never selected back out by anything in this module (application/webhook-endpoint-directory.ts's own header)."
    },
    {
      key: "commerce.reviews",
      tableName: "awcms_commerce_reviews",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A rating + free-text review body a guest customer wrote — real personal expression, same unreachable-by-this-engine's-vocabulary shape as commerce.customers above. A genuine erasure request is handled as an ordinary admin moderation delete (DELETE /api/v1/commerce/reviews/{id}), outside this automated engine's scope by construction."
    },
    {
      key: "commerce.affiliates",
      tableName: "awcms_commerce_affiliates",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #92 — an affiliate enrolment row, keyed by customer_id, same unreachable-by-this-engine's-vocabulary shape as commerce.customers above. An account holder reaches their OWN row through the bearer-secured GET/POST /account/affiliate routes; this automated engine still cannot walk it by id."
    },
    {
      key: "commerce.affiliate_commissions",
      tableName: "awcms_commerce_affiliate_commissions",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #92 — a commission row references an affiliate and an order, not a person directly, but is part of the same order/affiliate record chain as commerce.orders/commerce.affiliates above and inherits their reasoning (fiscal-adjacent, unreachable by this engine's subject vocabulary)."
    },
    {
      key: "commerce.wishlists",
      tableName: "awcms_commerce_wishlists",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A bare (customer, product) saved-item pair — same unreachable-by-this-engine's-vocabulary shape as commerce.customers above (a row is keyed by customer_id, never a tenant_user/identity/profile/principal id this registry can name). Since Issue #91, an account holder reaches this table directly through their own bearer-secured GET/PUT /account/wishlist and DELETE /account/wishlist/{productId} routes (see this module's README) — the same self-service resolution commerce.customer_addresses above now has; this automated engine still cannot walk it by id."
    },
    /**
     * Issue #87 (C1, contract #86/ADR-0016) — a customer ACCOUNT is real
     * personal data (an e-mail, a login history) and a genuine subject in
     * the ordinary sense, but ADR-0094 Decision 1 answers the subject
     * question PER TENANT MEMBER, through exactly one of
     * `tenant_user_id`/`identity_id`/`profile_id` (or, on a global table
     * only, `principal_id`) — and ADR-0016 D1 is explicit that a customer
     * account carries NONE of those on purpose ("No password, ever — no
     * second password store and no link to awcms_principals"). There is
     * therefore no column this registry's fixed subject vocabulary can
     * honestly name here, for exactly the reason `newsletter.subscribers`
     * (a subscriber "has no account, no session and no tenant membership")
     * is already `unreachableBySubject: true` rather than pointing at a
     * column that does not exist — a customer account is the SAME shape:
     * a real person, reachable only by the storefront's own e-mail/session
     * credential, not by any id this engine's automated per-subject
     * export/erasure can walk. The honest export/erasure path for a named
     * account is the same ordinary admin lookup/edit the `commerce.customers`
     * entry above describes (`GET/PATCH` on the owning admin screen once
     * one exists), outside this automated engine's scope by construction.
     */
    {
      key: "commerce.customer_accounts",
      tableName: "awcms_commerce_customer_accounts",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A verified e-mail, a login history and a bound guest-customer row for a storefront shopper who has no tenant_user/identity/profile/principal id in this system's subject vocabulary (ADR-0016 D1 — no password, no principal link, by design). See this array's header comment; addressed today the same way commerce.customers is, as an ordinary admin lookup by e-mail, not by this automated engine."
    },
    {
      key: "commerce.customer_otps",
      tableName: "awcms_commerce_customer_otps",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A short-lived, single-use e-mail OTP — the e-mail is real personal data, but this table is reached by e-mail address, not by any id in this registry's subject vocabulary, the same gap commerce.customer_accounts above has. Purge-only: commerce:customer-auth:purge already deletes every row past its own expires_at (module.ts's dataLifecycle entry), so there is nothing left to export/erase once a code is spent or expired, and a live one is dead within OTP_TTL_SECONDS regardless.",
      redactedColumns: ["code_hash"]
    },
    {
      key: "commerce.customer_sessions",
      tableName: "awcms_commerce_customer_sessions",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A bearer session's diagnostic metadata (hashed IP, UA summary) — the account it belongs to has no subject-vocabulary id (see commerce.customer_accounts above), so this table has the same gap one level down. Purge-only: commerce:customer-auth:purge deletes expired sessions and revoked sessions older than 7 days (module.ts's dataLifecycle entry); a session an account holder wants gone today is ended via logout (revokeSession), which is immediate and does not wait for this table's descriptor.",
      redactedColumns: ["token_hash", "client_ip_hash"]
    },
    // Issue #108, contract #106/ADR-0017 D5 — a message is addressed to a
    // PHONE, matched the same way email.email_messages (module.ts, `email`
    // module) is matched by ADDRESS rather than by account: neither table
    // can be reached from a per-tenant subject id, both say so outright.
    {
      key: "commerce.whatsapp_messages",
      tableName: "awcms_commerce_whatsapp_messages",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A message SENT to a phone number, including the rendered body (which may carry an OTP code or an order total). Unlike email.email_messages this table has no created_by (no sender tracked, only the recipient phone) and no per-tenant subject id reaches it, so — unlike that table's reachable anonymize — a table nothing can find cannot honour any subject request; commerce:whatsapp:purge (module.ts's dataLifecycle entry) is what eventually removes a terminal row.",
      redactedColumns: ["to_phone", "to_phone_hash", "variables"]
    },
    {
      key: "commerce.whatsapp_delivery_attempts",
      tableName: "awcms_commerce_whatsapp_delivery_attempts",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Per-attempt provider outcomes hanging off a message row. No column names a person — the link is the message, which answers for itself — and the provider snippet is operational telemetry kept under this module's own retention.",
      redactedColumns: ["provider_response_snippet"]
    },
    // Issue #111, contract #106 D8 — the commerce inbox. Both tables are
    // reachable only through the owning `awcms_commerce_customer_accounts`
    // row, which itself carries no tenant_user/identity/profile/principal
    // id (ADR-0016 D1) — the SAME "no such column to point at" shape
    // `commerce.customer_addresses`/`commerce.wishlists` above already
    // document for a table an account holder reaches through their own
    // bearer-secured routes: since Issue #111, an account holder reaches
    // their own threads directly through GET/POST .../account/conversations
    // and GET/POST .../account/conversations/{id}[/messages] — the honest
    // self-service path this account's own vocabulary gap allows — but this
    // AUTOMATED per-id engine still cannot walk either table by a
    // tenant_user/identity/profile/principal id, because none exists on the
    // owning account to begin with.
    {
      key: "commerce.conversations",
      tableName: "awcms_commerce_conversations",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A thread's own subject/status/unread flags, keyed by account_id — same unreachable-by-this-engine's-vocabulary shape as commerce.customer_accounts above (ADR-0016 D1: no tenant_user/identity/profile/principal id on the account this table hangs off of). An account holder reaches their OWN threads through the bearer-secured GET/POST /account/conversations routes; this automated engine still cannot walk it by id."
    },
    {
      key: "commerce.messages",
      tableName: "awcms_commerce_messages",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A conversation's own transcript — the message body may be real personal content a customer wrote, but the link is conversation_id, not any tenant_user/identity/profile/principal id, inheriting commerce.conversations' own unreachable-by-this-engine's-vocabulary shape one level down. A store-sent row's sender_tenant_user_id names STAFF, not a data subject of this table."
    },
    // Issue #114, contract #106 D9 — customer campaigns. `campaign_recipients`
    // names `customer_id`, but that is the SAME `awcms_commerce_customers`
    // vocabulary gap `commerce.orders`/`commerce.order_items` above already
    // document: a customer row carries no tenant_user/identity/profile/
    // principal id (ADR-0016 D1), so this automated per-id engine cannot
    // walk either table by one even though a customer column exists.
    {
      key: "commerce.campaigns",
      tableName: "awcms_commerce_campaigns",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A campaign's own subject/body/audience filter — addressed to a FILTER, not to any one customer, and carries no per-tenant subject id at all."
    },
    {
      key: "commerce.campaign_recipients",
      tableName: "awcms_commerce_campaign_recipients",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "customer_id names a row in commerce.customers, which itself carries no tenant_user/identity/profile/principal id (ADR-0016 D1, same gap commerce.orders' own entry above documents) — this engine's subject vocabulary still cannot reach it. address_masked is already masked at write time (never a raw e-mail/phone), so there is nothing further to redact on export even if it were reachable."
    },
    {
      key: "commerce.entitlements",
      tableName: "awcms_commerce_entitlements",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "owner_customer_id names a row in commerce.customers, which itself carries no tenant_user/identity/profile/principal id (ADR-0016 D1, same gap commerce.orders'/commerce.customer_accounts' own entries document) — this engine's subject vocabulary still cannot reach it. The row is also the proof of what a customer paid for (source_order_id), the same fiscal-record reasoning commerce.orders states, so it is retained under that obligation rather than erased even if it were reachable."
    },
    {
      key: "commerce.payment_allocations",
      tableName: "awcms_commerce_payment_allocations",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #285 - one payment leg or compensating reversal of an order: tender, amount, optional provider reference, and the staff member (a plain uuid stamp, actor_tenant_user_id) who recorded it. It names no customer - the order it points at does, and commerce.orders' own entry documents why that customer is unreachable by this engine's subject vocabulary (ADR-0016 D1). It is a fiscal record of money that changed hands, retained under the same obligation as commerce.orders; provider_reference (a bank/QRIS/gateway reference) is never exported.",
      redactedColumns: ["provider_reference"]
    },
    // Issue #284 (ADR-0028) - see `domain/register-lifecycle.ts`.
    ...REGISTER_SUBJECT_DATA,
    // Issue #288 (ADR-0030) - see `domain/stored-value-lifecycle.ts`.
    ...STORED_VALUE_SUBJECT_DATA,
    // Issue #296 (ADR-0035) - see `domain/operational-report-lifecycle.ts`.
    ...OPERATIONAL_REPORT_SUBJECT_DATA,
    // Issue #286 (ADR-0029) - see `domain/documents-lifecycle.ts`.
    ...DOCUMENT_SUBJECT_DATA,
    // Issue #294 (ADR-0031) - see `domain/expense-lifecycle.ts`.
    ...EXPENSE_SUBJECT_DATA,
    // Issue #287 (ADR-0033) - see `domain/returns-lifecycle.ts`.
    ...RETURNS_SUBJECT_DATA,
    {
      key: "commerce.protected_media_links",
      tableName: "awcms_commerce_protected_media_links",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #268 (IRMbyDUS) — which product's entitlement gates which private media object. Names a product and a media object, never a person; no column on this table could join a row to any subject even in principle. Retained under the same obligation as commerce.entitlements: the link is what makes an already-sold product's download issuable at all, so it is deployment configuration bound to the product's lifecycle, not personal data."
    },
    {
      key: "commerce.loyalty_programs",
      tableName: "awcms_commerce_loyalty_programs",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #289 — a rule VERSION (earn rate, minimum order, expiry days) a tenant administrator authored; it describes the store's offer, never a person. created_by_tenant_user_id names the STAFF author for attribution only, the same posture the audit log's actor column takes, and the version is retained because every ledger row that cites it is a financial record."
    },
    {
      key: "commerce.loyalty_accounts",
      tableName: "awcms_commerce_loyalty_accounts",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #289 — customer_id names a row in commerce.customers, which itself carries no tenant_user/identity/profile/principal id (ADR-0016 D1, same gap commerce.orders'/commerce.entitlements' own entries document) — this engine's subject vocabulary still cannot reach it. The balance is a projection of the ledger, which is retained as a financial record (a point is a liability the merchant owes), so the account is retained under that obligation rather than erased even if it were reachable."
    },
    {
      key: "commerce.loyalty_ledger",
      tableName: "awcms_commerce_loyalty_ledger",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #289 — rows are keyed to account_id -> customer_id -> commerce.customers, which carries no tenant_user/identity/profile/principal id (ADR-0016 D1), so this engine's subject vocabulary cannot reach them. actor_tenant_user_id names the STAFF member of a manual adjustment/redemption for attribution only (audit-log posture), not a data subject. The ledger is append-only and retained under the fiscal-record obligation: rewriting or erasing a row would falsify every later balance_after, which is exactly what an append-only ledger exists to prevent."
    },
    {
      key: "commerce.attribute_definitions",
      tableName: "awcms_commerce_attribute_definitions",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #291 — a tenant-authored attribute schema (key, labels, type, constraints, flags). Merchandising metadata about what the tenant sells, never about a person; no column identifies one."
    },
    {
      key: "commerce.product_attribute_values",
      tableName: "awcms_commerce_product_attribute_values",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #291 — a typed attribute value on a product or variant (colour, weight, material...). Catalog description the tenant authored, bound to the product's lifecycle (it cascades away with its product); no column identifies a person."
    },
    {
      key: "commerce.catalog_import_batches",
      tableName: "awcms_commerce_catalog_import_batches",
      ownerModuleKey: "commerce",
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Issue #291 — the identity of an applied catalog import (file hash, hashed idempotency key, counts). actor_tenant_user_id names the staff member who ran it, but that is audit evidence of an administrative act on the catalog, retained like the audit log itself rather than erased on a subject request."
    }
  ],
  permissions: [
    {
      activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
      action: "read",
      description: "Read category records"
    },
    {
      activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
      action: "create",
      description: "Create category records"
    },
    {
      activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
      action: "update",
      description: "Update category records"
    },
    {
      activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete category records"
    },
    {
      activityCode: COMMERCE_CATEGORIES_ACTIVITY_CODE,
      action: "restore",
      description: "Restore a soft-deleted category record"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "read",
      description: "Read product records"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "create",
      description: "Create product records"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "update",
      description:
        "Update product records, including a legal product status transition"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete product records"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "restore",
      description: "Restore a soft-deleted product record"
    },
    {
      activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
      action: "read",
      description:
        "Read flash sale records, including the storefront active/scheduled read model"
    },
    {
      activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
      action: "create",
      description: "Create flash sale records"
    },
    {
      activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
      action: "update",
      description: "Update flash sale records, including their product lines"
    },
    {
      activityCode: COMMERCE_FLASH_SALES_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete flash sale records"
    },
    {
      activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read voucher records, including the public voucher list and the validate check"
    },
    {
      activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
      action: "create",
      description: "Create voucher records"
    },
    {
      activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
      action: "update",
      description: "Update voucher records"
    },
    {
      activityCode: COMMERCE_VOUCHERS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete voucher records"
    },
    {
      activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read slider records, including the storefront active read model"
    },
    {
      activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
      action: "create",
      description: "Create slider records"
    },
    {
      activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
      action: "update",
      description: "Update slider records"
    },
    {
      activityCode: COMMERCE_SLIDERS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete slider records"
    },
    {
      activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read testimonial records, including the storefront active read model"
    },
    {
      activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
      action: "create",
      description: "Create testimonial records"
    },
    {
      activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
      action: "update",
      description: "Update testimonial records"
    },
    {
      activityCode: COMMERCE_TESTIMONIALS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete testimonial records"
    },
    {
      activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read popup records, including the storefront active read model"
    },
    {
      activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
      action: "create",
      description: "Create popup records"
    },
    {
      activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
      action: "update",
      description: "Update popup records"
    },
    {
      activityCode: COMMERCE_POPUPS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete popup records"
    },
    {
      activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read this tenant's store settings, unmasked (bank accounts, QRIS media)"
    },
    {
      activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
      action: "update",
      description: "Change this tenant's store settings"
    },
    {
      activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read order records, including payment confirmations and the status timeline"
    },
    {
      activityCode: COMMERCE_ORDERS_ACTIVITY_CODE,
      action: "update",
      description:
        "Update an order's status (including an admin-initiated cancel), review a payment confirmation (accept/reject)"
    },
    {
      activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
      action: "read",
      description: "Read customer records and their saved addresses"
    },
    {
      activityCode: COMMERCE_CUSTOMERS_ACTIVITY_CODE,
      action: "update",
      description: "Update a customer's level/status"
    },
    {
      activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
      action: "read",
      description: "Read review records, published and pending"
    },
    {
      activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
      action: "update",
      description: "Moderate a review (publish/reject)"
    },
    {
      activityCode: COMMERCE_REVIEWS_ACTIVITY_CODE,
      action: "delete",
      description: "Soft-delete a review record"
    },
    {
      activityCode: COMMERCE_AFFILIATES_ACTIVITY_CODE,
      action: "read",
      description: "Read affiliate records and their stats"
    },
    {
      activityCode: COMMERCE_AFFILIATES_ACTIVITY_CODE,
      action: "update",
      description:
        "Edit an affiliate's status (active/suspended) or commission rate"
    },
    {
      activityCode: COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE,
      action: "read",
      description: "Read affiliate commission records"
    },
    {
      activityCode: COMMERCE_AFFILIATE_COMMISSIONS_ACTIVITY_CODE,
      action: "update",
      description: "Moderate a commission (approve/pay/void)"
    },
    {
      activityCode: COMMERCE_WHATSAPP_ACTIVITY_CODE,
      action: "read",
      description:
        "Read WhatsApp outbox message diagnostics (masked phone only)"
    },
    {
      activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
      action: "read",
      description: "Read customer conversations and their messages"
    },
    {
      activityCode: COMMERCE_CONVERSATIONS_ACTIVITY_CODE,
      action: "update",
      description: "Reply on a conversation and close/reopen it"
    },
    {
      activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
      action: "read",
      description: "Read campaigns and preview their audience count"
    },
    {
      activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
      action: "update",
      description: "Create and edit a draft campaign"
    },
    {
      activityCode: COMMERCE_CAMPAIGNS_ACTIVITY_CODE,
      action: "send",
      description: "Send or cancel a campaign"
    },
    {
      activityCode: COMMERCE_WEBHOOK_ENDPOINTS_ACTIVITY_CODE,
      action: "update",
      description:
        "List, create, and revoke this tenant's commerce webhook-endpoint tokens"
    },
    {
      activityCode: COMMERCE_POS_ACTIVITY_CODE,
      action: "create",
      description:
        "Create a counter (POS) sale — the only order-creation path that requires a permission at all"
    },
    {
      activityCode: COMMERCE_POS_DUE_ACTIVITY_CODE,
      action: "create",
      description:
        "Finalize a POS sale that leaves a balance due instead of settling in full (Issue #285)"
    },
    {
      activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read an order's payment-allocation ledger and the tender-mix / outstanding-balance reports (Issue #285)"
    },
    {
      activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
      action: "create",
      description:
        "Record an additional payment (tender) against an order (Issue #285)"
    },
    {
      activityCode: COMMERCE_PAYMENTS_ACTIVITY_CODE,
      action: "revoke",
      description:
        "Record a compensating reversal of a payment — takes money back out of the order's settlement (Issue #285)"
    },
    {
      activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
      action: "read",
      description: "List POS registers (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
      action: "create",
      description: "Define a POS register (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTERS_ACTIVITY_CODE,
      action: "update",
      description: "Rename, relabel or (de)activate a POS register (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read register sessions and their cash-up reports (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
      action: "create",
      description: "Open a register session with an opening float (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
      action: "update",
      description:
        "Use a register session: record drawer movements and hand it over (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE,
      action: "export",
      description:
        "Export a register session's cash-up report as CSV (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
      action: "create",
      description:
        "Close a register session by counting the drawer (cash-up) (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE,
      action: "approve",
      description:
        "Approve or reject a cash-up whose variance exceeds the approval threshold (Issue #284)"
    },
    {
      activityCode: COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE,
      action: "approve",
      description:
        "Post a compensating correction to a closed register session (Issue #284)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read the gift-card / store-credit program configuration (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_PROGRAMS_ACTIVITY_CODE,
      action: "update",
      description:
        "Change the gift-card / store-credit program configuration: enable, expiry, refund policy, balance ceiling (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
      action: "read",
      description:
        "Read gift-card / store-credit accounts, their ledger, the liability report and the reconcile report (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
      action: "create",
      description:
        "Issue a gift card / store credit and load value onto it (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_ACTIVITY_CODE,
      action: "update",
      description:
        "Disable or enable a gift-card / store-credit account and run the expiry sweep (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_ADJUSTMENTS_ACTIVITY_CODE,
      action: "create",
      description:
        "Post a reasoned manual adjustment to a gift-card / store-credit balance (Issue #288)"
    },
    {
      activityCode: COMMERCE_STORED_VALUE_RECONCILE_ACTIVITY_CODE,
      action: "approve",
      description:
        "Repair a gift-card / store-credit balance projection that drifted from its ledger (Issue #288)"
    },
    {
      activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
      action: "read",
      description: "List your own held sales (Issue #286)"
    },
    {
      activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
      action: "create",
      description: "Hold (park) a POS cart as a held sale (Issue #286)"
    },
    {
      activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
      action: "update",
      description: "Resume or discard your own held sale (Issue #286)"
    },
    {
      activityCode: COMMERCE_HELD_SALES_ACTIVITY_CODE,
      action: "approve",
      description:
        "See, resume or discard another cashier's held sale (Issue #286)"
    },
    {
      activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
      action: "read",
      description: "List and read quotations and their versions (Issue #286)"
    },
    {
      activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
      action: "create",
      description: "Create a quotation or add a revised version (Issue #286)"
    },
    {
      activityCode: COMMERCE_QUOTATIONS_ACTIVITY_CODE,
      action: "update",
      description: "Send, accept, reject or cancel a quotation (Issue #286)"
    },
    {
      activityCode: COMMERCE_QUOTATION_CONVERSIONS_ACTIVITY_CODE,
      action: "create",
      description:
        "Convert an accepted quotation into a commerce order (Issue #286)"
    },
    {
      activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
      action: "read",
      description:
        "List and read work orders and their status history (Issue #286)"
    },
    {
      activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
      action: "create",
      description:
        "Create a work order, optionally from an accepted quotation (Issue #286)"
    },
    {
      activityCode: COMMERCE_WORK_ORDERS_ACTIVITY_CODE,
      action: "update",
      description:
        "Move a work order through its status machine or reassign it (Issue #286)"
    },
    {
      activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
      action: "read",
      description:
        "List, read and render (print) receipt and invoice documents (Issue #286)"
    },
    {
      activityCode: COMMERCE_DOCUMENTS_ACTIVITY_CODE,
      action: "create",
      description:
        "Issue a numbered receipt or invoice document for a finalized order (Issue #286)"
    },
    {
      activityCode: COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
      action: "read",
      description:
        "Read the delivery history of a commercial document (Issue #295)"
    },
    {
      activityCode: COMMERCE_DOCUMENT_DELIVERIES_ACTIVITY_CODE,
      action: "create",
      description:
        "Send or re-send a commercial document to the customer on file by e-mail or WhatsApp (Issue #295)"
    },
    {
      activityCode: COMMERCE_DOCUMENT_DELIVERY_OVERRIDES_ACTIVITY_CODE,
      action: "create",
      description:
        "Send a commercial document to a recipient other than the customer on file (Issue #295)"
    },
    // Issue #296 (ADR-0035) - the POS operational reports: read + the
    // high-risk export, one pair per report family.
    {
      activityCode: COMMERCE_REPORT_TENDERS_ACTIVITY_CODE,
      action: "read",
      description: "Read the tender-mix operational report (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_TENDERS_ACTIVITY_CODE,
      action: "export",
      description:
        "Export the tender-mix operational report as CSV (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
      action: "read",
      description: "Read the cash-up variance operational report (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_CASH_UPS_ACTIVITY_CODE,
      action: "export",
      description:
        "Export the cash-up variance operational report as CSV (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
      action: "read",
      description: "Read the expenses operational report (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_EXPENSES_ACTIVITY_CODE,
      action: "export",
      description: "Export the expenses operational report as CSV (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
      action: "read",
      description: "Read the loyalty-points operational report (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_LOYALTY_ACTIVITY_CODE,
      action: "export",
      description:
        "Export the loyalty-points operational report as CSV (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
      action: "read",
      description:
        "Read the stored-value liability operational report (Issue #296)"
    },
    {
      activityCode: COMMERCE_REPORT_STORED_VALUE_ACTIVITY_CODE,
      action: "export",
      description:
        "Export the stored-value liability operational report as CSV (Issue #296)"
    },
    // Issue #316 - the returns & refunds family.
    {
      activityCode: COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read the returns and refunds operational report (Issue #316)"
    },
    {
      activityCode: COMMERCE_REPORT_RETURNS_ACTIVITY_CODE,
      action: "export",
      description:
        "Export the returns and refunds operational report as CSV (Issue #316)"
    },
    {
      activityCode: COMMERCE_BARCODES_ACTIVITY_CODE,
      action: "read",
      description:
        "Resolve a scanned barcode, browse the barcode catalogue and print label sheets (Issue #292)"
    },
    {
      activityCode: COMMERCE_BARCODES_ACTIVITY_CODE,
      action: "update",
      description:
        "Assign, change or clear the barcode of a product or variant (Issue #292)"
    },
    {
      activityCode: COMMERCE_INVENTORY_ACTIVITY_CODE,
      action: "read",
      description:
        "Read the stock-ledger mode and the stock-cache reconciliation (Issue #282)"
    },
    {
      activityCode: COMMERCE_INVENTORY_ACTIVITY_CODE,
      action: "configure",
      description:
        "Roll the stock authority back to counter mode and resync the stock cache from the ledger (Issue #282)"
    },
    {
      activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read returns, exchanges, their lines and refund legs (Issue #287)"
    },
    {
      activityCode: COMMERCE_RETURNS_ACTIVITY_CODE,
      action: "create",
      description:
        "Record a return or exchange of goods sold on an order, and link an exchange's replacement order (Issue #287)"
    },
    {
      activityCode: COMMERCE_REFUNDS_ACTIVITY_CODE,
      action: "read",
      description:
        "Read refund legs and the compensations a settled refund had (Issue #287)"
    },
    {
      activityCode: COMMERCE_REFUNDS_ACTIVITY_CODE,
      action: "create",
      description:
        "Settle a refund leg: hand back cash, book a manual refund, return value to a gift card, issue store credit or call the payment provider (Issue #287)"
    },
    {
      activityCode: COMMERCE_REFUNDS_OFFLINE_ACTIVITY_CODE,
      action: "approve",
      description:
        "Attest that a refund was made outside the system when the provider or adapter could not make it (Issue #287)"
    },
    {
      activityCode: COMMERCE_ENTITLEMENTS_ACTIVITY_CODE,
      action: "read",
      description:
        "List/look up commerce entitlement records (Issue #267, IRMbyDUS)"
    },
    {
      activityCode: COMMERCE_ENTITLEMENTS_ACTIVITY_CODE,
      action: "update",
      description:
        "Revoke a commerce entitlement — the only admin mutation this module has; grants happen only via the order-paid consumer (Issue #267)"
    },
    {
      activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
      action: "read",
      description: "List catalog attribute definitions (Issue #291)"
    },
    {
      activityCode: COMMERCE_ATTRIBUTES_ACTIVITY_CODE,
      action: "manage",
      description:
        "Create, update and delete catalog attribute definitions (Issue #291)"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "export",
      description: "Export the product catalog as CSV (Issue #291)"
    },
    {
      activityCode: COMMERCE_PRODUCTS_ACTIVITY_CODE,
      action: "import",
      description: "Dry-run and apply a product catalog CSV import (Issue #291)"
    },
    {
      activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
      action: "read",
      description:
        "View loyalty programs, customer point balances, the point ledger and the loyalty summary (Issue #289)"
    },
    {
      activityCode: COMMERCE_LOYALTY_ACTIVITY_CODE,
      action: "manage",
      description:
        "Create, edit, activate and retire loyalty program versions, and repair a drifted balance projection from the ledger (Issue #289)"
    },
    {
      activityCode: COMMERCE_LOYALTY_ADJUSTMENTS_ACTIVITY_CODE,
      action: "create",
      description:
        "Record a manual loyalty points adjustment — a signed ledger entry with a mandatory reason (Issue #289)"
    },
    {
      activityCode: COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE,
      action: "create",
      description:
        "Redeem a customer's loyalty points at the counter or on their behalf (Issue #289)"
    },
    {
      activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
      action: "read",
      description: "List expense categories (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
      action: "create",
      description: "Define an expense category (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE,
      action: "update",
      description: "Rename or (de)activate an expense category (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
      action: "read",
      description: "List and read expenses and the expense summary (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
      action: "create",
      description: "Create a draft expense (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
      action: "update",
      description: "Edit or discard a draft expense (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSES_ACTIVITY_CODE,
      action: "export",
      description: "Export expenses as CSV (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
      action: "create",
      description: "Submit a draft expense for posting (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE,
      action: "approve",
      description:
        "Approve or reject an expense above the approval threshold (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE,
      action: "approve",
      description:
        "Reverse a posted expense with a compensating entry (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
      action: "read",
      description:
        "Issue a short-lived download URL for an expense receipt (Issue #294)"
    },
    {
      activityCode: COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE,
      action: "create",
      description: "Attach a private receipt to an expense (Issue #294)"
    }
  ]
});

// Re-exported so a route/test can guard on the same constants `module.ts`
// declares permissions from, without re-typing the string — same convention
// `media-library`'s routes use against `MEDIA_PERMISSIONS`.
export {
  COMMERCE_CATEGORY_PERMISSIONS,
  COMMERCE_PRODUCT_PERMISSIONS,
  COMMERCE_FLASH_SALE_PERMISSIONS,
  COMMERCE_VOUCHER_PERMISSIONS,
  COMMERCE_SLIDER_PERMISSIONS,
  COMMERCE_TESTIMONIAL_PERMISSIONS,
  COMMERCE_POPUP_PERMISSIONS,
  COMMERCE_SETTINGS_PERMISSIONS,
  COMMERCE_ORDER_PERMISSIONS,
  COMMERCE_CUSTOMER_PERMISSIONS,
  COMMERCE_REVIEW_PERMISSIONS,
  COMMERCE_AFFILIATE_PERMISSIONS,
  COMMERCE_AFFILIATE_COMMISSION_PERMISSIONS,
  COMMERCE_WHATSAPP_PERMISSIONS,
  COMMERCE_CONVERSATION_PERMISSIONS,
  COMMERCE_CAMPAIGN_PERMISSIONS,
  COMMERCE_WEBHOOK_ENDPOINT_PERMISSIONS,
  COMMERCE_POS_PERMISSIONS,
  COMMERCE_POS_DUE_PERMISSIONS,
  COMMERCE_PAYMENT_PERMISSIONS,
  COMMERCE_REGISTER_PERMISSIONS,
  COMMERCE_REGISTER_SESSION_PERMISSIONS,
  COMMERCE_REGISTER_CASH_UP_PERMISSIONS,
  COMMERCE_REGISTER_CORRECTION_PERMISSIONS,
  COMMERCE_HELD_SALE_PERMISSIONS,
  COMMERCE_QUOTATION_PERMISSIONS,
  COMMERCE_QUOTATION_CONVERSION_PERMISSIONS,
  COMMERCE_WORK_ORDER_PERMISSIONS,
  COMMERCE_DOCUMENT_PERMISSIONS,
  COMMERCE_ATTRIBUTE_PERMISSIONS,
  COMMERCE_STORED_VALUE_PROGRAM_PERMISSIONS,
  COMMERCE_STORED_VALUE_PERMISSIONS,
  COMMERCE_STORED_VALUE_ADJUSTMENT_PERMISSIONS,
  COMMERCE_STORED_VALUE_RECONCILE_PERMISSIONS,
  COMMERCE_EXPENSE_CATEGORY_PERMISSIONS,
  COMMERCE_EXPENSE_PERMISSIONS,
  COMMERCE_EXPENSE_POSTING_PERMISSIONS,
  COMMERCE_EXPENSE_REVERSAL_PERMISSIONS,
  COMMERCE_EXPENSE_RECEIPT_PERMISSIONS,
  COMMERCE_DOCUMENT_DELIVERY_PERMISSIONS,
  COMMERCE_DOCUMENT_DELIVERY_OVERRIDE_PERMISSIONS
};
export {
  COMMERCE_LOYALTY_PERMISSIONS,
  COMMERCE_LOYALTY_ADJUSTMENT_PERMISSIONS,
  COMMERCE_LOYALTY_REDEMPTION_PERMISSIONS,
  COMMERCE_RETURN_PERMISSIONS,
  COMMERCE_REFUND_PERMISSIONS,
  COMMERCE_REFUND_OFFLINE_PERMISSIONS
} from "./domain/commerce-permissions";
