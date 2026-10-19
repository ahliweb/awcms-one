-- Issue #381 (ADR-0045 D8, D12; access matrix docs/booking-commerce-access-matrix.md
-- sections 3, 6 and 8) - permission catalog seed for the cancellation, refund
-- decision, cancellation-policy and refund-override routes this issue lands,
-- mirroring `src/modules/commerce/domain/booking-adapter-permissions.ts` exactly
-- (see `sql/902`'s header for the reasoning this migration does not repeat:
-- global catalog, idempotent via `ON CONFLICT DO NOTHING`, existing tenants do
-- not retroactively gain these).
--
-- Every key has an ENFORCING ROUTE
-- (`access:permissions:enforcement:check`):
--
--   * `commerce.booking_reservation_links.cancel` - cancel a reservation and
--     record its refund decision (`POST /booking/reservations/{id}/cancel`).
--     HIGH-RISK (`cancel` is in `HIGH_RISK_ACTIONS`), so a tenant may put it
--     under separation-of-duties rules.
--   * `commerce.booking_refund_decisions.create` - record a policy-computed
--     decision; it can NEVER set an amount different from the computed one. The
--     staff cancel needs it IN ADDITION to `.cancel`.
--   * `commerce.booking_refund_decisions.read` - read a decision
--     (`GET /booking/reservations/{id}/refund-decision`).
--   * `commerce.booking_refund_overrides.approve` - the ONLY key that may write
--     `final_refund <> computed_refund` (Q10, control C-40). HIGH-RISK
--     (`approve`), requires a fresh step-up, a reason and an audit event, and
--     never lifts the refund above the amount paid. It is NOT the offline
--     refund approval (`commerce.refunds_offline.approve`, C-11): the two never
--     imply each other.
--   * `commerce.booking_cancellation_policies.read` / `.create` / `.approve` -
--     list the policy versions, author a draft version with its windows, and
--     activate (or retire) a version. Authoring and activating are separate
--     keys so a tenant can require two people; `approve` is HIGH-RISK and the
--     routes require a fresh step-up.
INSERT INTO awcms_permissions (module_key, activity_code, action, description)
VALUES
  ('commerce', 'booking_reservation_links', 'cancel', 'Cancel a Booking reservation and record its refund decision (Issue #381)'),
  ('commerce', 'booking_refund_decisions', 'read', 'Read the refund decision of a cancelled Booking reservation (Issue #381)'),
  ('commerce', 'booking_refund_decisions', 'create', 'Record the policy-computed refund decision when cancelling a Booking reservation; never a different amount (Issue #381)'),
  ('commerce', 'booking_refund_overrides', 'approve', 'Override the policy-computed refund of a cancellation with a fresh step-up, a reason and an audit event, never above the amount paid (Issue #381)'),
  ('commerce', 'booking_cancellation_policies', 'read', 'List the versions of the booking cancellation policies (Issue #381)'),
  ('commerce', 'booking_cancellation_policies', 'create', 'Author a draft version of a booking cancellation policy and its windows (Issue #381)'),
  ('commerce', 'booking_cancellation_policies', 'approve', 'Activate or retire a version of a booking cancellation policy, with a fresh step-up (Issue #381)')
ON CONFLICT (module_key, activity_code, action) DO NOTHING;
