---
bump: patch
type: docs
impact: public
---

# Commerce OpenAPI declares the payment-proof and saved-address request bodies (#571)

`apps/cms/openapi/modules/commerce.openapi.yaml` now declares a `requestBody` on `POST .../orders/{orderCode}/payment-proof/upload-sessions` and its `finalize` operation (the shape the storefront client sends; optional, because both handlers answer `503 MEDIA_UNAVAILABLE` today and read no body), and a real `CommerceAccountAddressRequest` schema on `POST .../account/addresses`, derived from `validateAccountAddressInput` (required `label` and `postalCode`, the length bounds the validator enforces). The bundle and the API reference are regenerated. No runtime change.
