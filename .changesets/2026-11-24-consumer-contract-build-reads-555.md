---
bump: minor
type: structure
impact: internal
---

# Freeze the storefront's build-time reads as a consumer contract

The storefront's build-time reads of the CMS were checked against nothing: a response change arriving in a subtree sync reached `astro build` before anyone saw it (audit F-01). Issue #555 freezes them (ADR-0058 D2, at the repository root, `apps/cms` untouched).

- `tests/fixtures/storefront-consumer-contract.json` freezes the 20 operations the storefront reads while building, per profile (`toko` 20, `berita` 13, `landing` 5), with their transitive schemas. `tests/storefront-consumer-contract.test.mjs` (in the root `bun test`, so `local-ci/check-toko`) checks them against the committed OpenAPI bundle with the additive-superset rule of `api:consumer-contract:check`: the provider may add, never remove or narrow.
- A source scan of `apps/storefront/src` fails when a new build-time read appears that is not in the slice, so the slice cannot drift silently. `GET /theming/{tenantCode}/tokens.css` is named as out of the bundle (audit F-07) with a reason; no schema is invented for it.
- `bun run contract:storefront:check` runs the same checks; `bun run contract:storefront:generate --reason "<why>"` re-freezes deliberately, and the reason belongs in the PR.
- Two differences from `apps/cms`'s script, on purpose: only the consumed methods are frozen, and documentation-only keys are ignored so rewording is not a contract change.
- The format carries `phase: "build"` per operation so issue #556 can add browser calls to the same file.
