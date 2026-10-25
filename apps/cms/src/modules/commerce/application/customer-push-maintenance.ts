/**
 * `commerce:customer-push:maintenance` - the per-tenant work (Issue #430,
 * ADR-0048 sections 5.3 "Session expiry" and 5.7 "Clean-up"). The registered
 * "delegated" adopter of the four customer-push `dataLifecycle` descriptors.
 *
 * Two jobs in one bounded pass, in this order:
 *
 * 1. SWEEP. An `active` device whose enrolling session has ended (revoked,
 *    expired, or purged -> `session_id` NULL), or whose account or customer
 *    row is blocked, is
 *    tombstoned: credentials destroyed, reason `session_ended` /
 *    `account_blocked`, its waiting messages cancelled. Delivery is refused for
 *    such a device at send time anyway (eligibility, #432); the sweep makes the
 *    destruction of the credential happen instead of waiting for the customer.
 *    Consequence (ADR-0048 Q5): notifications stop when the enrolling session
 *    lapses after 30 days without use; the customer re-enables with one tap.
 * 2. PURGE. Tombstones past 30 days (`revoked_at`), TERMINAL messages past 30
 *    days (`updated_at`) and attempts past 30 days (`created_at`). A queued,
 *    sending or retry_wait message is work and is never purged however old. It
 *    runs even when the `customerPush` feature is off: rows from an earlier
 *    period still need removing.
 *
 * Runs as `awcms_worker` (sql/1058): column-only UPDATE on devices (status and
 * credential columns), UPDATE on messages (the cancellation), DELETE on the
 * three tables. Idempotent, bounded per call, one short transaction per tenant.
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  CUSTOMER_PUSH_RETENTION_DAYS,
  CUSTOMER_PUSH_TERMINAL_MESSAGE_STATUSES
} from "../domain/customer-push";
import { tombstoneCustomerPushDevices } from "./customer-push-devices";

export const CUSTOMER_PUSH_MAINTENANCE_BATCH_LIMIT = 500;

export type CustomerPushMaintenanceOptions = {
  now?: Date;
  batchLimit?: number;
  retentionDays?: number;
  correlationId?: string;
};

export type CustomerPushMaintenanceResult = {
  sweptSessionEnded: number;
  sweptAccountBlocked: number;
  purgedDevices: number;
  purgedMessages: number;
  purgedAttempts: number;
};

type IdRow = { id: string };

export async function purgeCustomerPushForTenant(
  sql: Bun.SQL,
  tenantId: string,
  options: CustomerPushMaintenanceOptions = {}
): Promise<CustomerPushMaintenanceResult> {
  const now = options.now ?? new Date();
  const batchLimit =
    options.batchLimit ?? CUSTOMER_PUSH_MAINTENANCE_BATCH_LIMIT;
  const cutoff = new Date(
    now.getTime() -
      (options.retentionDays ?? CUSTOMER_PUSH_RETENTION_DAYS) *
        24 *
        60 *
        60 *
        1000
  );

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const endedSessions = (await tx`
        SELECT d.id
        FROM awcms_commerce_push_devices d
        LEFT JOIN awcms_commerce_customer_sessions s
          ON s.tenant_id = d.tenant_id AND s.id = d.session_id
        WHERE d.tenant_id = ${tenantId} AND d.status = 'active'
          AND (d.session_id IS NULL
               OR s.id IS NULL
               OR s.revoked_at IS NOT NULL
               OR s.expires_at <= ${now})
        ORDER BY d.id
        LIMIT ${batchLimit}
        FOR UPDATE OF d
      `) as IdRow[];

      const sessionEnded = await tombstoneCustomerPushDevices(
        tx,
        tenantId,
        endedSessions.map((row) => row.id),
        "revoked",
        "session_ended",
        "session_ended",
        now
      );

      const blockedAccounts = (await tx`
        SELECT d.id
        FROM awcms_commerce_push_devices d
        JOIN awcms_commerce_customer_accounts a
          ON a.tenant_id = d.tenant_id AND a.id = d.account_id
        JOIN awcms_commerce_customers c
          ON c.tenant_id = a.tenant_id AND c.id = a.customer_id
        WHERE d.tenant_id = ${tenantId} AND d.status = 'active'
          AND (a.status = 'blocked' OR c.status = 'blocked')
        ORDER BY d.id
        LIMIT ${batchLimit}
        FOR UPDATE OF d
      `) as IdRow[];

      const accountBlocked = await tombstoneCustomerPushDevices(
        tx,
        tenantId,
        blockedAccounts.map((row) => row.id),
        "revoked",
        "account_blocked",
        "account_blocked",
        now
      );

      // Attempts first (a message's attempts also cascade, but an orphan-free
      // table must not depend on that), then terminal messages, then tombstones
      // (their remaining messages cascade).
      const attempts = (await tx`
        DELETE FROM awcms_commerce_push_delivery_attempts
        WHERE id IN (
          SELECT id FROM awcms_commerce_push_delivery_attempts
          WHERE tenant_id = ${tenantId} AND created_at < ${cutoff}
          ORDER BY created_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as IdRow[];

      const messages = (await tx`
        DELETE FROM awcms_commerce_push_messages
        WHERE id IN (
          SELECT id FROM awcms_commerce_push_messages
          WHERE tenant_id = ${tenantId}
            AND status = ANY(${tx.array([...CUSTOMER_PUSH_TERMINAL_MESSAGE_STATUSES], "text")}::text[])
            AND updated_at < ${cutoff}
          ORDER BY updated_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as IdRow[];

      const devices = (await tx`
        DELETE FROM awcms_commerce_push_devices
        WHERE id IN (
          SELECT id FROM awcms_commerce_push_devices
          WHERE tenant_id = ${tenantId} AND status <> 'active'
            AND revoked_at < ${cutoff}
          ORDER BY revoked_at ASC
          LIMIT ${batchLimit}
        )
        RETURNING id
      `) as IdRow[];

      const result: CustomerPushMaintenanceResult = {
        sweptSessionEnded: sessionEnded.length,
        sweptAccountBlocked: accountBlocked.length,
        purgedDevices: devices.length,
        purgedMessages: messages.length,
        purgedAttempts: attempts.length
      };

      const total =
        result.sweptSessionEnded +
        result.sweptAccountBlocked +
        result.purgedDevices +
        result.purgedMessages +
        result.purgedAttempts;

      if (total > 0) {
        await recordAuditEvent(tx, {
          tenantId,
          moduleKey: "commerce",
          action: "purge",
          resourceType: "customer_push",
          severity: "info",
          message: `Customer push maintenance handled ${total} row(s).`,
          attributes: {
            ...result,
            cutoff: cutoff.toISOString(),
            ...(options.correlationId
              ? { correlationId: options.correlationId }
              : {})
          }
        });
      }

      return result;
    },
    { workClass: "maintenance" }
  );
}
