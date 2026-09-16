import { recordAuditEvent } from "../../logging/application/audit-log";
import type { MediaLibraryPort } from "../../_shared/ports/media-library-port";
import {
  DEFAULT_CUSTOMER_LEVEL_NAMES,
  STORE_SETTINGS_SCHEMA_VERSION,
  type StoreSettingsData
} from "../domain/store-settings-validation";

const AUDIT_MODULE_KEY = "commerce";
const AUDIT_RESOURCE_TYPE = "store_settings";

/**
 * A tenant that has never opened the settings screen has no row at all — a
 * singleton table is created lazily, on first `PUT`, rather than by a
 * migration-time `INSERT ... SELECT FROM awcms_tenants` (which would only
 * cover tenants that already existed when this migration ran — the same
 * limitation every permission-seed migration in this repo already accepts,
 * stated rather than worked around). `fetchStoreSettings` therefore returns
 * this fully-defaulted shape, with `storeName` falling back to the tenant's
 * own `awcms_tenants.tenant_name`, so `GET`/`GET .../public` never 404 —
 * a blank settings screen is a valid state, not an error.
 */
function buildDefaultStoreSettings(storeName: string): StoreSettingsData {
  return {
    schemaVersion: STORE_SETTINGS_SCHEMA_VERSION,
    storeName,
    tagline: null,
    logoMediaObjectId: null,
    faviconMediaObjectId: null,
    address: null,
    phone: null,
    whatsapp: null,
    email: null,
    mapsEmbedUrl: null,
    faqs: [],
    social: {
      facebook: null,
      instagram: null,
      tiktok: null,
      x: null,
      youtube: null,
      linkedin: null
    },
    customerLevels: [1, 2, 3, 4].map((level) => ({
      level,
      name: DEFAULT_CUSTOMER_LEVEL_NAMES[level - 1]!,
      type: "percentage",
      value: "0.00"
    })),
    shipping: {
      alternativeServices: [],
      selfPickup: false,
      courierEnabled: false,
      pinpointEnabled: false,
      freeShipping: { active: false, minOrder: "0.00", maxDiscount: "0.00" },
      originCityName: null,
      originSubdistrictName: null
    },
    payment: {
      manualBank: { active: false, accounts: [] },
      manualQris: { active: false, mediaObjectId: null },
      downPayment: { active: false, percent: 0 },
      tax: { active: false, percent: 0 },
      insurance: { active: false, ratePercent: "0.0", minFee: "0.00" }
    },
    orders: { expiryHours: 24 },
    promoSection: { active: false, items: [] },
    meta: {
      home: { title: null, description: null },
      contact: { title: null, description: null }
    }
  };
}

async function fetchTenantName(tx: Bun.SQL, tenantId: string): Promise<string> {
  const rows = (await tx`
    SELECT tenant_name FROM awcms_tenants WHERE id = ${tenantId}
  `) as { tenant_name: string }[];
  return rows[0]?.tenant_name ?? "";
}

/** The OWNER shape — everything, including bank accounts / the QRIS media id. Never returned by a public route (see `toPublicRecord` below). */
export async function fetchStoreSettings(
  tx: Bun.SQL,
  tenantId: string
): Promise<StoreSettingsData> {
  // A RESET row (`deleted_at IS NOT NULL`, sql/162's header) reads as "no
  // settings saved" — the same answer a tenant that never saved any gets —
  // rather than as the stale blob it still carries until the retention
  // engine purges it.
  const rows = (await tx`
    SELECT settings
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
  `) as { settings: StoreSettingsData }[];

  if (rows[0]) return rows[0].settings;

  return buildDefaultStoreSettings(await fetchTenantName(tx, tenantId));
}

/**
 * `DELETE /api/v1/commerce/store-settings` — "reset to defaults". Stamps
 * `deleted_at` rather than removing the row (sql/162's header): the
 * singleton keeps its primary key, the next `PUT` clears the stamp, and the
 * stamped row is what `commerce/module.ts`'s `dataLifecycle` descriptor
 * eventually purges. Answers `true` when a live row was reset and `false`
 * when there was nothing to reset (already defaults) — the route maps both
 * to 204, since the end state is identical, but the audit trail only gets a
 * line when something actually changed.
 */
export async function resetStoreSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  correlationId?: string
): Promise<boolean> {
  const rows = (await tx`
    UPDATE awcms_commerce_store_settings
    SET deleted_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND deleted_at IS NULL
    RETURNING tenant_id
  `) as { tenant_id: string }[];

  if (rows.length === 0) return false;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "delete",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: tenantId,
    message: "Store settings reset to defaults.",
    attributes: {},
    correlationId
  });

  return true;
}

/** Which top-level sections differ between two settings objects — the audit trail's own message names sections, never raw field values (see `voucher.ts`-adjacent masking discipline: bank account numbers/QRIS payloads must never reach a log line). */
function changedSections(
  before: StoreSettingsData,
  after: StoreSettingsData
): string[] {
  const sections: (keyof StoreSettingsData)[] = [
    "storeName",
    "tagline",
    "logoMediaObjectId",
    "faviconMediaObjectId",
    "address",
    "phone",
    "whatsapp",
    "email",
    "mapsEmbedUrl",
    "faqs",
    "social",
    "customerLevels",
    "shipping",
    "payment",
    "promoSection",
    "meta"
  ];
  return sections.filter(
    (section) =>
      JSON.stringify(before[section]) !== JSON.stringify(after[section])
  );
}

/** Full-replace upsert — `PUT /api/v1/commerce/store-settings`. */
export async function saveStoreSettings(
  tx: Bun.SQL,
  tenantId: string,
  actorTenantUserId: string,
  input: StoreSettingsData,
  correlationId?: string
): Promise<StoreSettingsData> {
  const before = await fetchStoreSettings(tx, tenantId);

  const rows = (await tx`
    INSERT INTO awcms_commerce_store_settings (tenant_id, settings)
    VALUES (${tenantId}, ${input}::jsonb)
    ON CONFLICT (tenant_id) DO UPDATE
      SET settings = EXCLUDED.settings, updated_at = now(), deleted_at = NULL
    RETURNING settings
  `) as { settings: StoreSettingsData }[];

  const saved = rows[0]!.settings;

  await recordAuditEvent(tx, {
    tenantId,
    actorTenantUserId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "update",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: tenantId,
    message: "Store settings updated.",
    attributes: { sections: changedSections(before, saved) },
    correlationId
  });

  return saved;
}

export type StoreSettingsPublicRecord = {
  storeName: string;
  tagline: string | null;
  logo: {
    url: string;
    alt: string;
    width: number | null;
    height: number | null;
  } | null;
  favicon: { url: string } | null;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  mapsEmbedUrl: string | null;
  faqs: { question: string; answer: string }[];
  social: StoreSettingsData["social"];
  customerLevels: { level: number; name: string }[];
  shipping: {
    alternativeServices: { id: string; name: string; cost: string }[];
    selfPickup: boolean;
    courierEnabled: boolean;
    pinpointEnabled: boolean;
    freeShipping: { active: boolean; minOrder: string; maxDiscount: string };
    originCityName: string | null;
    originSubdistrictName: string | null;
  };
  payment: {
    manualBank: { active: boolean; banks: { bankName: string }[] };
    manualQris: { active: boolean };
    downPayment: { active: boolean; percent: number };
    tax: { active: boolean; percent: number };
    insurance: { active: boolean; ratePercent: string; minFee: string };
    /**
     * Issue #29 — whether the public payment-proof upload path
     * (`POST …/orders/{code}/payment-proof/upload-sessions`) is usable on
     * this deployment. `toPublicRecord` below always answers `false`: this
     * increment's public upload-session flow could not be built without a
     * principal the anonymous surface does not have (see
     * `application/order-directory.ts`'s header for the full reasoning) —
     * a confirmation without a proof is still accepted, so the storefront
     * simply hides the "attach proof" control when this is `false`.
     */
    proofUpload: boolean;
  };
  orders: StoreSettingsData["orders"];
  promoSection: StoreSettingsData["promoSection"];
  meta: StoreSettingsData["meta"];
};

/**
 * `GET /api/v1/commerce/store-settings/public` — the public subset (contract
 * `commerce-public-read-models.md`). `logo`/`favicon` resolve
 * `logoMediaObjectId`/`faviconMediaObjectId` through `MediaLibraryPort`,
 * exactly how `product-directory.ts` resolves a product's images — `null`
 * until an owner sets one (this platform's own logo management; the
 * site-profile schema has no logo field). Bank account numbers, account
 * holder names, and the QRIS media id NEVER appear here — only
 * `banks[].bankName` and `manualQris.active` cross into this shape, per the
 * contract's own note.
 */
export async function toPublicRecord(
  tx: Bun.SQL,
  tenantId: string,
  settings: StoreSettingsData,
  mediaPort: MediaLibraryPort
): Promise<StoreSettingsPublicRecord> {
  const mediaIds = [
    settings.logoMediaObjectId,
    settings.faviconMediaObjectId
  ].filter((id): id is string => id !== null);
  const resolved =
    mediaIds.length > 0
      ? await mediaPort.resolveMediaReferences(tx, tenantId, mediaIds)
      : new Map<
          string,
          {
            publicUrl: string;
            altText: string | null;
            width: number | null;
            height: number | null;
          }
        >();

  const logoResolved = settings.logoMediaObjectId
    ? resolved.get(settings.logoMediaObjectId)
    : undefined;
  const faviconResolved = settings.faviconMediaObjectId
    ? resolved.get(settings.faviconMediaObjectId)
    : undefined;

  return {
    storeName: settings.storeName,
    tagline: settings.tagline,
    logo: logoResolved
      ? {
          url: logoResolved.publicUrl,
          alt: logoResolved.altText ?? settings.storeName,
          width: logoResolved.width,
          height: logoResolved.height
        }
      : null,
    favicon: faviconResolved ? { url: faviconResolved.publicUrl } : null,
    address: settings.address,
    phone: settings.phone,
    whatsapp: settings.whatsapp,
    email: settings.email,
    mapsEmbedUrl: settings.mapsEmbedUrl,
    faqs: settings.faqs,
    social: settings.social,
    customerLevels: settings.customerLevels.map((level) => ({
      level: level.level,
      name: level.name
    })),
    shipping: {
      alternativeServices: settings.shipping.alternativeServices,
      selfPickup: settings.shipping.selfPickup,
      courierEnabled: settings.shipping.courierEnabled,
      pinpointEnabled: settings.shipping.pinpointEnabled,
      freeShipping: settings.shipping.freeShipping,
      originCityName: settings.shipping.originCityName,
      originSubdistrictName: settings.shipping.originSubdistrictName
    },
    payment: {
      manualBank: {
        active: settings.payment.manualBank.active,
        banks: settings.payment.manualBank.accounts.map((account) => ({
          bankName: account.bankName
        }))
      },
      manualQris: { active: settings.payment.manualQris.active },
      downPayment: settings.payment.downPayment,
      tax: settings.payment.tax,
      insurance: settings.payment.insurance,
      proofUpload: false
    },
    orders: settings.orders,
    promoSection: settings.promoSection,
    meta: settings.meta
  };
}
