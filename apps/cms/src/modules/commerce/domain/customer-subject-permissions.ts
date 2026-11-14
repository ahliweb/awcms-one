/**
 * Permission keys of the admin side of a shopper's data-subject requests
 * (Issue #529, ADR-0055 D3), declared once here and spread into `module.ts`'s
 * `permissions` array. Mirrors `sql/1067` exactly.
 *
 * One activity code, four keys, all on EXISTING `AccessAction` verbs (a new
 * `erase` verb would widen a shared union that upstream owns):
 *
 * - `read`: list the requests (status, refusal code, counts - never a bundle).
 * - `export` (high-risk): produce one customer's export bundle on their behalf.
 * - `delete` (high-risk): REQUEST an erasure; creates a pending request after
 *   the precondition check and erases nothing, needs a fresh step-up.
 * - `approve` (high-risk): decide a pending erasure as the second person, fresh
 *   step-up, never the requester.
 *
 * The shopper's own storefront routes carry NO permission: the subject is the
 * bearer's own account (plus a fresh OTP), so there is no id to compare.
 */
import type { ModulePermissionDescriptor } from "../../_shared/module-contract";

export const COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE =
  "customer_subject_requests";

export const COMMERCE_CUSTOMER_SUBJECT_REQUEST_PERMISSIONS = {
  read: "commerce.customer_subject_requests.read",
  export: "commerce.customer_subject_requests.export",
  delete: "commerce.customer_subject_requests.delete",
  approve: "commerce.customer_subject_requests.approve"
} as const;

export const CUSTOMER_SUBJECT_PERMISSIONS: ModulePermissionDescriptor[] = [
  {
    activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
    action: "read",
    description:
      "List shopper data-subject requests (export and erasure): status, refusal code and counts, never a bundle (Issue #529)"
  },
  {
    activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
    action: "export",
    description:
      "Produce one shopper's data-subject export bundle on their behalf; every disclosure is audited (Issue #529)"
  },
  {
    activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
    action: "delete",
    description:
      "Request the erasure of one shopper's personal data (anonymise and delete, ledgers retained); creates a request that a second person approves (Issue #529)"
  },
  {
    activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
    action: "approve",
    description:
      "Approve or reject a pending shopper erasure request as the second person, with a fresh step-up; never the requester (Issue #529)"
  }
];
