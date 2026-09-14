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
 * `commerce` (Issue #4, part of epic #1, depends on #2/#3) — the catalog
 * slice of the re-platformed storefront: categories (hierarchical,
 * self-referencing) and products, ported from the legacy MySQL
 * `commerce_bj_mart.{categories,products}` tables.
 *
 * CATALOG ONLY. Deliberately deferred to a later increment (see the source
 * schema note in the issue): tiered pricing (`price_level_2/3/4`),
 * `cost_price`, affiliate fields, size charts, insurance fields, promo
 * banners, `variant_attributes`, and the related tables
 * (`product_images`, `product_variants`, `flash_sale_products`,
 * `product_affiliate_links`). None of those are referenced anywhere in this
 * module, so admitting them later is additive, not a rewrite.
 *
 * `price` is `numeric(14,2)`, never a float (`sql/153`'s header has the full
 * arithmetic-drift reasoning) — `Bun.SQL` hands it back as a STRING, and this
 * module never parses it to a number; the DTO keeps it a string all the way
 * to the storefront.
 *
 * `dependencies`: `tenant_admin` for the tenant row, `identity_access` for
 * the guard chain, `domain_event_runtime` because `product-directory.ts`
 * calls `appendDomainEvent` (same reasoning `comments`/`workflow_approval`
 * declare it for). No `media_library` dependency, because `product_images` is
 * explicitly out of THIS slice.
 *
 * The DTO (`CommerceCategory`/`CommerceProduct`) is shared VERBATIM with
 * Issue #5 — see `application/product-directory.ts` / `category-directory.ts`'s
 * `toRecord` functions, which are the one place that shape is assembled, and
 * deliberately exclude `createdAt`/`updatedAt`/`deletedAt` (present on the
 * rows, absent from the contract).
 */
export const commerceModule = defineModule({
  key: "commerce",
  name: "Commerce",
  version: "0.1.0",
  status: "active",
  description:
    "Catalog slice (Issue #4, epic #1): tenant-scoped product categories (hierarchical, self-referencing parent) and products (physical/digital/service/subscription), ported from the legacy MySQL commerce_bj_mart schema's core catalog columns. price is numeric(14,2) and crosses the wire as a string, never a float. Deliberately excludes tiered pricing, cost price, affiliate links, size charts, insurance fields, promo banners, variant attributes, and the product-images/product-variants/flash-sale/affiliate-link tables — none of this module's code references them, so a later increment can add them without a rewrite. No media_library dependency in this slice: product images are one of the deferred tables. Ships no restore endpoint: a soft-deleted category or product is retained (for the FK integrity of rows that still reference it) but not exposed for recovery here.",
  dependencies: ["tenant_admin", "identity_access", "domain_event_runtime"],
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
  // Read-only for now (`src/pages/admin/commerce.astro`) — every ACTIVE
  // module must have at least one screen
  // (`admin-media-page-contract.test.ts`'s "no active module is left without
  // an admin screen — ZERO exceptions"), so this is not optional. Gated on
  // `products.read`, the primary resource; `categories.*` stays on
  // `scripts/admin-screen-coverage-ledger.ts`'s `NOT_YET_SCREENED` until a
  // fuller CRUD screen lands. `admin.menu_type.commerce` (`sidebar-menu.ts`)
  // predates this module by design — ADR-0035 reserved the slot, and this is
  // the first module to fill it.
  navigation: [
    {
      labelKey: "admin.layout.nav_commerce",
      path: "/admin/commerce",
      order: 1,
      requiredPermission: "commerce.products.read"
    }
  ],
  /**
   * ADR-0037 (`data_lifecycle`) — Issue #437's table-coverage gate requires
   * every table to answer the retention question, and a live catalog row has
   * no natural age limit (a SKU from three years ago that is still selling is
   * not stale), so neither `BOUNDED_BY_DESIGN` (a real catalog is not bounded
   * — a large tenant reaches thousands of rows) nor age-based purge of LIVE
   * rows is honest here. What these two descriptors opt into instead is
   * `data_lifecycle`'s GENERIC engine purging already soft-deleted rows once
   * they have aged past the retention window — no hand-rolled purge job, and
   * deliberately no fourth file added to Issue #4's checklist for one.
   *
   * `cursorColumn: "deleted_at"` (not `created_at`, unlike every other
   * `executionMode: "generic"` descriptor in this base) is what makes that
   * safe: the generic engine's own query is `WHERE ... AND deleted_at < $2`,
   * and in SQL `NULL < $2` is neither true nor false, so a LIVE row (whose
   * `deleted_at IS NULL`) can never match the predicate — the engine is
   * mathematically incapable of reaching one, not merely configured not to.
   * Only a row already soft-deleted (Issue #4 ships no restore endpoint for
   * either table) becomes purge-eligible, and only after it has sat deleted
   * for the retention window.
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
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above). A purge is irreversible outside a restore — there is no API-level restore for this slice.",
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
        "Included in ordinary full-database backup/restore; no standalone archive artifact (archive.archivable is false above). A purge is irreversible outside a restore — there is no API-level restore for this slice.",
      executionMode: "generic"
    }
  ],
  /**
   * ADR-0094 wave-shape reuse: both tables are catalog/business data, not
   * data about a person. Neither carries a `created_by`/`updated_by`/
   * `deleted_by` column at all (Issue #4's table-convention list does not
   * call for them, unlike `awcms_offices`) — WHO changed a row lives only in
   * the audit log (`recordAuditEvent`'s `actorTenantUserId`), so there is no
   * column here that could join a row to a subject even in principle. Same
   * `unreachableBySubject`/`retain_under_obligation` shape
   * `tenant_admin.tenant_settings` uses for the same reason ("naming nobody
   * and matchable to nobody").
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
        "A tenant's product catalog — sku, name, price, stock, and the rest of Issue #4's catalog slice. Business/merchandising data the tenant authored about what it sells, not about a person; no column on this table identifies a person."
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
    }
  ]
});

// Re-exported so a route/test can guard on the same constants `module.ts`
// declares permissions from, without re-typing the string — same convention
// `media-library`'s routes use against `MEDIA_PERMISSIONS`.
export { COMMERCE_CATEGORY_PERMISSIONS, COMMERCE_PRODUCT_PERMISSIONS };
