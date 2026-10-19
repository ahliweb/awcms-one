/**
 * Permission keys of the booking-commerce adapter (Issue #378, ADR-0045; access
 * matrix `docs/booking-commerce-access-matrix.md` section 3), declared once here
 * and spread into `module.ts`'s `permissions` array. A later adapter issue
 * (#380 and on) appends to THIS file, never to `module.ts`.
 *
 * ## Only keys with an enforcing route are registered
 *
 * `access:permissions:enforcement:check` fails on a permission no route
 * enforces. This issue lands the offering-link routes and the product
 * deposit-policy routes, so exactly those keys exist:
 *
 *   - `booking_offering_links`: `read`, `create`, `update` (an unlink is a
 *     status change; there is no `delete`).
 *   - `booking_deposit_policies`: `read`, `update` (one key writes a product's
 *     single policy; removing it is `update` to full payment, no `delete`).
 *
 * Issue #381 lands the cancellation routes and registers the seven keys they
 * enforce (`sql/1044`):
 *
 *   - `booking_reservation_links.cancel` (high-risk): cancel a reservation.
 *   - `booking_refund_decisions.{read,create}`: read a decision; record the
 *     policy-computed one (it can never set a different amount).
 *   - `booking_refund_overrides.approve` (high-risk): the ONLY key that may
 *     write `final_refund <> computed_refund`; distinct from the offline refund
 *     approval, and enforced together with a fresh step-up.
 *   - `booking_cancellation_policies.{read,create,approve}`: list versions,
 *     author a draft, activate or retire a version (`approve` is high-risk).
 *
 * The rest of the matrix is NOT registered yet and tests pin that it is not:
 * `booking_reservation_links.update` (reschedule, #382). `cancel` and
 * `approve` are in `HIGH_RISK_ACTIONS` already (a test asserts it), so
 * registering them classes them correctly with no change to the upstream-owned
 * union.
 *
 * Existing `AccessAction` verbs only.
 */
import type { ModulePermissionDescriptor } from "../../_shared/module-contract";

export const COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE =
  "booking_offering_links";
export const COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE =
  "booking_deposit_policies";
/** Issue #380 - hold-to-order (`create`) and the reservation/reconciliation reads (`read`). */
export const COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE =
  "booking_reservation_links";
/** Issue #381 - the cancellation policy versions (`read`, `create`, `approve`). */
export const COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE =
  "booking_cancellation_policies";
/** Issue #381 - a decision's read and its policy-computed record (`read`, `create`). */
export const COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE =
  "booking_refund_decisions";
/** Issue #381 - the manager / finance override of a computed refund (`approve`). */
export const COMMERCE_BOOKING_REFUND_OVERRIDES_ACTIVITY_CODE =
  "booking_refund_overrides";

export const COMMERCE_BOOKING_OFFERING_LINK_PERMISSIONS = {
  read: "commerce.booking_offering_links.read",
  create: "commerce.booking_offering_links.create",
  update: "commerce.booking_offering_links.update"
} as const;

export const COMMERCE_BOOKING_DEPOSIT_POLICY_PERMISSIONS = {
  read: "commerce.booking_deposit_policies.read",
  update: "commerce.booking_deposit_policies.update"
} as const;

export const COMMERCE_BOOKING_RESERVATION_LINK_PERMISSIONS = {
  read: "commerce.booking_reservation_links.read",
  create: "commerce.booking_reservation_links.create",
  cancel: "commerce.booking_reservation_links.cancel"
} as const;

export const COMMERCE_BOOKING_CANCELLATION_POLICY_PERMISSIONS = {
  read: "commerce.booking_cancellation_policies.read",
  create: "commerce.booking_cancellation_policies.create",
  approve: "commerce.booking_cancellation_policies.approve"
} as const;

export const COMMERCE_BOOKING_REFUND_DECISION_PERMISSIONS = {
  read: "commerce.booking_refund_decisions.read",
  create: "commerce.booking_refund_decisions.create"
} as const;

export const COMMERCE_BOOKING_REFUND_OVERRIDE_PERMISSIONS = {
  approve: "commerce.booking_refund_overrides.approve"
} as const;

/** The keys of the access matrix that no route enforces yet (arrive with #382 onward). */
export const BOOKING_ADAPTER_PENDING_PERMISSIONS = [
  "commerce.booking_reservation_links.update"
] as const;

/** Mirrors `sql/1039`, `sql/1041` and `sql/1044` exactly. */
export const BOOKING_ADAPTER_PERMISSIONS: ModulePermissionDescriptor[] = [
  {
    activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
    action: "read",
    description:
      "List and read the links between Booking offerings and service products (Issue #378)"
  },
  {
    activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
    action: "create",
    description: "Link a Booking offering to a service product (Issue #378)"
  },
  {
    activityCode: COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE,
    action: "update",
    description: "Unlink a Booking offering from a service product (Issue #378)"
  },
  {
    activityCode: COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE,
    action: "read",
    description: "Read a product's deposit policy (Issue #378)"
  },
  {
    activityCode: COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE,
    action: "update",
    description: "Set or remove a product's deposit policy (Issue #378)"
  },
  {
    activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
    action: "read",
    description:
      "Read a booking reservation's link, order and settlement, and the booking reconciliation (Issue #380)"
  },
  {
    activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
    action: "create",
    description:
      "Hold a Booking slot or stay and create the commerce order from it (Issue #380)"
  },
  {
    activityCode: COMMERCE_BOOKING_RESERVATION_LINKS_ACTIVITY_CODE,
    action: "cancel",
    description:
      "Cancel a Booking reservation and record its refund decision (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
    action: "read",
    description:
      "Read the refund decision of a cancelled Booking reservation (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_REFUND_DECISIONS_ACTIVITY_CODE,
    action: "create",
    description:
      "Record the policy-computed refund decision when cancelling a Booking reservation; never a different amount (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_REFUND_OVERRIDES_ACTIVITY_CODE,
    action: "approve",
    description:
      "Override the policy-computed refund of a cancellation with a fresh step-up, a reason and an audit event, never above the amount paid (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
    action: "read",
    description:
      "List the versions of the booking cancellation policies (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
    action: "create",
    description:
      "Author a draft version of a booking cancellation policy and its windows (Issue #381)"
  },
  {
    activityCode: COMMERCE_BOOKING_CANCELLATION_POLICIES_ACTIVITY_CODE,
    action: "approve",
    description:
      "Activate or retire a version of a booking cancellation policy, with a fresh step-up (Issue #381)"
  }
];
