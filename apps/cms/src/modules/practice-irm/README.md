🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# `practice_irm`

Issue [#270](https://github.com/ahliweb/awcms-one/issues/270) (IRMbyDUS: practice-irm module), ADR-0002 (`web-irmbydus:docs/adr/0002-irm-domain-extension-strategy.md` — a DIFFERENT repository, the product repo this module serves, hence the sibling-repo `web-irmbydus:` scope rather than a relative link; read as the design reference, not duplicated). This is a genuinely NEW module: no IRM/practice content model existed anywhere in `apps/cms` before this PR.

## Purpose

Two things, both gated by `commerce`'s entitlement layer (Issue #267):

1. **The five canonical IRM domains** — IDENTIFY / NEUTRALIZE / NAVIGATE / EMBED / REINFORCE — as admin-editable CMS content. `web-irmbydus.com` renders whatever `GET /api/v1/practice-irm/storefront/account/content` returns and holds no independent copy of a domain's name/description/copy. This is what PRD's "IRM terminology drift" risk (Major Risks table, §40) is mitigated by: a wording fix ships as one admin edit here, never a frontend deploy.
2. **`practice_sessions`** — the 12-field guided-journal record from PRD §16, owned by a `commerce` customer, gated per call by `verifyEntitlement(ownerCustomerId, productId)`.

`program-21day` (ADR-0002's second module, `program_enrollments`/`program_day_states`) is explicitly out of scope for this PR.

## Why this depends on `commerce` rather than inventing its own identity

`commerce`'s customer accounts ([ADR-0016](../../../../../docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)) are already the bearer-session identity a paying customer holds in this system, and `commerce`'s entitlement layer (Issue #267, `application/commerce-entitlement-directory.ts`) already answers "did this customer buy access to this product" — exactly the question every route in this module needs answered before doing anything. `requireCustomerSession` and `verifyEntitlement` are imported directly, cross-module.

## Tables

### `awcms_practice_irm_domains` (`sql/940`)

| Column                        | Type                    | Notes                                                                                                                                                                        |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                          | uuid PK                 |                                                                                                                                                                              |
| `tenant_id`                   | uuid FK `awcms_tenants` |                                                                                                                                                                              |
| `domain_key`                  | text                    | one of `identify`/`neutralize`/`navigate`/`embed`/`reinforce`, CHECK-constrained                                                                                             |
| `name`, `description`, `copy` | text                    | the admin-editable content                                                                                                                                                   |
| `display_order`               | integer                 |                                                                                                                                                                              |
| `deleted_at`                  | timestamptz, nullable   | set means "reset to the built-in default" — the same convention `awcms_commerce_store_settings` (`sql/910`) established. No real `DELETE` is ever issued against this table. |
| `created_at`/`updated_at`     | timestamptz             |                                                                                                                                                                              |

At most one LIVE row per `(tenant_id, domain_key)` (a partial unique index on `deleted_at IS NULL`). RLS: tenant isolation only — this table has no customer/owner dimension.

`DEFAULT_PRACTICE_IRM_DOMAIN_CONTENT` (`domain/practice-irm-domain-content.ts`) is the fallback every read path (`listPracticeIrmDomains`/`getPracticeIrmDomain`) falls back to for a `domain_key` with no live row — so the public content is never blank, even for a brand-new tenant that has never opened the admin screen, and a "reset" never leaves it blank either.

### `awcms_practice_irm_sessions` (`sql/941`)

| Column                                                                                                                       | Type                               | Notes                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `id`                                                                                                                         | uuid PK                            |                                                                                              |
| `tenant_id`                                                                                                                  | uuid FK `awcms_tenants`            |                                                                                              |
| `owner_customer_id`                                                                                                          | uuid FK `awcms_commerce_customers` | owner — see "Owner-scoping" below                                                            |
| `product_id`                                                                                                                 | uuid FK `awcms_commerce_products`  | which entitlement unlocked this session at creation time                                     |
| `status`                                                                                                                     | text                               | `draft` \| `completed`; `draft -> completed` is the only transition                          |
| `situation`, `emotion`, `body`, `automatic_thought`, `meaning`, `neutralize`, `navigate`, `embed`, `reinforce`, `reflection` | text, nullable                     | the free-text PRD §16 fields                                                                 |
| `intensity`, `post_intensity`                                                                                                | integer, nullable                  | **plain 0-10 integers, CHECK-constrained, nothing derived** — see "No derived scoring" below |
| `completed_at`                                                                                                               | timestamptz, nullable              | set exactly when `status` becomes `completed`                                                |
| `deleted_at`                                                                                                                 | timestamptz, nullable              | present for schema uniformity; **no route in this PR sets it** (see "Known limitations")     |
| `created_at`/`updated_at`                                                                                                    | timestamptz                        |                                                                                              |

The 12 fields walk the five domains in order: `situation`/`emotion`/`intensity`/`body`/`automatic_thought`/`meaning` is IDENTIFY; `neutralize` is NEUTRALIZE; `post_intensity` re-measures after it; `navigate`/`embed`/`reinforce` are their own domains; `reflection` closes the session.

## RLS and owner-scoping

Both tables: `ENABLE` + `FORCE ROW LEVEL SECURITY`, one tenant-isolation `USING` policy (`tenant_id = current_setting('app.current_tenant_id')::uuid`) — identical shape to `awcms_commerce_entitlements` (`sql/936`).

For `awcms_practice_irm_sessions`, owner-scoping is **application-level**, the same way `commerce-entitlement-directory.ts`'s `listEntitlementsForCustomer` already does it (ADR-0016 D1: there is no `app.current_customer_id` session variable anywhere in this codebase, so a second RLS policy keyed on the calling customer is not a shape this system has). `owner_customer_id` is read **only** from the verified bearer session (`requireCustomerSession`, reused directly from `commerce/application/customer-session-auth.ts`), never accepted from request input, and every query in `application/practice-session-directory.ts` filters on it explicitly.

## The entitlement gate

Every function in `application/practice-session-directory.ts` — create, read one, list, update, complete — calls `verifyEntitlement(tx, tenantId, ownerCustomerId, productId)` **first**, live, no cache, before touching a row. A customer without an active entitlement for `productId` gets `{ kind: "forbidden" }` → the route answers `403 ENTITLEMENT_REQUIRED` and returns nothing — never practice content, never the ability to log or read a session, including history. A revoke therefore cuts off access on the very next call, exactly like `verifyEntitlement`'s own behaviour for entitlement-check.

The same gate applies to reading the five-domain content over the customer-facing route (`GET .../storefront/account/content`) — content, not just sessions, requires an active entitlement for the `productId` the caller names.

## No derived scoring — a rule, not a preference

PRD's Explicit Non-Goals (§38) forbid "clinical scoring"/"psychological profiling"; ADR-0002's Consequences state the rule directly: `intensity`/`post_intensity` are plain integers 0-10 with no derived scoring logic anywhere. This is enforced three ways:

1. A database `CHECK` constraint (0-10 inclusive) on both columns (`sql/941`).
2. `domain/practice-session.ts`'s `isValidIntensityValue` is the **only** function in this module that touches either field, and all it does is check the range.
3. `tests/practice-session-no-derived-score.test.ts` greps the module's own source for any sign of a second responsibility (summing, averaging, bucketing into a severity label) growing onto either field — a guard against future drift, not just current correctness.

## Access surface

### Admin (tenant staff, `defineTenantRoute`)

| Route                                             | Permission                    | Notes                                                   |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `GET /api/v1/practice-irm/domains`                | `practice_irm.domains.read`   | Always 5 entries (live row or built-in default).        |
| `POST /api/v1/practice-irm/domains`               | `practice_irm.domains.create` | `409 ALREADY_EXISTS` if a live row exists.              |
| `GET /api/v1/practice-irm/domains/{domainKey}`    | `practice_irm.domains.read`   |                                                         |
| `PUT /api/v1/practice-irm/domains/{domainKey}`    | `practice_irm.domains.update` | `404` if no live row yet.                               |
| `DELETE /api/v1/practice-irm/domains/{domainKey}` | `practice_irm.domains.delete` | Resets to default — a status flip, never a row removal. |

Admin screen: `/admin/practice-irm-domains` (`src/pages/admin/practice-irm-domains.astro`).

**There is deliberately no admin permission, admin route, or admin screen over `awcms_practice_irm_sessions`.** PRD's Major Risks table (§40) names "Journal leakage" as Critical, mitigated by "RLS + ABAC + tests + audit" — the strongest form of that mitigation is that a customer's session content is simply never exposed to a tenant-staff surface in this PR.

### Customer (bearer session, `commerce`'s `customerBearer`)

All under `/api/v1/practice-irm/storefront/account/*`, all requiring `Authorization: Bearer cs_…` and, except where noted, a `productId`:

| Route                                        | Notes                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET .../content?productId=`                 | The five domains' current content.                                                                |
| `GET .../sessions?productId=&cursor=&limit=` | "My sessions" history, keyset-paginated, newest first.                                            |
| `POST .../sessions`                          | Create a new `draft` session (body includes `productId`). Every content field is optional.        |
| `GET .../sessions/{id}?productId=`           | Read one session.                                                                                 |
| `PATCH .../sessions/{id}`                    | Save draft content fields (body includes `productId`). `409 SESSION_COMPLETED` once completed.    |
| `POST .../sessions/{id}/complete`            | `draft -> completed`. `409 INCOMPLETE_FIELDS` unless `situation`/`intensity` are already present. |

Tenant resolution mirrors `newsletter`/`commerce`'s own anonymous-tenant-resolution pattern (`application/public-practice-irm-tenant.ts`, copied from `commerce/application/public-commerce-tenant.ts`): Origin-first for a cross-origin caller, host-first for a same-origin one, every non-resolving/disabled/refused case collapsing to the same neutral outcome.

## Dependencies

`tenant_admin`, `identity_access`, `module_management`, `logging`, `commerce`. The dependency on `commerce` is structural, not a convenience import — both `owner_customer_id` and `product_id` on `awcms_practice_irm_sessions` are foreign keys into `commerce`'s own tables.

## Data lifecycle / subject data

Both tables declare `dataLifecycle` and `subjectData` descriptors in `module.ts`. `awcms_practice_irm_sessions.owner_customer_id` is unreachable by the subject-data engine's tenant_user/identity/profile/principal vocabulary for the same structural reason `commerce.entitlements`/`commerce.customers` are (ADR-0016 D1) — see `module.ts`'s own comments for the full reasoning.

## Known limitations (explicit, not silent)

- **No soft-delete/erasure route for `practice_sessions`.** `deleted_at` exists on the table for schema uniformity, but no code in this PR ever sets it. A future self-service export/delete route — mirroring `commerce`'s own bearer-secured `/account/addresses` routes — is the honest path for a customer to exercise these rights over their own session content; it is out of scope here.
- **No admin visibility into session content**, by design (see "Access surface" above) — an operator cannot look up a customer's sessions from this module at all, even for support purposes.
- **`program-21day`** (ADR-0002's second module) is a separate, not-yet-built module; nothing here references program enrollment or day state.

## Tests

- `tests/practice-irm-domain-content.test.ts` — pure domain: default content merge, domain key validation.
- `tests/practice-session-domain.test.ts` — pure domain: intensity range validation, completion-minimum-fields check.
- `tests/practice-session-no-derived-score.test.ts` — guards against a future derived-score/classification helper being added anywhere touching `intensity`/`postIntensity`.
- `tests/integration/practice-irm-domain-directory.integration.test.ts` — real-database CRUD + reset-to-default + RLS tenant isolation.
- `tests/integration/practice-session-directory.integration.test.ts` — real-database CRUD, entitlement-gate enforcement (403 without entitlement, on every function), the `intensity`/`post_intensity` CHECK constraint (reject out-of-range at the database), immutability of a completed session, and owner/RLS isolation.
