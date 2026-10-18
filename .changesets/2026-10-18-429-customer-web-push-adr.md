---
bump: patch
type: docs
impact: internal
---

# ADR-0048 proposes the customer Web Push identity, subscription model and cross-origin contract (issue #429)

Docs only. Nothing is built: no migration, table, route, consumer, job, service worker or UI changes. Implementation stays blocked until the owner accepts the ADR.

- [ADR-0048](../docs/adr/0048-customer-web-push-identity-subscription-and-cross-origin-contract.md) (Proposed, with its Indonesian mirror) is the Definition of Ready for #430, #431 and #432. It compares the three options of #429 and recommends commerce-owned customer devices, consent and a thin outbox that imports the upstream provider, crypto and retry code and writes none of upstream's tables.
- It fixes the principal (derived from the `cs_` bearer only), the device binding (account, enrolling session, validated storefront origin), shared-browser transfer and logout semantics, storefront-origin click targets, CORS/CSP/CSRF/rate-limit posture, the ERD and data dictionary for four additive commerce tables, the RLS and authorization matrix, the `GET/POST/DELETE` contract, a threat table, a test matrix with four proof obligations, rollout and recovery, and a regulatory mapping.
- Six commerce events were verified in code as notification sources; the customer-inbox reply has no event today and is a conditional seventh.
- Twelve open questions and five proposed upstream issues are listed for the owner; none was filed.
- The ADR index and `docs/status.md` (and their mirrors) point to it.
