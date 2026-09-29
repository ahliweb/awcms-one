---
"awcms": minor
---

feat(commerce): extend PRODUCT_TYPES with digital_ebook/digital_program/mentoring/bundle/event (Issue #266)

`awcms_commerce_products.type` gains five PRD-required kinds (FR-COM-001, IRMbyDUS): `digital_ebook`, `digital_program`, `mentoring`, `bundle`, `event`, additive alongside the existing `physical`/`digital`/`service`/`subscription`. `PRODUCT_TYPES` (`domain/product-type.ts`) and the DB `CHECK` constraint (`sql/935`, dropped and re-created — a `CHECK` cannot be altered in place, same pattern as `sql/934`) both widen; no existing value's meaning changes and no data migration is needed since every existing row's `type` is already one of the original four. The five new kinds are additive-only: none introduces a new field, and each reuses the closest existing analog's already-ungated fields — `digital_ebook`/`digital_program` behave like `digital` (`digitalNote`/`downloadLink`), `mentoring`/`event` behave like `service` (the existing `serviceForm` intake), and `bundle` behaves like `physical` (catalog-visible, shipped/fulfilled normally). The admin product-type filter/label map (`commerce-admin-labels.ts`) and the three `type` enums in `openapi/modules/commerce.openapi.yaml` (create input, update input, response) are updated to match.

**Scope note**: this issue's description also mentions a real digital-delivery linkage (tying a product to protected media/program/mentoring content). That is deliberately OUT of scope for this PR — it belongs to issue #267 (the entitlement module, `awcms_commerce_entitlements`), which depends on this issue but hasn't started. Building it here would duplicate design work already tracked separately and risk merge conflicts with #267's own migration. This PR is the enum/product-type extension only.
