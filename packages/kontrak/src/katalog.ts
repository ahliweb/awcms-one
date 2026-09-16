/**
 * `ProductType`, `ProductStatus` — imported from `apps/cms`, not
 * hand-copied (issue #6). Issue #23 (catalog-parity) adds four more:
 * `SizeChartType`, `SubscriptionPeriod`, `ServiceFormFieldType`,
 * `ProductSort` — every one of them a plain string union `apps/cms`'s
 * `domain/*.ts` owns, re-exported here for the identical reason.
 *
 * `apps/storefront/src/lib/catalog.ts` used to declare these unions by
 * hand, copied verbatim from the commerce module. When `apps/cms` widens one
 * of them with a new value, a hand-copied union stays green and the
 * storefront silently mis-reads the new value instead of failing to
 * type-check. Re-exporting the TYPE from its source turns that widening into
 * the storefront's own compile error — see the exhaustiveness check in
 * `apps/storefront/src/lib/catalog.ts` (`isPubliclyVisible`) for where that
 * bites `ProductStatus` already.
 *
 * `export type` only, no value: the storefront is a static public site that
 * must never carry `apps/cms` code into a client bundle. See this package's
 * `src/index.ts` docblock for the full reasoning.
 *
 * ## What is NOT re-exported here, and why
 *
 * `CommerceProduct`/`CommerceCategory` — the row DTO shapes — are declared
 * as `ProductRecord` in
 * `apps/cms/src/modules/commerce/application/product-directory.ts` and as
 * `CategoryRecord` in `.../application/category-directory.ts`, not in
 * `domain/`. `application/` carries I/O-bearing imports on other lines of
 * those same files (`Bun.SQL`, audit logging, domain events) — `import type`
 * does not execute them, but `tsc` still parses the whole file to build its
 * type graph, so this package deliberately does not reach that layer (see
 * `src/index.ts`'s scope note). `apps/storefront/src/lib/catalog.ts` keeps
 * its own local, structural declaration of `CommerceProduct`/
 * `CommerceCategory` instead, with a comment naming this decision. The same
 * reasoning keeps the `{ items, nextCursor }` page envelope
 * (`apps/cms/src/modules/_shared/keyset-pagination.ts` and the `ok({...})`
 * shape the routes return) out of this package too — `_shared/` is not
 * `domain/` either, so the storefront declares that shape locally as well.
 * `ServiceFormField`/`VariantAttributeGroup` (the STRUCTURED per-field/
 * per-group shapes, as opposed to `ServiceFormFieldType`'s plain union) stay
 * out — Issue #23 names exactly the four unions re-exported below, not the
 * structured shapes around them, and the storefront has not needed either
 * one yet. Both are still pure `domain/*.ts` types, so re-exporting them
 * later is a one-line addition, not a new exception to this file's rules.
 */
export type { ProductType } from "awcms/src/modules/commerce/domain/product-type";
export type { ProductStatus } from "awcms/src/modules/commerce/domain/product-status";
export type { SizeChartType } from "awcms/src/modules/commerce/domain/size-chart";
export type { SubscriptionPeriod } from "awcms/src/modules/commerce/domain/subscription-period";
export type { ServiceFormFieldType } from "awcms/src/modules/commerce/domain/service-form-validation";
export type { ProductSort } from "awcms/src/modules/commerce/domain/product-sort";
