/**
 * Presentation labels for the booking cancellation screens (Issue #381,
 * `docs/booking-ux-flows.md` sections 11.4 and 11.5): every status, policy
 * source and reason a screen renders goes through one of these maps, never as
 * raw snake_case text. Each map is `satisfies Record<TheUnion, string>`, so a
 * value added to its union without a label is a compile error. The literal
 * `t(...)` calls are harvested by `i18n:catalog:check` like any template's.
 *
 * A separate module from `commerce-admin-labels.ts` on purpose: that file's
 * map count is pinned by `commerce-admin-labels.test.ts`, and these maps belong
 * to the booking adapter, which is behind its own feature.
 */
import type { RefundPolicySource } from "../../modules/commerce/domain/booking-adapter";

type Translate = (
  msgid: string,
  params?: Record<string, string | number>
) => string;

/** Booking's reservation statuses (`booking/domain/booking-reservation-state.ts`). */
export type BookingReservationStatus =
  | "held"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled"
  | "expired"
  | "no_show"
  | "rescheduled";

/** Reason codes of the reschedule and no-show controls live beside their client helpers (`commerce-booking-reschedule-client.ts`). */
import {
  NO_SHOW_REASON_CODES,
  RESCHEDULE_REASON_CODES,
  type NoShowReasonCode,
  type RescheduleReasonCode
} from "./commerce-booking-reschedule-client";

/** The closed reason codes the staff cancel offers (the server accepts any short lowercase code). */
export const STAFF_CANCEL_REASON_CODES = [
  "guest_request",
  "property_closed",
  "duplicate_booking",
  "payment_problem",
  "other"
] as const;
export type StaffCancelReasonCode = (typeof STAFF_CANCEL_REASON_CODES)[number];

export function createBookingCancellationLabels(t: Translate) {
  const reservationStatus = {
    held: t("Held"),
    confirmed: t("Confirmed"),
    checked_in: t("Checked in"),
    completed: t("Completed"),
    cancelled: t("Cancelled"),
    expired: t("Expired"),
    no_show: t("No-show"),
    rescheduled: t("Rescheduled")
  } satisfies Record<BookingReservationStatus, string>;

  const policySource = {
    product: t("This product's policy"),
    tenant_default: t("The store's default policy"),
    none: t("No policy applied")
  } satisfies Record<RefundPolicySource, string>;

  const policyStatus = {
    draft: t("Draft"),
    active: t("Active"),
    retired: t("Retired")
  } satisfies Record<"draft" | "active" | "retired", string>;

  const refundBasis = {
    whole_stay: t("Whole stay"),
    per_night: t("Per night")
  } satisfies Record<"whole_stay" | "per_night", string>;

  const noShowRetention = {
    retain_deposit: t("Keep the deposit"),
    retain_all: t("Keep everything paid"),
    refund_per_windows: t("Refund by the windows")
  } satisfies Record<
    "retain_deposit" | "retain_all" | "refund_per_windows",
    string
  >;

  const cancelReason = {
    guest_request: t("The guest asked to cancel"),
    property_closed: t("The property is closed"),
    duplicate_booking: t("Duplicate booking"),
    payment_problem: t("Payment problem"),
    other: t("Another reason")
  } satisfies Record<StaffCancelReasonCode, string>;

  const noQuote = {
    already_decided: t("This reservation was already cancelled and refunded."),
    released: t("This reservation is already released."),
    completed: t("This reservation is complete and cannot be cancelled."),
    checked_in: t(
      "The guest has checked in; this reservation cannot be cancelled."
    ),
    no_show: t("This reservation was marked no-show and cannot be cancelled."),
    rescheduled: t("This reservation was rescheduled; cancel the new one."),
    cancelled: t("Booking already cancelled this reservation."),
    expired: t("This reservation expired.")
  } satisfies Record<string, string>;

  return {
    reservationStatus,
    policySource,
    policyStatus,
    refundBasis,
    noShowRetention,
    cancelReason,
    noQuote
  };
}

/**
 * Labels of the reschedule and no-show controls (Issue #382,
 * `docs/booking-ux-flows.md` section 11.6), kept apart from the cancellation maps
 * so the cancellation screens render exactly as before.
 */
export function createBookingChangeLabels(t: Translate) {
  const rescheduleReason = {
    guest_request: t("The guest asked to move"),
    property_request: t("The property needs to move it"),
    double_booking: t("Double booking"),
    other: t("Another reason")
  } satisfies Record<RescheduleReasonCode, string>;

  const noShowReason = {
    guest_did_not_arrive: t("The guest did not arrive"),
    guest_unreachable: t("The guest cannot be reached"),
    other: t("Another reason")
  } satisfies Record<NoShowReasonCode, string>;

  const direction = {
    none: t("Same length"),
    charge: t("Longer stay"),
    refund: t("Shorter stay")
  } satisfies Record<"none" | "charge" | "refund", string>;

  return { rescheduleReason, noShowReason, direction };
}

export { NO_SHOW_REASON_CODES, RESCHEDULE_REASON_CODES };

export type BookingCancellationLabels = ReturnType<
  typeof createBookingCancellationLabels
>;

/** Looks a raw value up in a label map, falling back to the raw text (never throws). */
export function bookingLabel(
  map: Record<string, string>,
  raw: string | null | undefined
): string {
  if (raw === null || raw === undefined) return "";
  return map[raw] ?? raw;
}
