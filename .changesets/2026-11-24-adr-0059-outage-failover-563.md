---
bump: patch
type: docs
impact: internal
---

# ADR-0059: third-party outage and failover ownership

Records, as documentation only, what `commerce` does when a third-party provider is down (issue #563). The policy is per operation (read-only shipping quote, e-mail and WhatsApp, payment session and refund, inbound webhooks), automatic cross-provider failover stays off by default, and an unknown financial outcome is settled by reconciliation or a human, never by another provider. Ownership is stated: `commerce` owns the Midtrans and RajaOngkir rules and state, upstream `awcms` owns reusable contracts, tests and metrics (its ADR-0169 defers the integration hub), and derived consumer repositories own their adapters, credentials, acceptance testing and rollout.

- ADR-0059 clarifies ADR-0017 without reversing it; a pointer is added to ADR-0017, the ADR index, `docs/status.md` and `docs/arsitektur.md`, each with its Indonesian mirror.
- No code, migration, OpenAPI path, environment variable, flag or service changes. Follow-up verification is tracked in #564, #565 and #566.
