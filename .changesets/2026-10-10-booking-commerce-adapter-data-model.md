---
bump: patch
type: docs
impact: internal
---

# Booking-commerce adapter: proposed ERD and data dictionary

Docs only (ADR-0040 D7): no migration, table, route or OpenAPI path. Resolves issue #356, DoR artifact 4 for the booking-commerce adapter and cross-spec finding X7.

- New `docs/booking-commerce-adapter-data-model.md` proposes six `awcms_commerce_*` tables with an ERD and column-level dictionary: offering-to-product link, reservation-to-order link, per-product deposit policy, versioned cancellation policy with its windows (product row or tenant default), and an append-only refund decision record carrying the manager/finance override fields. Migration numbers are left to implementation from `sql/1001` (ADR-0037).
- The customer of a reservation is derived through the linked order and stored on no adapter table; Booking holds no price, deposit or payment field.
- Reflects the owner answers of 10 October 2026 (Q1 to Q4, Q8 to Q10) and ADR-0041. Pointers added to the schema and data-dictionary pages; the DoR tracker marks artifact 4 as partly satisfied.
