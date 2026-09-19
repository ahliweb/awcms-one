---
source_file: "apps/storefront/scripts/stub-awcms.mjs"
type: "code"
community: "Stub CMS State Machine"
location: "L833"
tags:
  - graphify/code
  - graphify/EXTRACTED
  - community/Stub_CMS_State_Machine
---

# handleAccountRequest()

## Connections
- [[ACCOUNTS]] - `references` [EXTRACTED]
- [[ORDERS]] - `references` [EXTRACTED]
- [[OTPS]] - `references` [EXTRACTED]
- [[SESSIONS]] - `references` [EXTRACTED]
- [[deterministicAffiliateCode()]] - `calls` [EXTRACTED]
- [[envelope()]] - `calls` [EXTRACTED]
- [[envelopeError()]] - `calls` [EXTRACTED]
- [[findAccountByBearer()]] - `calls` [EXTRACTED]
- [[handleStorefrontRequest()]] - `calls` [EXTRACTED]
- [[issueSession()]] - `calls` [EXTRACTED]
- [[normalizeEmail()]] - `calls` [EXTRACTED]
- [[productCatalog()]] - `calls` [EXTRACTED]
- [[serializeAccount()]] - `calls` [EXTRACTED]
- [[serializeAffiliate()]] - `calls` [EXTRACTED]
- [[serializeOrder()]] - `indirect_call` [INFERRED]
- [[storeSettings()]] - `calls` [EXTRACTED]
- [[stub-awcms.mjs]] - `contains` [EXTRACTED]

#graphify/code #graphify/EXTRACTED #community/Stub_CMS_State_Machine