/**
 * The HTTP plumbing the barcode routes (`/api/v1/commerce/barcodes*`) share
 * (Issue #292, ADR-0032): the `barcode` feature gate and the guards. Declared
 * once so the lookup, list and assign routes cannot drift apart.
 */
import { fetchModuleSettingsView } from "../../module-management/application/module-settings";
import { COMMERCE_BARCODES_ACTIVITY_CODE } from "../domain/commerce-permissions";
import {
  readTenantShortcutSettings,
  type ShortcutOverrides
} from "../domain/pos-shortcuts";
import { requireCommerceFeatureForOwnerRoute } from "./commerce-feature-gate";

export const BARCODE_READ_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BARCODES_ACTIVITY_CODE,
  action: "read"
} as const;

export const BARCODE_UPDATE_GUARD = {
  moduleKey: "commerce",
  activityCode: COMMERCE_BARCODES_ACTIVITY_CODE,
  action: "update"
} as const;

/** `409 FEATURE_DISABLED` while the tenant's `barcode` feature is off, else `null`. */
export function requireBarcodeFeature(
  tx: Bun.SQL,
  tenantId: string
): Promise<Response | null> {
  return requireCommerceFeatureForOwnerRoute(tx, tenantId, "barcode");
}

/**
 * The tenant's POS shortcut overrides (`commerce` module setting
 * `posShortcuts`), already reduced to the entries that pass
 * `domain/pos-shortcuts.ts`'s policy. Never throws on a malformed setting: bad
 * entries are dropped, so a bad stored value degrades to the built-in map.
 */
export async function fetchTenantShortcutOverrides(
  tx: Bun.SQL,
  tenantId: string
): Promise<ShortcutOverrides> {
  const view = await fetchModuleSettingsView(tx, tenantId, "commerce");
  return readTenantShortcutSettings(view?.effective);
}
