---
bump: patch
type: docs
impact: internal
---

# ADR-0048 accepted: customer Web Push design, Q1 to Q12 answered

Docs only: no code, migration, OpenAPI path or flag change. The owner adopted the recommended answer to every open question of ADR-0048, so the status moves from Proposed to Accepted and the design questions that blocked #430, #431 and #432 are closed.

- Decided: option C (a thin `commerce` outbox beside the upstream provider and crypto, no upstream table written); one auth-secret key ring with a customer-specific AAD purpose; customer push unsupported when storefront and CMS share an origin; push-service host allowlist with an operator-only override; initial limits of 5 devices and 12 per hour and 40 per day per account; built-in generic text only; aggregate-only diagnostics behind `commerce.customer_push.read`; marketing push and click tracking out of v1.
- Decided with a gate: the 30-day retention windows are accepted, and the consent and privacy wording ships as a versioned draft. Counsel's review of that wording is a production-activation gate for the `customerPush` flag (ADR-0048 D8), not a gate for building #430 to #432.
- Added ISO/IEC 27034 (application security) to the regulatory mapping. English and Indonesian ADR texts and the ADR index are updated together.
- #430 to #432 are still gated on #427 (the subtree sync); nothing is implemented.
