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
 * The rest of the matrix is NOT registered yet and tests pin that it is not:
 * `booking_reservation_links.{read,create,update,cancel}`,
 * `booking_cancellation_policies.{read,create,approve}`,
 * `booking_refund_decisions.{read,create}` and
 * `booking_refund_overrides.approve`. `cancel` and `approve` are in
 * `HIGH_RISK_ACTIONS` already (a test asserts it), so registering them later
 * classes them correctly with no change to the upstream-owned union.
 *
 * Existing `AccessAction` verbs only.
 */
import type { ModulePermissionDescriptor } from "../../_shared/module-contract";

export const COMMERCE_BOOKING_OFFERING_LINKS_ACTIVITY_CODE =
  "booking_offering_links";
export const COMMERCE_BOOKING_DEPOSIT_POLICIES_ACTIVITY_CODE =
  "booking_deposit_policies";

export const COMMERCE_BOOKING_OFFERING_LINK_PERMISSIONS = {
  read: "commerce.booking_offering_links.read",
  create: "commerce.booking_offering_links.create",
  update: "commerce.booking_offering_links.update"
} as const;

export const COMMERCE_BOOKING_DEPOSIT_POLICY_PERMISSIONS = {
  read: "commerce.booking_deposit_policies.read",
  update: "commerce.booking_deposit_policies.update"
} as const;

/** The keys of the access matrix that no route enforces yet (arrive with #380 onward). */
export const BOOKING_ADAPTER_PENDING_PERMISSIONS = [
  "commerce.booking_reservation_links.read",
  "commerce.booking_reservation_links.create",
  "commerce.booking_reservation_links.update",
  "commerce.booking_reservation_links.cancel",
  "commerce.booking_cancellation_policies.read",
  "commerce.booking_cancellation_policies.create",
  "commerce.booking_cancellation_policies.approve",
  "commerce.booking_refund_decisions.read",
  "commerce.booking_refund_decisions.create",
  "commerce.booking_refund_overrides.approve"
] as const;

/** Mirrors `sql/1039` exactly. */
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
  }
];
