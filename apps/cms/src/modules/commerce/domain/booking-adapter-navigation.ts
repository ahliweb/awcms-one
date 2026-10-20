/**
 * Sidebar entries of the booking-commerce adapter (ADR-0045), declared once here
 * and spread into `module.ts`'s `navigation` array. Each screen issue appends
 * its entry HERE rather than editing `module.ts`. Every entry is hidden the
 * moment the tenant's `booking` feature is off (it defaults OFF).
 *
 * Issue #385 - the offering-link and deposit-policy screens
 * (`docs/booking-ux-flows.md` section 11). Issue #381 adds the
 * cancellation-policy versions screen (11.4); the refund-override dialog (11.5)
 * lives on the order detail, not in the sidebar.
 */
import type { ModuleNavigationEntry } from "../../_shared/module-contract";

export const BOOKING_ADAPTER_NAVIGATION: ModuleNavigationEntry[] = [
  {
    labelKey: "admin.layout.nav_commerce_booking_links",
    path: "/admin/commerce-booking-links",
    order: 29,
    requiredPermission: "commerce.booking_offering_links.read",
    requiredFeature: { moduleKey: "commerce", feature: "booking" }
  },
  {
    labelKey: "admin.layout.nav_commerce_booking_deposits",
    path: "/admin/commerce-booking-deposits",
    order: 30,
    requiredPermission: "commerce.booking_deposit_policies.read",
    requiredFeature: { moduleKey: "commerce", feature: "booking" }
  },
  {
    labelKey: "admin.layout.nav_commerce_booking_policies",
    path: "/admin/commerce-booking-policies",
    order: 31,
    requiredPermission: "commerce.booking_cancellation_policies.read",
    requiredFeature: { moduleKey: "commerce", feature: "booking" }
  }
];
