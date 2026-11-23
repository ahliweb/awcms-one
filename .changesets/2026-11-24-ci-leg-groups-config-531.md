---
bump: minor
type: structure
impact: internal
---

# A derived product disables CI leg groups through one config file

`tools/ci/legs.ts` kept one fixed table, so a repository derived from the template that did not run a group (for example the `template-*` legs, meaningless once initialised) had to edit the table itself and conflict at every template sync, with nothing pinning the set of posted contexts against its branch protection.

- The inherited table is now `TEMPLATE_LEGS`; `LEGS` is that table minus the groups listed in the new `tools/ci/derived-product.ts` (`DISABLED_LEG_GROUPS`, empty in the template, so `LEGS` and `LEG_CONTEXTS` are unchanged there). An unknown group name throws.
- A disabled leg is absent from `bun run ci` and `ci:pr`, and `--leg <context>` or a `ci:*` shortcut for it stops with `Unknown leg context`.
- `tests/local-ci-legs.test.mjs` pins the template's exact contexts and a filtered configuration.
- Documented in `docs/template.md` and `docs/alur-kerja-pengembangan.md`.
