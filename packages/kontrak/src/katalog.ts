/**
 * `ProductType`, `ProductStatus` — imported from `apps/cms`, not
 * hand-copied (issue #6).
 *
 * `apps/storefront/src/lib/catalog.ts` used to declare these two unions by
 * hand, copied verbatim from the commerce module (issue #4 / #5). When
 * `apps/cms` widens `ProductStatus` with a fifth value, a hand-copied union
 * stays green and the storefront silently mis-reads the new value instead of
 * failing to type-check. Re-exporting the TYPE from its source turns that
 * widening into the storefront's own compile error — see the exhaustiveness
 * check in `apps/storefront/src/lib/catalog.ts` (`isPubliclyVisible`) for
 * where that bites.
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
 */
export type { ProductType } from "awcms/src/modules/commerce/domain/product-type";
export type { ProductStatus } from "awcms/src/modules/commerce/domain/product-status";
