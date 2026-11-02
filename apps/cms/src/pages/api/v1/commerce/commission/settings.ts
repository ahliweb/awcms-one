import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import { readValidatedBody } from "../../../../../modules/commerce/application/register-http";
import {
  fetchCommissionReadiness,
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
 * defaults (`enabled: false`, no rule) for a tenant that has never saved. Live
 * since the commission intake landed upstream (ADR-0046 D12, ADR-0147): the
 * paid-order consumer submits each counter-sale line to `hr_commission`'s intake
 * queue and a job posts it.
 *
 * Both answers carry `readiness` (`state`, whether `hr_commission` is on and the
 * last time this adapter submitted a line). Enabling while the tenant's commission intake is off
 * is SAFE - each paid sale's delivery fails, is retried and then dead-lettered
 * (replayable), never dropped - and VISIBLE: `state` stays
 * `awaiting_first_submission` (or `hr_commission_module_disabled`) until a line is
 * submitted. Commerce cannot read the intake's own switch (it may not read a
 * commission table): the operator checklist says to switch the intake on first.
 *
 * Reading needs `commerce.commission_settings.read`; changing needs
 * `commerce.commission_settings.manage` (a high-risk action: it decides whether
 * staff are paid commission). The change is audited with the old and new
 * values. `PUT` is an upsert, so replaying it is harmless. It takes effect for
 * orders paid afterwards; a sale already reported keeps the identity it was
 * reported under.
 *
 * `sourceType` and `ruleKey` form the accrual source identity that replays and
 * voids are keyed on, so once the consumer has reported any accrual under a
 * pair (recorded in `awcms_commerce_commission_attributed_sources`, in the same
 * transaction) a `PUT` that changes either answers `409 COMMISSION_SOURCE_LOCKED`
 * and is audited as `commerce.commission.settings_refused`. The check runs under
 * an exclusive tenant advisory lock that the consumer takes shared. Unchanged
 * values, and `enabled`, stay free (Issue #413 review).
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
  handler: async ({ tx, tenantId }) => {
    const settings = await fetchCommissionSettings(tx, tenantId);
    return ok({
      settings,
      readiness: await fetchCommissionReadiness(tx, tenantId, settings)
    });
  }
});

export const PUT = defineTenantRoute<CommissionSettingsInput>({
  workClass: "interactive",
  prepare: ({ request }) =>
    readValidatedBody(request, validateCommissionSettingsInput),
  authorize: COMMISSION_SETTINGS_MANAGE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const outcome = await saveCommissionSettings(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared,
      locals.correlationId
    );
    if (outcome.kind === "source_locked") {
      return fail(
        409,
        "COMMISSION_SOURCE_LOCKED",
        `Commission accruals already exist, so ${outcome.fields.join(" and ")} cannot be changed; it forms the accrual source identity.`
      );
    }
    return ok({
      settings: outcome.settings,
      readiness: await fetchCommissionReadiness(tx, tenantId, outcome.settings)
    });
  }
});
