---
bump: minor
type: structure
impact: internal
---

# Gate: storefront stub fixtures are judged against the OpenAPI response schemas

Issue #553 (audit finding F-02, ADR-0058). Every file under `apps/storefront/tests/fixtures/awcms` is now validated against the matching response schema of the committed OpenAPI bundle (`apps/cms/openapi/`, read only) by `tests/fixture-skema-openapi.test.mjs`, which the root `bun test` of `local-ci/check-toko` runs. No database, no network, no build.

- An explicit reviewed map (`tests/support/fixture-skema-mapa.mjs`) names the operation of each fixture; an unmapped fixture, or a mapped operation missing from the bundle, fails. Subset fixtures name the required fields they omit and why; lookup tables are judged as the responses the stub builds from them; stub configuration and the raw CSS file are listed as not-a-response with a reason.
- An undeclared property is an error (the schemas rarely close their objects, so the gate closes them with `unevaluatedProperties`).
- Known violations stay green only as dated, reasoned exceptions that point at #554 (F-03 to F-05) and fail once they match nothing or pass their review date (15 December 2026). The first run also found two violations the audit did not list: `own_work` in `media-objects.json` and four `videoNews` fields the spec does not declare in `blog-posts.json`; both are recorded as exceptions N-01 and N-02 for the owner to triage.
- New root `devDependency`: `ajv@^8.20.0` (already in `bun.lock` transitively; `ajv/dist/2020` for the OpenAPI 3.1 bundle). The YAML bundle is parsed with Bun's built-in `Bun.YAML.parse`, so no YAML package is added.
