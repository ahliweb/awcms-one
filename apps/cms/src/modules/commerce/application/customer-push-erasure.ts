/**
 * Subject export and erasure for customer push data (Issue #430, ADR-0048
 * section 2.3 "Deletion"). The endpoint URL is personal data under UU PDP
 * 27/2022, so the data subject's access and erasure rights reach it.
 *
 * ## Why these functions and not the subject-data engine
 *
 * The engine finds rows by a tenant-user / identity / profile id, and a customer
 * ACCOUNT carries none of them (ADR-0016 D1, the same gap every commerce customer
 * table documents), so the four descriptors in `domain/customer-push-lifecycle.ts`
 * are honestly `unreachableBySubject`. These two functions are the real path,
 * keyed by the customer account, and they cover exactly the four tables:
 * `awcms_commerce_push_devices`, `_preferences`, `_messages`, `_delivery_attempts`.
 *
 * - There is no customer-account deletion flow in `commerce` today. When one is
 *   built it calls {@link eraseCustomerPushData} in its transaction; the account
 *   FKs also cascade (`ON DELETE CASCADE`, sql/1056/1057), so deleting the
 *   account in the database removes the same rows even if no application step
 *   ran.
 * - An operator-assisted erasure request calls it the same way.
 *
 * Both take an already-open RLS-scoped transaction: the tenant boundary is the
 * database's, and a caller handing the wrong tenant's account id finds nothing.
 *
 * ## What the export carries
 *
 * Everything about the account's push data that is not a credential: masked
 * endpoints, a coarse browser description, status and timestamps, the consent
 * evidence (every purpose including the reserved `marketing` row, the wording
 * version, grant and withdrawal times) and the generic messages queued for the
 * account. NEVER the endpoint, its hash, the keys or the ciphertexts.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { CUSTOMER_PUSH_AUDIT_ACTIONS } from "./customer-push-audit";

type IdRow = { id: string };

export type CustomerPushErasureResult = {
  devices: number;
  preferences: number;
  messages: number;
};

/**
 * Deletes the account's devices (credentials included), preferences, messages
 * and attempts (FK cascade). Idempotent: a second call deletes nothing. Writes
 * one audit event with COUNTS only.
 */
export async function eraseCustomerPushData(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  correlationId?: string
): Promise<CustomerPushErasureResult> {
  const messages = (await tx`
    DELETE FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    RETURNING id
  `) as IdRow[];

  const devices = (await tx`
    DELETE FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    RETURNING id
  `) as IdRow[];

  const preferences = (await tx`
    DELETE FROM awcms_commerce_push_preferences
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    RETURNING account_id AS id
  `) as IdRow[];

  const result: CustomerPushErasureResult = {
    devices: devices.length,
    preferences: preferences.length,
    messages: messages.length
  };

  if (result.devices + result.preferences + result.messages > 0) {
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: "commerce",
      action: CUSTOMER_PUSH_AUDIT_ACTIONS.dataErased,
      resourceType: "customer_push_data",
      resourceId: accountId,
      message: "Customer push data was erased for an account.",
      attributes: { accountId, ...result },
      correlationId
    });
  }

  return result;
}

export type CustomerPushExport = {
  devices: {
    id: string;
    endpointMasked: string;
    userAgentSummary: string | null;
    storefrontOrigin: string;
    status: string;
    statusReason: string | null;
    registeredAt: string;
    lastSuccessAt: string | null;
    revokedAt: string | null;
  }[];
  preferences: {
    purpose: string;
    enabled: boolean;
    consentTextVersion: string;
    grantedAt: string | null;
    revokedAt: string | null;
  }[];
  messages: {
    id: string;
    purpose: string;
    status: string;
    priority: string;
    createdAt: string;
    sentAt: string | null;
  }[];
};

const EXPORT_MESSAGE_LIMIT = 500;

type DeviceExportRow = {
  id: string;
  endpoint_masked: string;
  user_agent_summary: string | null;
  storefront_origin: string;
  status: string;
  status_reason: string | null;
  registered_at: Date;
  last_success_at: Date | null;
  revoked_at: Date | null;
};

type PreferenceExportRow = {
  purpose: string;
  enabled: boolean;
  consent_text_version: string;
  granted_at: Date | null;
  revoked_at: Date | null;
};

type MessageExportRow = {
  id: string;
  purpose: string;
  status: string;
  priority: string;
  created_at: Date;
  sent_at: Date | null;
};

export async function exportCustomerPushData(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string
): Promise<CustomerPushExport> {
  const devices = (await tx`
    SELECT id, endpoint_masked, user_agent_summary, storefront_origin, status,
           status_reason, registered_at, last_success_at, revoked_at
    FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    ORDER BY registered_at DESC, id DESC
  `) as DeviceExportRow[];

  const preferences = (await tx`
    SELECT purpose, enabled, consent_text_version, granted_at, revoked_at
    FROM awcms_commerce_push_preferences
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    ORDER BY purpose
  `) as PreferenceExportRow[];

  const messages = (await tx`
    SELECT id, purpose, status, priority, created_at, sent_at
    FROM awcms_commerce_push_messages
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
    ORDER BY created_at DESC, id DESC
    LIMIT ${EXPORT_MESSAGE_LIMIT}
  `) as MessageExportRow[];

  return {
    devices: devices.map((row) => ({
      id: row.id,
      endpointMasked: row.endpoint_masked,
      userAgentSummary: row.user_agent_summary,
      storefrontOrigin: row.storefront_origin,
      status: row.status,
      statusReason: row.status_reason,
      registeredAt: row.registered_at.toISOString(),
      lastSuccessAt: row.last_success_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    })),
    preferences: preferences.map((row) => ({
      purpose: row.purpose,
      enabled: row.enabled,
      consentTextVersion: row.consent_text_version,
      grantedAt: row.granted_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null
    })),
    messages: messages.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      status: row.status,
      priority: row.priority,
      createdAt: row.created_at.toISOString(),
      sentAt: row.sent_at?.toISOString() ?? null
    }))
  };
}
