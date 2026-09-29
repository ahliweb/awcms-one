import { defineModule } from "../_shared/module-contract";
import {
  PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
  PRACTICE_IRM_MODULE_KEY
} from "./domain/practice-irm-permissions";

/**
 * `practice_irm` (Issue #270, ADR-0002 in `web-irmbydus.com`) — the first
 * genuinely NEW IRMbyDUS domain module: no IRM/practice content model
 * existed anywhere in this codebase before this PR (discovery in ADR-0002's
 * Context section lists every `apps/cms` module at the time and `practice-
 * irm` is not one of them).
 *
 * Two things, both gated by `commerce`'s entitlement layer
 * (`verifyEntitlement`, Issue #267):
 *
 *   1. The five canonical IRM domains (IDENTIFY/NEUTRALIZE/NAVIGATE/EMBED/
 *      REINFORCE) as admin-editable CMS content — `awcms_practice_irm_
 *      domains` (`sql/940`), tenant-scoped, RLS tenant-isolation only. This
 *      is what keeps `web-irmbydus.com` from holding its own copy of IRM
 *      terminology (ADR-0002's "preventing terminology drift").
 *   2. `practice_sessions` — the 12-field guided journal record from PRD §16
 *      — `awcms_practice_irm_sessions` (`sql/941`), owned by a `commerce`
 *      customer (`owner_customer_id`), gated per call by
 *      `verifyEntitlement(ownerCustomerId, productId)`.
 *
 * ## Why this depends on `commerce` rather than inventing its own identity
 *
 * `commerce`'s customer accounts (ADR-0016) are ALREADY the bearer-session
 * identity a paying customer holds in this system, and `commerce`'s
 * entitlement layer (Issue #267) already answers "did this customer buy
 * access to this product" — the exact question every practice-irm route
 * needs answered before it does anything. A second customer identity here
 * would fork ADR-0016's whole design (OTP, bearer sessions, `commerce`
 * customer accounts) for no reason this module has: a practice session is
 * unlocked BY a commerce purchase, so its owner is necessarily a commerce
 * customer already. `requireCustomerSession` (`commerce/application/
 * customer-session-auth.ts`) and `verifyEntitlement`
 * (`commerce/application/commerce-entitlement-directory.ts`) are imported
 * directly, cross-module, exactly as intended.
 *
 * ## What this module deliberately does NOT do
 *
 * There is no tenant-staff read path into `awcms_practice_irm_sessions` at
 * all — no admin permission, no admin screen, no admin route. PRD's Major
 * Risks table (§40) names "Journal leakage" as Critical, mitigated by "RLS +
 * ABAC + tests + audit"; the strongest form of that mitigation is that the
 * content simply is not exposed to a tenant-staff surface in this PR. Every
 * session route is a customer bearer-session route.
 *
 * `program-21day` (ADR-0002's second module, `program_enrollments`/
 * `program_day_states`) is explicitly OUT of scope for this PR — Issue #270
 * covers `practice-irm` alone; the 21-Day Practice program is a separate
 * module admitted separately.
 *
 * `intensity`/`postIntensity` carry NO derived scoring/classification
 * anywhere in this module (PRD §38 Explicit Non-Goals: no clinical scoring,
 * no psychological profiling) — see `domain/practice-session.ts`'s header.
 */
export const practiceIrmModule = defineModule({
  key: PRACTICE_IRM_MODULE_KEY,
  name: "Practice IRM",
  version: "0.1.0",
  status: "active",
  description:
    "IRMbyDUS practice-irm module (Issue #270, ADR-0002): the five canonical IRM domains (identify/neutralize/navigate/embed/reinforce) as admin-editable CMS content (awcms_practice_irm_domains, sql/940), preventing the terminology drift ADR-0002 names as a risk, plus practice_sessions (awcms_practice_irm_sessions, sql/941) — the 12-field guided-journal record from PRD §16, owned by a commerce customer and gated per call by commerce's verifyEntitlement(ownerCustomerId, productId). intensity/postIntensity are plain 0-10 integers with a database CHECK constraint and no derived scoring logic anywhere (PRD explicitly forbids diagnostic framing). No tenant-staff read path exists into a customer's sessions — every session route is a commerce customer bearer-session route, and the only admin surface this module has is the five-domain content CRUD.",
  dependencies: [
    "tenant_admin",
    "identity_access",
    "module_management",
    "logging",
    // `commerce` for TWO things: `verifyEntitlement`
    // (`application/commerce-entitlement-directory.ts`, Issue #267) — the
    // access gate every session create/read calls first — and
    // `requireCustomerSession` (`application/customer-session-auth.ts`) —
    // the SAME bearer-session identity a paying customer already holds
    // (ADR-0016). Both `awcms_practice_irm_sessions.owner_customer_id` and
    // `.product_id` are foreign keys into `commerce`'s own tables
    // (`awcms_commerce_customers`/`awcms_commerce_products`, sql/941), so
    // this dependency is structural, not merely a convenience import.
    "commerce"
  ],
  type: "domain",
  isCore: false,
  api: {
    openApiPath: "openapi/modules/practice-irm.openapi.yaml",
    basePath: "/api/v1/practice-irm",
    routes: ["/api/v1/practice-irm"]
  },
  navigation: [
    // The one admin screen this module has — the five-domain content
    // editor. Per this module's own header, there is no second admin
    // screen for practice_sessions: no tenant-staff surface reads a
    // customer's journal.
    {
      labelKey: "admin.layout.nav_practice_irm_domains",
      path: "/admin/practice-irm-domains",
      order: 90,
      requiredPermission: "practice_irm.domains.read"
    }
  ],
  permissions: [
    {
      activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
      action: "read",
      description: "Read the five canonical IRM domains' admin-editable content"
    },
    {
      activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
      action: "create",
      description: "Create a domain's content row when none exists yet"
    },
    {
      activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
      action: "update",
      description: "Update a domain's name/description/copy"
    },
    {
      activityCode: PRACTICE_IRM_DOMAINS_ACTIVITY_CODE,
      action: "delete",
      description: "Reset a domain's content back to the built-in default"
    }
  ],
  dataLifecycle: [
    {
      key: "practice_irm.domains",
      tableName: "awcms_practice_irm_domains",
      ownerModuleKey: PRACTICE_IRM_MODULE_KEY,
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // A live domain row has no natural age limit — the window describes
      // how long a "reset to default" (deleted_at set) row may sit before
      // an operator's retention sweep hard-purges it. Same shape
      // `commerce.categories`' own descriptor uses for the identical
      // "deleted_at is NULL for every live row, so a purge predicate keyed
      // on it can never reach one" reason.
      retentionMinDays: 30,
      retentionMaxDays: 3650,
      defaultRetentionDays: 365,
      partition: {
        eligible: false,
        rationale:
          "At most five rows per tenant by construction (one per domain_key) — nowhere near partition-worthy volume."
      },
      archive: {
        archivable: false,
        rationale:
          "A reset domain row is the tenant's own superseded content; the live content is whatever the next create/update wrote, and the built-in default (this module's own code) is always reachable — nothing here is lost by a plain hard delete once purge-eligible."
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
            "awcms_practice_irm_domains_tenant_deleted_idx (sql/940) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        }
      ],
      batchLimit: 100,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purged reset row is indistinguishable from a tenant that never customized this domain — both read as the built-in default.",
      executionMode: "generic"
    },
    {
      key: "practice_irm.sessions",
      tableName: "awcms_practice_irm_sessions",
      ownerModuleKey: PRACTICE_IRM_MODULE_KEY,
      scope: "tenant",
      cursorColumn: "deleted_at",
      retentionClass: "system_event",
      // Wide window, matching `commerce.customer_addresses`' own real,
      // non-fiscal personal data — a practice session is the customer's own
      // guided-journal record, not a housekeeping artifact.
      retentionMinDays: 365,
      retentionMaxDays: 3650,
      defaultRetentionDays: 1825,
      partition: {
        eligible: false,
        rationale:
          "Bounded by a single tenant's own customer base and how often each customer logs a session — nowhere near partition-worthy volume for the deployment profile this module targets."
      },
      archive: {
        archivable: false,
        rationale:
          "The generic engine's only implemented artefact is ordinary backup/restore; no standalone archive exists yet for this table."
      },
      deletion: {
        mode: "hard_delete",
        rationale:
          "Technically the generic engine's only mode, but practically UNREACHABLE in this PR: no route sets deleted_at yet (see sql/941's header and this module's README, 'known limitations') — deleted_at stays NULL for every row, so the purge predicate never matches."
      },
      legalHold: { applicable: false, precedence: "not_applicable" },
      requiredIndexes: [
        {
          columns: ["tenant_id", "deleted_at"],
          purpose:
            "awcms_practice_irm_sessions_tenant_deleted_idx (sql/941) — the (tenant, cursor) composite the generic purge engine filters + orders by."
        },
        {
          columns: ["tenant_id", "owner_customer_id", "product_id"],
          purpose:
            "awcms_practice_irm_sessions_tenant_owner_product_idx (sql/941) — the 'my sessions' history read's own lookup shape."
        }
      ],
      batchLimit: 5000,
      backupRestoreNotes:
        "Included in ordinary full-database backup/restore; no standalone archive artifact. A purge is irreversible outside a restore.",
      executionMode: "generic"
    }
  ],
  subjectData: [
    {
      key: "practice_irm.domains",
      tableName: "awcms_practice_irm_domains",
      ownerModuleKey: PRACTICE_IRM_MODULE_KEY,
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "Tenant-staff-authored CMS copy describing the five IRM domains — naming nobody, matchable to nobody. No column on this table identifies a person; the built-in fallback (this module's own code) means the table can even be entirely empty without affecting what a reader sees."
    },
    {
      key: "practice_irm.sessions",
      tableName: "awcms_practice_irm_sessions",
      ownerModuleKey: PRACTICE_IRM_MODULE_KEY,
      // owner_customer_id names a row in commerce.customers, which itself
      // carries no tenant_user/identity/profile/principal id (ADR-0016 D1 —
      // the same gap commerce.entitlements'/commerce.orders' own subjectData
      // entries document) — this engine's subject vocabulary still cannot
      // reach it. See this module's README, "known limitations": a future
      // self-service export/erasure route (mirroring commerce's own
      // bearer-secured account routes) is the honest path for a customer to
      // exercise these rights over their own session content; none ships in
      // this PR.
      unreachableBySubject: true,
      subjectColumns: [],
      exportable: false,
      erasure: "retain_under_obligation",
      rationale:
        "A customer's own guided-journal content — situation/emotion/intensity/body/automatic_thought/meaning/neutralize/post_intensity/navigate/embed/reinforce/reflection. Genuinely personal, sensitive data, but owner_customer_id is unreachable by this engine's tenant_user/identity/profile/principal vocabulary for the same structural reason commerce.entitlements/commerce.customers are (ADR-0016 D1). No self-service export/delete route ships in this PR (see this module's README)."
    }
  ]
});
