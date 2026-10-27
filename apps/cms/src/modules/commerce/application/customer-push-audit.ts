/**
 * Audit vocabulary of customer Web Push (Issue #430, ADR-0048 section 5): the
 * action names and the one helper two callers share. IDS ONLY in every
 * `attributes` bag - never an endpoint, a key, a secret, a user agent or a
 * customer's name/e-mail/phone; `recordAuditEvent` redacts on top of that.
 *
 * The audit write runs in the SAME transaction as the change it records, so a
 * failed write rolls the change back (fail closed): an unrecorded device
 * takeover or consent change must not commit.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import type { PreferenceUpsertResult } from "./customer-push-preferences";

export const CUSTOMER_PUSH_AUDIT_ACTIONS = {
  registered: "commerce.customer_push.device_registered",
  transferred: "commerce.customer_push.device_transferred",
  revoked: "commerce.customer_push.device_revoked",
  preferencesChanged: "commerce.customer_push.preferences_changed",
  dataErased: "commerce.customer_push.data_erased"
} as const;

/** One audit event per preference change set: the purposes, their new state and the wording version, never a device. */
export async function auditPreferences(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  result: PreferenceUpsertResult,
  correlationId?: string
): Promise<void> {
  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: "commerce",
    action: CUSTOMER_PUSH_AUDIT_ACTIONS.preferencesChanged,
    resourceType: "customer_push_preferences",
    resourceId: accountId,
    message: "Customer push notification preferences changed.",
    attributes: {
      accountId,
      changes: result.changed,
      textVersion: result.textVersion
    },
    correlationId
  });
}
