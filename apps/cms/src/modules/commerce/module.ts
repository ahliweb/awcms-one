import { defineModule } from "../_shared/module-contract";
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
  COMMERCE_VOUCHER_PERMISSIONS
} from "./domain/commerce-permissions";
import {
  COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE,
  COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE,
  COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
  COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
  COMMERCE_PRODUCT_UPDATED_EVENT_TYPE
} from "./domain/commerce-events";

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
 * `numeric(14,2)`, never a float (`sql/153`'s header has the full
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
 * `toAdminRecord()` (the admin screen's own fetch) does. See `sql/156`'s
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
    "media_library"
  ],
  type: "domain",
  isCore: false,
  api: {
    openApiPath: "openapi/modules/commerce.openapi.yaml",
    basePath: "/api/v1/commerce"
  },
  events: {
    asyncApiPath: "asyncapi/awcms-domain-events.asyncapi.yaml",
    publishes: [
      COMMERCE_PRODUCT_CREATED_EVENT_TYPE,
      COMMERCE_PRODUCT_UPDATED_EVENT_TYPE,
      COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE,
      COMMERCE_FLASH_SALE_STARTED_EVENT_TYPE,
      COMMERCE_FLASH_SALE_ENDED_EVENT_TYPE
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
    }
  ],
  // Full CRUD screens: two as of Issue #23 (`src/pages/admin/commerce.astro`,
  // `commerce-categories.astro`), six more added by Issue #26 for the
  // marketing surface — every ACTIVE module must have at least one screen
  // (`admin-media-page-contract.test.ts`'s "no active module is left without
  // an admin screen — ZERO exceptions"), and every one of this module's
  // fourteen declared permissions is now claimed by one of the eight.
  // `admin.menu_type.commerce` (`sidebar-menu.ts`) predates this module by
  // design — ADR-0035 reserved the slot.
  navigation: [
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
            "awcms_commerce_categories_tenant_deleted_idx (sql/153) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_products_tenant_deleted_idx (sql/153) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_product_images_tenant_deleted_idx (sql/157) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_product_variants_tenant_deleted_idx (sql/157) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_flash_sales_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_flash_sale_products_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_vouchers_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_sliders_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
            "awcms_commerce_testimonials_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
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
          "At most one ACTIVE popup per tenant by construction (sql/161's own partial unique index); even the full history of past popups stays tiny."
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
            "awcms_commerce_popups_tenant_deleted_idx (sql/161) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact.",
      executionMode: "generic"
    },
    {
      // One row per tenant, and `deleted_at` means "an owner reset the store to
      // defaults" (sql/162's header) — NOT that the tenant is gone. A live
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
            "awcms_commerce_store_settings_tenant_deleted_idx (sql/162) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 100,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purged reset row is indistinguishable from a tenant that never saved settings — both read as the defaults.",
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
  COMMERCE_SETTINGS_PERMISSIONS
};
