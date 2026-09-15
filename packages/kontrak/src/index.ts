/**
 * `@awcms-one/kontrak` — the type-only DTO contract `apps/storefront` needs
 * from `apps/cms`, IMPORTED from its source, not hand-copied (issue #6).
 *
 * ## Import direction: one way, guarded
 *
 * `storefront -> kontrak -> cms`, never the reverse. `apps/cms` is upstream
 * code vendored whole via `git subtree` (this repo's `AGENTS.md`, "The
 * subtree embed") — a dependency pointing BACK at this repository's own code
 * would turn every future `git subtree pull` into a merge conflict against
 * code upstream has never heard of. The gate that keeps this true:
 * `tests/kontrak-arah-impor.test.mjs`.
 *
 * ## Why `export type`, never a value
 *
 * Every export in this package — and in every `src/*.ts` file folded in
 * here — is `export type`. Not one runtime value comes along. This is not a
 * style choice, it is the CONTRACT: `apps/storefront` is a static public
 * site (issue #5) that must never carry `apps/cms` code into a client
 * bundle. An `export const`/`export function` here would type-check exactly
 * as well and still be a defect — do not add one, not even for validation
 * that feels useful.
 *
 * ## Scope
 *
 * Only the DTOs `apps/storefront` actually consumes today, and only from
 * `apps/cms/src/modules/**\/domain/*.ts` — the layer `apps/cms`'s own
 * convention keeps pure: no database, no I/O (see each source file's own
 * docblock). `application/` and above may carry I/O-bearing imports on other
 * lines of the same file — `import type` does not execute them, but `tsc`
 * still parses the whole file to build its type graph, so this package
 * deliberately does not reach that layer. See `src/katalog.ts`'s docblock
 * for the DTOs that were considered and NOT imported for this reason
 * (`CommerceProduct`/`CommerceCategory`, and the `{ items, nextCursor }`
 * page envelope).
 */
export type { ProductType, ProductStatus } from "./katalog";
