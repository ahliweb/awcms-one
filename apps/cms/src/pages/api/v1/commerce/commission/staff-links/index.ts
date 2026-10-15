import {
  created,
  fail,
  ok
} from "../../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../../modules/_shared/tenant-route";
import { readValidatedBody } from "../../../../../../modules/commerce/application/register-http";
import {
  createStaffLink,
  listStaffLinks
} from "../../../../../../modules/commerce/application/commission-attribution-directory";
import { COMMERCE_COMMISSION_STAFF_LINKS_ACTIVITY_CODE } from "../../../../../../modules/commerce/domain/commerce-permissions";
import {
  validateCreateStaffLinkInput,
  type CreateStaffLinkInput
} from "../../../../../../modules/commerce/domain/commission-attribution";

/**
 * `GET|POST /api/v1/commerce/commission/staff-links` (Issue #391, ADR-0046) -
 * which employment earns the commission of which login's counter (POS) sales.
 *
 * `GET` (`commerce.commission_staff_links.read`) lists the tenant's links, newest
 * first (live ones unless `?includeRetired=true`). `POST`
 * (`commerce.commission_staff_links.manage`, high-risk, audited) links a login to
 * an employment id. The employment id is OPAQUE to commerce: it is not read from
 * or checked against `hr_workforce` here - the commission ledger validates it
 * (it exists in the tenant, is live and employed on the sale date) when an
 * accrual is written, and refuses the accrual otherwise. A login has at most one
 * LIVE link and an employment at most one: a second is `409`. The beneficiary of
 * a sale is never a field of the sale; it is derived from this table.
 */
const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_COMMISSION_STAFF_LINKS_ACTIVITY_CODE,
  action: "read"
} as const;

const MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_COMMISSION_STAFF_LINKS_ACTIVITY_CODE,
  action: "manage"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId, url }) =>
    ok({
      items: await listStaffLinks(tx, tenantId, {
        includeRetired: url.searchParams.get("includeRetired") === "true"
      })
    })
});

export const POST = defineTenantRoute<CreateStaffLinkInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCreateStaffLinkInput),
  authorize: MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const outcome = await createStaffLink(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    switch (outcome.kind) {
      case "created":
        return created(outcome.link);
      case "tenant_user_not_found":
        return fail(404, "RESOURCE_NOT_FOUND", "Tenant user not found.");
      case "login_already_linked":
        return fail(
          409,
          "COMMISSION_LOGIN_ALREADY_LINKED",
          "This login already has a live commission link; retire it first."
        );
      case "employment_already_linked":
        return fail(
          409,
          "COMMISSION_EMPLOYMENT_ALREADY_LINKED",
          "This employment is already linked to a login; retire that link first."
        );
    }
  }
});
