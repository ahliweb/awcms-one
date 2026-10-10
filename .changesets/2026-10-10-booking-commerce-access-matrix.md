---
bump: patch
type: docs
impact: internal
---

# Booking-commerce adapter RBAC / ABAC / RLS matrix (DoR artifact 5)

Docs only (ADR-0040 D7): no permission registered, no code, migration or OpenAPI path. Resolves issue #357 (stacked on #356).

- Persona by resource by action matrix for the commerce-side roles that touch bookings (customer, cashier, scheduler / receptionist, tenant admin, finance), with ABAC conditions, step-up, audit events and the RLS shape of each proposed adapter table. Proposed permission keys are marked "proposed (not registered)".
- Owner answer Q10: only a manager or finance permission (`commerce.booking_refund_overrides.approve`, proposed) may override a policy-computed refund, with step-up, a mandatory reason, an audit event, and never above the amount paid; cashier and front desk cannot.
- Records that no commerce route calls the platform step-up today, and that the threat model has no controls beyond C-24.
