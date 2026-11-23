---
bump: patch
type: fix
impact: internal
---

# Storefront fixtures and types follow the OpenAPI schema (F-03 to F-05)

Issue #554, after the gate of #553. The stub fixtures and storefront types no longer claim what the provider does not send: `downloadLink` is gone from the products fixture and from `CommerceProduct`; `store-settings-public.json` gains `payment.tax.mode` and loses `shipping.courier` (the live route sends only `courierEnabled`, so the `courier?` type member goes too and the stub quotes every courier it has rates for); the regions fixture uses `regionType: "regency"`, which is what the provider emits for a city; `media-objects.json` uses `copyrightStatus: "owned"`.

The exceptions F-03, F-04, F-05 and N-01 are deleted from the gate's map. N-02 (`videoNews` fields `title`, `caption`, `durationSeconds`, `sourceLabel`) stays as the one exception: the provider emits and the storefront renders them, so it is an upstream spec gap to be reported to `ahliweb/awcms`, not a fixture defect.
