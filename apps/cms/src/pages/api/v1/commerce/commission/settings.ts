import { ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { readValidatedBody } from "../../../../../modules/commerce/application/register-http";
import {
  fetchCommissionSettings,
  saveCommissionSettings
} from "../../../../../modules/commerce/application/commission-attribution-directory";
import {
  validateCommissionSettingsInput,
  type CommissionSettingsInput
} from "../../../../../modules/commerce/domain/commission-attribution";

/**
 * `GET|PUT /api/v1/commerce/commission/settings` (Issue #391, ADR-0046) - whether
 * employee-commission sale attribution is on for the tenant, which
 * `hr_commission` rule key it applies and the source type that rule declares.
 * OFF until a tenant `PUT`s `enabled: true` with a rule key; `GET` answers the
 * defaults (`enabled: false`, no rule) for a tenant that has never saved.
 *
 * Reading needs `commerce.commission_settings.read`; changing needs
 * `commerce.commission_settings.manage` (a high-risk action: it decides whether
 * staff are paid commission). The change is audited with the old and new
 * values. `PUT` is an upsert, so replaying it is harmless. It takes effect for
 * orders paid afterwards; a sale already reported keeps the identity it was
 * reported under.
 */
const COMMISSION_SETTINGS_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: "commission_settings",
  action: "read"
} as const;

const COMMISSION_SETTINGS_MANAGE_GUARD = {
  moduleKey: "commerce",
  activityCode: "commission_settings",
  action: "manage"
} as const;

export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: COMMISSION_SETTINGS_READ_GUARD,
  handler: async ({ tx, tenantId }) =>
    ok({ settings: await fetchCommissionSettings(tx, tenantId) })
});

export const PUT = defineTenantRoute<CommissionSettingsInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCommissionSettingsInput),
  authorize: COMMISSION_SETTINGS_MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) =>
    ok({
      settings: await saveCommissionSettings(
        tx,
        tenantId,
        auth.context.tenantUserId,
        prepared,
        locals.correlationId
      )
    })
});
