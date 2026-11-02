/**
 * Customer push consent preferences (Issue #430, ADR-0048 section 2.3 and 6.1).
 *
 * One row per (account, purpose). A GRANT records the consent text version the
 * customer saw and the grant time; a WITHDRAWAL sets `enabled = false` and
 * `revoked_at` and KEEPS the row as evidence. Transactional consent never implies
 * marketing consent: `marketing` is a reserved purpose that no route here can
 * enable (the validators refuse it) and nothing ever sends for.
 *
 * Functions take an already-open RLS-scoped transaction. The audit write is the
 * caller's (`customer-push-devices.ts#auditPreferences`), in the same
 * transaction, so a failed audit rolls the preference change back.
 */
import {
  CUSTOMER_PUSH_CONSENT_TEXT_VERSION,
  CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES,
  type CustomerPushPurpose,
  type PreferenceChange
} from "../domain/customer-push";

export type CustomerPushPreferenceView = {
  purpose: CustomerPushPurpose;
  enabled: boolean;
  consentTextVersion: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
};

type PreferenceRow = {
  purpose: string;
  enabled: boolean;
  consent_text_version: string;
  granted_at: Date | null;
  revoked_at: Date | null;
};

export type PreferenceUpsertResult = {
  /** The purposes whose enabled state actually changed. */
  changed: { purpose: string; enabled: boolean }[];
  textVersion: string | null;
};

/**
 * The account's preference for each TRANSACTIONAL purpose, in a fixed order. A
 * purpose with no row is reported as not enabled with no consent evidence; the
 * reserved `marketing` row is never exposed.
 */
export async function listCustomerPushPreferences(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<CustomerPushPreferenceView[]> {
  const rows = (await tx`
    SELECT purpose, enabled, consent_text_version, granted_at, revoked_at
    FROM awcms_commerce_push_preferences
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
  `) as PreferenceRow[];

  const byPurpose = new Map(rows.map((row) => [row.purpose, row]));

  return CUSTOMER_PUSH_TRANSACTIONAL_PURPOSES.map((purpose) => {
    const row = byPurpose.get(purpose);
    return {
      purpose,
      enabled: row?.enabled ?? false,
      consentTextVersion: row?.consent_text_version ?? null,
      grantedAt: row?.granted_at?.toISOString() ?? null,
      revokedAt: row?.revoked_at?.toISOString() ?? null
    };
  });
}

/**
 * Turns the given purposes ON with the consent wording version shown. A purpose
 * already on under the same version keeps its original grant time (a repeat
 * registration is not a new consent event); one on under an older version, or
 * off, is granted afresh. Never turns another purpose off.
 */
export async function upsertGrantedPreferences(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  purposes: readonly string[],
  textVersion: string,
  now: Date = new Date()
): Promise<PreferenceUpsertResult> {
  const changed: PreferenceUpsertResult["changed"] = [];

  for (const purpose of purposes) {
    const before = (await tx`
      SELECT enabled, consent_text_version
      FROM awcms_commerce_push_preferences
      WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
        AND purpose = ${purpose}
      FOR UPDATE
    `) as { enabled: boolean; consent_text_version: string }[];

    // Already on under this very wording: a repeat registration is not a new
    // consent event, so the original grant time stays and nothing is audited.
    if (before[0]?.enabled && before[0].consent_text_version === textVersion) {
      continue;
    }

    await tx`
      INSERT INTO awcms_commerce_push_preferences
        (tenant_id, account_id, purpose, enabled, consent_text_version,
         granted_at, revoked_at, updated_at)
      VALUES (${tenantId}, ${accountId}, ${purpose}, true, ${textVersion},
              ${now}, NULL, ${now})
      ON CONFLICT (tenant_id, account_id, purpose) DO UPDATE
      SET enabled = true,
          consent_text_version = EXCLUDED.consent_text_version,
          granted_at = EXCLUDED.granted_at,
          revoked_at = NULL,
          updated_at = EXCLUDED.updated_at
    `;
    changed.push({ purpose, enabled: true });
  }

  return { changed, textVersion };
}

/**
 * Applies a `PUT .../push/preferences` change set (already validated). Turning a
 * purpose off sets `revoked_at` and keeps the row. A purpose with no row that is
 * set to false is recorded as an explicit "off" under the current wording, so the
 * customer's choice is on record. Returns the purposes whose state changed.
 */
export async function applyPreferenceChanges(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  changes: readonly PreferenceChange[],
  textVersion: string | null,
  now: Date = new Date()
): Promise<PreferenceUpsertResult> {
  const changed: PreferenceUpsertResult["changed"] = [];

  const enable = changes.filter((change) => change.enabled);
  if (enable.length > 0 && textVersion !== null) {
    const granted = await upsertGrantedPreferences(
      tx,
      tenantId,
      accountId,
      enable.map((change) => change.purpose),
      textVersion,
      now
    );
    changed.push(...granted.changed);
  }

  for (const change of changes.filter((entry) => !entry.enabled)) {
    const before = (await tx`
      SELECT enabled FROM awcms_commerce_push_preferences
      WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
        AND purpose = ${change.purpose}
      FOR UPDATE
    `) as { enabled: boolean }[];

    if (before.length === 0) {
      await tx`
        INSERT INTO awcms_commerce_push_preferences
          (tenant_id, account_id, purpose, enabled, consent_text_version,
           granted_at, revoked_at, updated_at)
        VALUES (${tenantId}, ${accountId}, ${change.purpose}, false,
                ${textVersion ?? CUSTOMER_PUSH_CONSENT_TEXT_VERSION},
                NULL, ${now}, ${now})
      `;
      continue;
    }

    if (before[0]!.enabled) {
      await tx`
        UPDATE awcms_commerce_push_preferences
        SET enabled = false, revoked_at = ${now}, updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
          AND purpose = ${change.purpose}
      `;
      changed.push({ purpose: change.purpose, enabled: false });
    }
  }

  return { changed, textVersion };
}
