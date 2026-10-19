---
bump: minor
type: content
impact: public
---

# Booking-commerce adapter: cancellation policy, refund quote and confirm, refund override (issue #381, ADR-0045)

Behind the tenant's `booking` feature (**default OFF**; a tenant that never turns it on sees no change). A booking order can now be cancelled with a refund the server computes from the tenant's cancellation policy, and a manager or finance user can set a different figure with a step-up and a recorded reason.

- **Policy versions** (`commerce.booking_cancellation_policies.{read,create,approve}`): a tenant default and a per-product policy, each a list of "at least N hours before arrival refunds P%" windows. A version is a draft until approved, then immutable; an edit is a new draft, and a booking keeps the version in force when it was made. `/admin/commerce-booking-policies` is the screen.
- **Quote and cancel**: `GET .../reservations/{id}/cancellation-quote` and `POST .../reservations/{id}/cancel` (staff), and the two storefront equivalents for the guest. The refund is computed on the server from the original start, the original policy version and the amount actually paid; a guest never sends an amount (a strict schema refuses `final_refund`, `amount` and any extra key). The decision is idempotent (`Idempotency-Key`, namespaced by the actor) and written in ONE transaction with the Booking cancel, the refund legs and the link release.
- **Refund legs** are planned `pending` as a return of the new kind `cancellation` through the existing allocation ledger, so their sum can never exceed what was paid; they are settled on the existing returns and refunds screens with their own permissions. A paid order is not edited or cancelled; an unpaid one is.
- **Override** (`commerce.booking_refund_overrides.approve`, distinct from approving an offline refund): an inline parameter of the staff cancel, behind a fresh step-up and a reason of 10 to 500 characters, capped at the amount paid (`409 REFUND_EXCEEDS_PAID`), with one critical audit event. The order detail gets a booking panel with the cancel button and the override dialog, and a native step-up dialog (never `window.prompt`).
- **Schema** (`sql/1043`, `sql/1044`): the returns kind, reason and disposition widened for `cancellation`; the decision gets `client_key` and `request_hash`; the policy gets author and approver; seven permission keys. New event `awcms.commerce.booking_refund.decided`. `NOT_YET_SCREENED` loses `commerce.booking_reservation_links.read`; the client asset budget is raised with its measurement in the constant's docblock.

Not here: the check-in with an unpaid balance variant (#383), no-show handling and automatic settlement of the legs.
