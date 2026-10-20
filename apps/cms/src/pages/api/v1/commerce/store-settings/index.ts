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
  auditCheckInPolicyChange,
  fetchBookingServiceTenantUserId,
  fetchCheckInRequiresSettlement,
  isActiveTenantUser,
  lockCheckInRequiresSettlement,
  saveBookingServiceTenantUserId,
  saveCheckInRequiresSettlement
} from "../../../../../modules/commerce/application/booking-adapter-settings";
import { requireStepUp } from "../../../../../modules/identity-access/application/mfa-session-assurance";
import { fetchTaxAdapterConfig } from "../../../../../modules/commerce/application/tax-adapter-directory";
import {
  validateStoreSettingsInput,
  type StoreSettingsData
} from "../../../../../modules/commerce/domain/store-settings-validation";
import { validateCommissionRateInput } from "../../../../../modules/commerce/domain/affiliate-commission";
import { isUuid } from "../../../../../modules/commerce/domain/register";
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
    const [
      settings,
      affiliateCommissionRate,
      taxAdapter,
      bookingServiceTenantUserId,
      checkinRequiresSettlement
    ] = await Promise.all([
      fetchStoreSettings(tx, tenantId),
      fetchAffiliateCommissionRate(tx, tenantId),
      fetchTaxAdapterConfig(tx, tenantId),
      fetchBookingServiceTenantUserId(tx, tenantId),
      fetchCheckInRequiresSettlement(tx, tenantId)
    ]);
    // Issue #293 (ADR-0039): the tax mode is READ-ONLY here — it is flipped only by
    // the audited cut-over tooling (`commerce:tax:cutover`), never by this PUT.
    return ok({
      ...settings,
      affiliateCommissionRate,
      bookingServiceTenantUserId,
      checkinRequiresSettlement,
      taxMode: taxAdapter.mode,
      taxProfileCode: taxAdapter.profileCode
    });
  }
});

/** Body keys backed by real columns of the settings row, not by the jsonb blob. */
const SIDE_COLUMN_KEYS: ReadonlySet<string> = new Set([
  "affiliateCommissionRate",
  "bookingServiceTenantUserId",
  "checkinRequiresSettlement"
]);

type PreparedSettingsUpdate = {
  settings: StoreSettingsData;
  affiliateCommissionRate: string | null;
  /** `undefined` = leave the stored value alone; `null` = clear it (Issue #378, ADR-0045 G3). */
  bookingServiceTenantUserId: string | null | undefined;
  /** `undefined` = leave the stored value alone (Issue #383, ADR-0045 D19). */
  checkinRequiresSettlement: boolean | undefined;
};

/** `PUT /api/v1/commerce/store-settings` — full replace, never a partial merge (see `domain/store-settings-validation.ts`'s header). `affiliateCommissionRate` (Issue #92) is validated/saved separately from the jsonb blob — see `sql/921`'s header for why it is a real column. */
export const PUT = defineTenantRoute({
  workClass: "interactive",
  prepare: async ({ request }): Promise<PreparedSettingsUpdate | Response> => {
    const bodyRead = await readJsonBody(request);
    if (bodyRead.tooLarge) return bodyTooLargeResponse(bodyRead.limitBytes);

    // The two columns that live beside the jsonb blob (`affiliateCommissionRate`,
    // `bookingServiceTenantUserId`) are validated and saved separately below;
    // the blob's own validator rejects any key it does not own, so they are
    // taken out of the body it sees.
    const blobBody =
      bodyRead.value &&
      typeof bodyRead.value === "object" &&
      !Array.isArray(bodyRead.value)
        ? Object.fromEntries(
            Object.entries(bodyRead.value as Record<string, unknown>).filter(
              ([key]) => !SIDE_COLUMN_KEYS.has(key)
            )
          )
        : bodyRead.value;
    const validation = validateStoreSettingsInput(blobBody);
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

    // Issue #378 (ADR-0045 G3): the booking adapter's service-account tenant
    // user. Absent leaves the stored value alone (a full-replace PUT from a
    // screen that does not carry the field must not clear it); `null` clears it.
    const rawServiceUser = record.bookingServiceTenantUserId;
    if (
      rawServiceUser !== undefined &&
      rawServiceUser !== null &&
      !isUuid(rawServiceUser)
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Store settings input is invalid.",
        {},
        [
          {
            field: "bookingServiceTenantUserId",
            message: "bookingServiceTenantUserId must be a uuid, or null."
          }
        ]
      );
    }

    // Issue #383 (ADR-0045 D19): the check-in policy. Absent leaves the stored
    // value alone; it is a boolean, never `null` (there is no "unset": the
    // default is the fail-closed block).
    const rawCheckIn = record.checkinRequiresSettlement;
    if (rawCheckIn !== undefined && typeof rawCheckIn !== "boolean") {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Store settings input is invalid.",
        {},
        [
          {
            field: "checkinRequiresSettlement",
            message: "checkinRequiresSettlement must be a boolean."
          }
        ]
      );
    }

    return {
      settings: validation.value,
      affiliateCommissionRate: rateValidation.value,
      bookingServiceTenantUserId: rawServiceUser as string | null | undefined,
      checkinRequiresSettlement: rawCheckIn
    };
  },
  authorize: UPDATE_GUARD,
  handler: async ({ tx, tenantId, auth, prepared, locals, tokenHash, now }) => {
    // Checked BEFORE any write: a returned 4xx after a write would commit it.
    if (
      typeof prepared.bookingServiceTenantUserId === "string" &&
      !(await isActiveTenantUser(
        tx,
        tenantId,
        prepared.bookingServiceTenantUserId
      ))
    ) {
      return fail(
        400,
        "VALIDATION_ERROR",
        "Store settings input is invalid.",
        {},
        [
          {
            field: "bookingServiceTenantUserId",
            message:
              "bookingServiceTenantUserId must be an active user of this tenant."
          }
        ]
      );
    }
    // Issue #383 (ADR-0045 D19; security audit of PR #443, M1): turning the
    // check-in policy OFF (a balance no longer blocks a check-in) is a
    // loosening of a money control, so it needs a FRESH step-up - the same
    // platform gate as a refund override and a cancellation-policy approval,
    // `403 STEP_UP_REQUIRED` and nothing written otherwise - and is audited
    // either way it flips. The value is read under the settings row's lock so the
    // decision and the audited `from` cannot be overtaken by a concurrent PUT.
    let checkInPolicyChange:
      { from: boolean; to: boolean; stepUpAt: Date | null } | undefined;
    if (prepared.checkinRequiresSettlement !== undefined) {
      const from = await lockCheckInRequiresSettlement(tx, tenantId);
      const to = prepared.checkinRequiresSettlement;
      let stepUpAt: Date | null = null;
      if (from && !to) {
        const stepUp = await requireStepUp(tx, tenantId, tokenHash, now);
        if (!stepUp.ok) return stepUp.denied;
        stepUpAt = stepUp.session.steppedUpAt;
      }
      checkInPolicyChange = { from, to, stepUpAt };
    }
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
    if (prepared.bookingServiceTenantUserId !== undefined) {
      await saveBookingServiceTenantUserId(
        tx,
        tenantId,
        prepared.bookingServiceTenantUserId,
        auth.context.tenantUserId,
        locals.correlationId
      );
    }
    if (prepared.checkinRequiresSettlement !== undefined) {
      await saveCheckInRequiresSettlement(
        tx,
        tenantId,
        prepared.checkinRequiresSettlement
      );
    }
    if (checkInPolicyChange) {
      await auditCheckInPolicyChange(tx, {
        tenantId,
        actorTenantUserId: auth.context.tenantUserId,
        ...checkInPolicyChange,
        correlationId: locals.correlationId
      });
    }
    return ok({
      ...saved,
      affiliateCommissionRate: prepared.affiliateCommissionRate,
      bookingServiceTenantUserId: await fetchBookingServiceTenantUserId(
        tx,
        tenantId
      ),
      checkinRequiresSettlement: await fetchCheckInRequiresSettlement(
        tx,
        tenantId
      )
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
