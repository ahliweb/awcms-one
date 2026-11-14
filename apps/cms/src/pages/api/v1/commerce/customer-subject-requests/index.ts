/**
 * `GET /api/v1/commerce/customer-subject-requests` (Issue #529, ADR-0055 D3) -
 * the data-subject requests of the tenant, newest first, at most 100.
 * Optional `status` and `customerId` filters. Needs
 * `commerce.customer_subject_requests.read`. Counts, codes and the retained
 * summary only: never a bundle, a name or a contact.
 */
import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { listSubjectRequests } from "../../../../../modules/commerce/application/customer-subject-requests";
import { COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/customer-subject-permissions";
import {
  SUBJECT_REQUEST_STATUSES,
  type SubjectRequestStatus
} from "../../../../../modules/commerce/domain/customer-subject-policy";
import { isUuid } from "../../../../../modules/commerce/domain/register";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_CUSTOMER_SUBJECT_REQUESTS_ACTIVITY_CODE,
  action: "read"
} as const;

type Filter = { status?: SubjectRequestStatus; customerId?: string };

export const GET = defineTenantRoute<Filter>({
  workClass: "interactive",
  prepare: ({ url }) => {
    const filter: Filter = {};
    const status = url.searchParams.get("status");
    if (status) {
      if (!(SUBJECT_REQUEST_STATUSES as readonly string[]).includes(status)) {
        return fail(400, "VALIDATION_ERROR", "status is not a known status.");
      }
      filter.status = status as SubjectRequestStatus;
    }
    const customerId = url.searchParams.get("customerId");
    if (customerId) {
      if (!isUuid(customerId)) {
        return fail(400, "VALIDATION_ERROR", "customerId must be a UUID.");
      }
      filter.customerId = customerId;
    }
    return filter;
  },
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, prepared }) =>
    ok({ items: await listSubjectRequests(tx, tenantId, prepared) })
});
