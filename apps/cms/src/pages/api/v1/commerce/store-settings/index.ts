import { fail, ok } from "../../../../../modules/_shared/api-response";
import { defineTenantRoute } from "../../../../../modules/_shared/tenant-route";
import {
  bodyTooLargeResponse,
  readJsonBody
} from "../../../../../lib/security/request-body-limit";
import {
  fetchAffiliateCommissionRate,
  fetchStoreSettings,
  resetStoreSettings,
  saveAffiliateCommissionRate,
  saveStoreSettings
} from "../../../../../modules/commerce/application/store-settings-directory";
import {
  validateStoreSettingsInput,
  type StoreSettingsData
} from "../../../../../modules/commerce/domain/store-settings-validation";
import { validateCommissionRateInput } from "../../../../../modules/commerce/domain/affiliate-commission";
import { COMMERCE_SETTINGS_ACTIVITY_CODE } from "../../../../../modules/commerce/domain/commerce-permissions";

const READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
  action: "read"
} as const;
const UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_SETTINGS_ACTIVITY_CODE,
  action: "update"
} as const;

/** `GET /api/v1/commerce/store-settings` — the OWNER's own unmasked view (bank accounts, QRIS media id included). Never 404s — see `store-settings-directory.ts`'s `buildDefaultStoreSettings`. */
export const GET = defineTenantRoute({
  workClass: "interactive",
  authorize: READ_GUARD,
  handler: async ({ tx, tenantId }) => {
    const [settings, affiliateCommissionRate] = await Promise.all([
      fetchStoreSettings(tx, tenantId),
      fetchAffiliateCommissionRate(tx, tenantId)
    ]);
    return ok({ ...settings, affiliateCommissionRate });
  }
});

type PreparedSettingsUpdate = {
  settings: StoreSettingsData;
  affiliateCommissionRate: string | null;
};

/** `PUT /api/v1/commerce/store-settings` — full replace, never a partial merge (see `domain/store-settings-validation.ts`'s header). `affiliateCommissionRate` (Issue #92) is validated/saved separately from the jsonb blob — see `sql/921`'s header for why it is a real column. */
export const PUT = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedSettingsUpdate | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    const validation = validateStoreSettingsInput(bodyRead.value);
    if (!validation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Store settings input is invalid.",
        {},
        validation.errors
      );
    }

    const record =
      bodyRead.value && typeof bodyRead.value === "object"
        ? (bodyRead.value as Record<string, unknown>)
        : {};
    const rateValidation = validateCommissionRateInput(
      record.affiliateCommissionRate,
      "affiliateCommissionRate"
    );
    if (!rateValidation.valid) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Store settings input is invalid.",
        {},
        rateValidation.errors
      );
    }

    return {
      settings: validation.value,
      affiliateCommissionRate: rateValidation.value
    };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals }) => {
    const saved = await saveStoreSettings(
      tx,
      tenantId,
      auth.context.tenantUserId,
      prepared.settings,
      locals.correlationId
    );
    await saveAffiliateCommissionRate(
      tx,
      tenantId,
      prepared.affiliateCommissionRate
    );
    return ok({
      ...saved,
      affiliateCommissionRate: prepared.affiliateCommissionRate
    });
  }
});

/**
 * `DELETE /api/v1/commerce/store-settings` — reset the tenant's settings to
 * the defaults. Gated on the same `settings.update` as `PUT`: resetting is a
 * write to the same resource, not a separate capability. Idempotent — a
 * tenant already on the defaults gets the same 200, without an audit line.
 */
export const DELETE = defineTenantRoute({
  workClass: "interactive",
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, locals }) => {
    await resetStoreSettings(
      tx,
      tenantId,
      auth.context.tenantUserId,
      locals.correlationId
    );
    return ok({ tenantId, status: "reset" });
  }
});
