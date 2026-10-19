---
bump: minor
type: content
impact: public
---

# Booking-commerce adapter: admin screens for offering links and deposit policies (issue #385, ADR-0045)

The adapter gets its first admin screens, all behind the tenant's `booking` feature (**default OFF**; a tenant that never turns it on sees no new sidebar entry and no change). The UX spec (states, Indonesian and English copy, WCAG 2.1 AA, 360px) is `docs/booking-ux-flows.md` section 11, written first as DoR residual R2 asked.

- **`/admin/commerce-booking-links`**: list, create and unlink the links between Booking offerings and service products (`commerce.booking_offering_links.{read,create,update}`); each server refusal has its own message, the unlink goes through the shared confirm dialog, and a link created for a product with no cancellation policy shows a non-blocking notice.
- **`/admin/commerce-booking-deposits`**: a service product's deposit as full payment, a percent or a fixed amount per unit (`commerce.booking_deposit_policies.{read,update}`). The screen sends the policy, never an amount.
- **Commerce settings**: a "Booking service account (user ID)" field, shown only while `booking` is on.
- **Sidebar**: two entries with `requiredFeature`; `NOT_YET_SCREENED` loses the five matching permissions; the client asset budget is raised with its measurement in the constant's docblock.

Not here, specified in section 11 and waiting for their APIs in #381: the cancellation-policy versions screen and the refund-override dialog (which cannot submit above the amount paid; the server enforces the same bound).
