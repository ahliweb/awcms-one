---
bump: patch
type: docs
impact: internal
---

# Booking-commerce adapter OpenAPI and AsyncAPI contract drafts (DoR artifact 7)

Docs only (ADR-0040 D7): no live OpenAPI path, no AsyncAPI file, no handler, permission or migration, so `ROUTE_PARITY_EXEMPTIONS` stays empty. Resolves issue #358 (stacked on #357).

- New `docs/booking-commerce-adapter-contracts.md` drafts, as fenced OpenAPI 3.1 and AsyncAPI 3.0 YAML marked "draft — not in the live spec", the adapter routes: offering-to-product link, hold-to-order with idempotency, deposit and balance gateway sessions per ADR-0041, a deposit-aware settlement view, cancellation quote and confirm with a server-computed refund, the manager/finance refund override (step-up, `403 STEP_UP_REQUIRED`), reschedule, no-show and POS check-in with balance collection.
- Drafts the events consumed (Booking's provisional reservation events, including the upstream `awcms` ADR-0135 `stays[]` field, plus `order.paid`) with proposed consumer names and idempotency modes, and the events emitted (order settled, refund decided, attention raised).
- Explains how the drafts become live under the contract-first rule, and lists the open points the adapter ADR must settle. The DoR tracker marks artifact 7 as drafted.
