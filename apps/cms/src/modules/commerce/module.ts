import { defineModule } from "../_shared/module-contract";
import {
  COMMERCE_CATEGORIES_ACTIVITY_CODE,
  COMMERCE_CATEGORY_PERMISSIONS,
  COMMERCE_PRODUCTS_ACTIVITY_CODE,
  COMMERCE_PRODUCT_PERMISSIONS
} from "./domain/commerce-permissions";
import {
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
    "Full BjekMart product-model parity (Issue #23, epic #21) on top of the Issue #4 catalog core: tenant-scoped product categories (hierarchical, self-referencing parent, with a computed productCount) and products (physical/digital/service/subscription) carrying tiered pricing, cost price (admin-only), weight, manual rating/sold-count, insurance, promo banners, a size chart (image or table), a service intake form, subscription period, a digital download link, deposit/free-shipping flags, variant attributes, and explicit is_featured/is_recommended merchandising flags — plus the product_images and product_variants tables a real product page needs. price/priceLevel2-4/costPrice/insuranceFee/finalPrice are numeric(14,2) and cross the wire as strings, never floats. Depends on media_library for product image references. Ships restore endpoints for both categories and products alongside the Issue #4 soft-delete.",
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
      COMMERCE_PRODUCT_STATUS_CHANGED_EVENT_TYPE
    ]
  },
  // Two full CRUD screens as of Issue #23 (`src/pages/admin/commerce.astro`,
  // `commerce-categories.astro`) — every ACTIVE module must have at least one
  // screen (`admin-media-page-contract.test.ts`'s "no active module is left
  // without an admin screen — ZERO exceptions"), and Issue #4's read-only
  // single screen is now a full product/category CRUD pair.
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
    }
  ]
});

// Re-exported so a route/test can guard on the same constants `module.ts`
// declares permissions from, without re-typing the string — same convention
// `media-library`'s routes use against `MEDIA_PERMISSIONS`.
export { COMMERCE_CATEGORY_PERMISSIONS, COMMERCE_PRODUCT_PERMISSIONS };
