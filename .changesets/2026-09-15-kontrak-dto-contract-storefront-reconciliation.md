---
bump: minor
type: structure
impact: public
---

# packages/kontrak: the type-only DTO contract, and the storefront reconciled to the real envelope

Adds the fifth workspace member, `@awcms-one/kontrak` (issue #6): `ProductType`/`ProductStatus` re-exported, `export type` only, from `apps/cms`'s commerce domain layer (`apps/cms/src/modules/commerce/domain/{product-type,product-status}.ts`) — never hand-copied again. `tests/kontrak-arah-impor.test.mjs` guards the one-way import direction (`storefront -> kontrak -> cms`) that keeps `apps/cms`'s `git subtree pull` safe: a dependency pointing back at this repo's own code would turn every future sync into a merge conflict against code upstream never wrote.

Reconciles `apps/storefront/src/lib/catalog.ts` against the real commerce API that landed with issue #4, closing four mismatches a side-by-side review of the two merged PRs surfaced:

- Both list responses are read as `{ items, nextCursor }` — the awcms house keyset-page shape — not the invented `{ products }` / `{ categories }` this app shipped with, which would have crashed the build on `undefined`.
- Categories are now keyset-paginated with the same cursor walk products already use, not fetched as a single unpaginated page.
- `status` and `limit` are no longer sent as query parameters — the CMS route accepts only `cursor` and fixes the page size server-side; sending parameters it silently ignores was a lie in the request log.
- `getProducts()` now filters with an exhaustive `switch` (`isPubliclyVisible`) instead of a bare `status === "active"` comparison, so a `ProductStatus` `apps/cms` adds later cannot silently fall through — verified by hand: widening the union in a worktree turned `bun run check` red at that exact line (the captured error is in this change's pull request description).

`CommerceProduct`/`CommerceCategory` — the row DTO shapes — stay declared locally in `catalog.ts` rather than moving into `@awcms-one/kontrak`: they live in `apps/cms/src/modules/commerce/application/{product,category}-directory.ts`, not `domain/`, so they are out of that package's scope by its own rule (`application/` may carry I/O-bearing imports on other lines of the same file).

Fixtures (`apps/storefront/tests/fixtures/awcms/*.json`) and `apps/storefront/scripts/stub-awcms.mjs` now emit the real envelope too, so the offline build proof against the stub is honest rather than agreeing with the bug it used to ship with.
