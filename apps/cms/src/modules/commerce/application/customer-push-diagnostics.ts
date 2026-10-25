/**
 * Aggregate customer-push diagnostics for staff (Issue #430, ADR-0048 Q10 and
 * section 8.2 T11): COUNTS by status and purpose, nothing else. Never an
 * endpoint (masked or not), a device id, an account or customer id, a token, a
 * message text, a name, an e-mail or a phone. A staff member with
 * `commerce.customer_push.read` learns how the feature is doing, not who is on
 * it.
 *
 * No metric is named "delivered": `sent` means only that the push service
 * accepted the request (ADR-0048 I8, T17, Q12 - no click or read analytics).
 */
import {
  CUSTOMER_PUSH_DEVICE_STATUSES,
  CUSTOMER_PUSH_MESSAGE_STATUSES,
  CUSTOMER_PUSH_PURPOSES
} from "../domain/customer-push";

export type CustomerPushDiagnostics = {
  generatedAt: string;
  devices: Record<(typeof CUSTOMER_PUSH_DEVICE_STATUSES)[number], number>;
  /** Accounts with at least one active device. */
  accountsWithActiveDevice: number;
  messages: {
    /** All retained rows (the retention window is 30 days), by status. */
    byStatus: Record<(typeof CUSTOMER_PUSH_MESSAGE_STATUSES)[number], number>;
    /** Retained rows by purpose and status. */
    byPurposeAndStatus: {
      purpose: string;
      status: string;
      count: number;
    }[];
  };
  preferences: {
    purpose: string;
    enabled: number;
    withdrawn: number;
  }[];
};

export async function fetchCustomerPushDiagnostics(
  tx: Bun.SQL,
  tenantId: string,
  now: Date = new Date()
): Promise<CustomerPushDiagnostics> {
  const deviceRows = (await tx`
    SELECT status, count(*)::int AS n
    FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId}
    GROUP BY status
  `) as { status: string; n: number }[];

  const accountRows = (await tx`
    SELECT count(DISTINCT account_id)::int AS n
    FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND status = 'active'
  `) as { n: number }[];

  const messageRows = (await tx`
    SELECT purpose, status, count(*)::int AS n
    FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId}
    GROUP BY purpose, status
  `) as { purpose: string; status: string; n: number }[];

  const preferenceRows = (await tx`
    SELECT purpose, enabled, count(*)::int AS n
    FROM awcms_commerce_push_preferences
    WHERE tenant_id = ${tenantId}
    GROUP BY purpose, enabled
  `) as { purpose: string; enabled: boolean; n: number }[];

  const devices = Object.fromEntries(
    CUSTOMER_PUSH_DEVICE_STATUSES.map((status) => [status, 0])
  ) as CustomerPushDiagnostics["devices"];
  for (const row of deviceRows) {
    if (row.status in devices) {
      devices[row.status as keyof typeof devices] = row.n;
    }
  }

  const byStatus = Object.fromEntries(
    CUSTOMER_PUSH_MESSAGE_STATUSES.map((status) => [status, 0])
  ) as CustomerPushDiagnostics["messages"]["byStatus"];
  for (const row of messageRows) {
    if (row.status in byStatus) {
      byStatus[row.status as keyof typeof byStatus] += row.n;
    }
  }

  return {
    generatedAt: now.toISOString(),
    devices,
    accountsWithActiveDevice: accountRows[0]?.n ?? 0,
    messages: {
      byStatus,
      byPurposeAndStatus: messageRows
        .map((row) => ({
          purpose: row.purpose,
          status: row.status,
          count: row.n
        }))
        .sort(
          (a, b) =>
            a.purpose.localeCompare(b.purpose) ||
            a.status.localeCompare(b.status)
        )
    },
    // The reserved `marketing` row is reported too: it proves nothing is
    // enabled for a purpose that is never sent.
    preferences: CUSTOMER_PUSH_PURPOSES.map((purpose) => ({
      purpose,
      enabled:
        preferenceRows.find((r) => r.purpose === purpose && r.enabled)?.n ?? 0,
      withdrawn:
        preferenceRows.find((r) => r.purpose === purpose && !r.enabled)?.n ?? 0
    }))
  };
}
