/**
 * Permission keys of customer Web Push (Issue #430, ADR-0048 Q10), declared once
 * here and spread into `module.ts`'s `permissions` array.
 *
 * ONE key, `commerce.customer_push.read`: aggregate counts by status and purpose
 * for the staff diagnostics route
 * (`GET /api/v1/commerce/customer-push/diagnostics`). There is no staff
 * `create`/`update`/`delete`: a customer device is enrolled and revoked only by
 * the customer who holds it (self-service by construction, ADR-0048 section 4),
 * and "no permission with nothing to enforce it" is a gate failure
 * (`access:permissions:enforcement:check`). Mirrors `sql/1059` exactly.
 *
 * The customer routes themselves have NO permission: the subject is the bearer's
 * own account, so there is no id to compare and nothing to authorise beyond
 * `requireCustomerSession`.
 */
import type { ModulePermissionDescriptor } from "../../_shared/module-contract";

export const COMMERCE_CUSTOMER_PUSH_ACTIVITY_CODE = "customer_push";

export const COMMERCE_CUSTOMER_PUSH_PERMISSIONS = {
  read: "commerce.customer_push.read"
} as const;

export const CUSTOMER_PUSH_PERMISSIONS: ModulePermissionDescriptor[] = [
  {
    activityCode: COMMERCE_CUSTOMER_PUSH_ACTIVITY_CODE,
    action: "read",
    description:
      "Read aggregate customer Web Push diagnostics: counts by status and purpose, no device or customer identifiers (Issue #430)"
  }
];
