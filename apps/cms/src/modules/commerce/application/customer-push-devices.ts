/**
 * The customer device directory (Issue #430, ADR-0048 section 5): register
 * (idempotent), list, revoke one / all, revoke by session (logout), by account
 * (block) and the delivery-target read. Every function takes an ALREADY-OPEN
 * RLS-scoped transaction, so a caller registers a device in the same transaction
 * that authenticated the bearer, and an audit write that fails rolls the change
 * back (fail closed: an unrecorded takeover must not commit).
 *
 * ## Where credentials are touched
 *
 * The raw endpoint, the p256dh key and the auth secret exist in plaintext in
 * exactly two places: the register function below (they arrive, are encrypted
 * and are gone) and {@link loadCustomerPushDeliveryTarget} (the dispatcher, #432,
 * decrypts them to hand a `PushTarget` to the provider). The only file that
 * names `endpoint_ciphertext` or `auth_secret_ciphertext` is this one, plus the
 * key-rotation file. Every list, log and diagnostic reads `endpoint_masked`.
 *
 * ## Invariants this file keeps
 *
 * - I1 The principal is `(tenant, account, session)` handed in by the caller from
 *   the bearer; nothing here reads a request.
 * - I2 A device binds one endpoint to one account, one enrolling session and one
 *   validated storefront origin.
 * - I3 Credentials exist only on `active` rows (every status change below
 *   destroys them in the same statement; the CHECK of sql/1056 backs it).
 * - Registration is idempotent by `(tenant_id, endpoint_hash)` under a row lock;
 *   two concurrent registrations of one endpoint serialise and exactly one
 *   account owns the row afterwards. The per-account device cap is checked under
 *   a lock on the account row, so two concurrent registrations of DIFFERENT
 *   endpoints cannot both slip under it.
 */
import { log } from "../../../lib/logging/logger";
import type { KeyRing } from "../../../lib/security/field-encryption";
import { recordAuditEvent } from "../../logging/application/audit-log";
import {
  hashPushEndpoint,
  maskPushEndpoint,
  normalizePushEndpoint
} from "../../push-delivery/domain/push-endpoint";
import type { PushTarget } from "../../push-delivery/domain/push-provider-contract";
import {
  CUSTOMER_PUSH_MAX_DEVICES,
  deviceCapAllows,
  type CustomerPushErrorCode,
  type CustomerPushStatusReason
} from "../domain/customer-push";
import {
  decryptCustomerPushAuthSecret,
  decryptCustomerPushEndpoint,
  encryptCustomerPushAuthSecret,
  encryptCustomerPushEndpoint
} from "../domain/customer-push-secrets";
import {
  auditPreferences,
  CUSTOMER_PUSH_AUDIT_ACTIONS
} from "./customer-push-audit";
import { cancelPendingMessagesForDevices } from "./customer-push-outbox";
import {
  upsertGrantedPreferences,
  type PreferenceUpsertResult
} from "./customer-push-preferences";

const MODULE_KEY = "commerce";
const RESOURCE_TYPE = "customer_push_device";

export type CustomerPushDeviceView = {
  id: string;
  endpointMasked: string;
  userAgentSummary: string | null;
  status: "active";
  lastSuccessAt: string | null;
  registeredAt: string;
  /** True when the device was enrolled by the caller's CURRENT session. */
  current: boolean;
};

type DeviceRow = {
  id: string;
  endpoint_masked: string;
  user_agent_summary: string | null;
  status: string;
  last_success_at: Date | null;
  registered_at: Date;
  session_id: string | null;
};

function toView(
  row: DeviceRow,
  callerSessionId: string
): CustomerPushDeviceView {
  return {
    id: row.id,
    endpointMasked: row.endpoint_masked,
    userAgentSummary: row.user_agent_summary,
    status: "active",
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    registeredAt: row.registered_at.toISOString(),
    current: row.session_id !== null && row.session_id === callerSessionId
  };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export type RegisterCustomerPushInput = {
  tenantId: string;
  accountId: string;
  /** The session that enrolls the device (from the bearer, never the body). */
  sessionId: string;
  /** The validated storefront origin (ADR-0048 6.3). */
  storefrontOrigin: string;
  /** Already validated by the upstream validator and the host allowlist. */
  endpoint: string;
  p256dhKey: string;
  authSecret: string;
  userAgentSummary: string | null;
  consent: { purposes: readonly string[]; textVersion: string };
  ring: KeyRing;
  correlationId?: string;
};

export type RegisterCustomerPushOutcome =
  | {
      kind: "registered";
      /** True when an existing row moved from another account. */
      transferred: boolean;
      device: CustomerPushDeviceView;
    }
  | { kind: "unchanged"; device: CustomerPushDeviceView }
  | { kind: "device_limit" };

type ExistingRow = {
  id: string;
  account_id: string;
  status: string;
};

const MAX_CONVERGENCE_ATTEMPTS = 3;

/**
 * Registers (or re-registers) the caller's browser. See the file header for the
 * locking. Returns `device_limit` BEFORE writing anything (no consent row, no
 * device) when the account is at its cap and this endpoint is not already one of
 * its active devices.
 */
export async function registerCustomerPushDevice(
  tx: Bun.TransactionSQL,
  input: RegisterCustomerPushInput,
  now: Date = new Date()
): Promise<RegisterCustomerPushOutcome> {
  const { tenantId, accountId } = input;
  const normalized = normalizePushEndpoint(input.endpoint);
  const endpointHash = hashPushEndpoint(normalized);
  const endpointMasked = maskPushEndpoint(normalized);

  const endpointCiphertext = encryptCustomerPushEndpoint(
    normalized,
    tenantId,
    endpointHash,
    input.ring
  );
  const authSecretCiphertext = encryptCustomerPushAuthSecret(
    input.authSecret,
    tenantId,
    endpointHash,
    input.ring
  );

  // Serialises the cap check per account (FOR NO KEY UPDATE does not conflict
  // with the FOR KEY SHARE an FK check takes, so a concurrent insert of THIS
  // account's device still proceeds after the lock is released).
  await tx`
    SELECT id FROM awcms_commerce_customer_accounts
    WHERE tenant_id = ${tenantId} AND id = ${accountId}
    FOR NO KEY UPDATE
  `;

  for (let attempt = 0; attempt < MAX_CONVERGENCE_ATTEMPTS; attempt += 1) {
    const existingRows = (await tx`
      SELECT id, account_id, status
      FROM awcms_commerce_push_devices
      WHERE tenant_id = ${tenantId} AND endpoint_hash = ${endpointHash}
      FOR UPDATE
    `) as ExistingRow[];
    const existing = existingRows[0];

    const alreadyOwnedActive =
      existing !== undefined &&
      existing.account_id === accountId &&
      existing.status === "active";

    if (!alreadyOwnedActive) {
      const others = (await tx`
        SELECT count(*)::int AS n
        FROM awcms_commerce_push_devices
        WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
          AND status = 'active' AND endpoint_hash <> ${endpointHash}
      `) as { n: number }[];

      if (!deviceCapAllows(others[0]?.n ?? 0, CUSTOMER_PUSH_MAX_DEVICES)) {
        return { kind: "device_limit" };
      }
    }

    if (existing === undefined) {
      const inserted = (await tx`
        INSERT INTO awcms_commerce_push_devices
          (tenant_id, account_id, session_id, storefront_origin,
           endpoint_ciphertext, endpoint_hash, endpoint_masked, p256dh_key,
           auth_secret_ciphertext, user_agent_summary,
           registered_at, rebound_at, created_at, updated_at)
        VALUES (
          ${tenantId}, ${accountId}, ${input.sessionId},
          ${input.storefrontOrigin}, ${endpointCiphertext}, ${endpointHash},
          ${endpointMasked}, ${input.p256dhKey}, ${authSecretCiphertext},
          ${input.userAgentSummary}, ${now}, ${now}, ${now}, ${now}
        )
        ON CONFLICT ON CONSTRAINT awcms_commerce_push_devices_endpoint_key
        DO NOTHING
        RETURNING id, endpoint_masked, user_agent_summary, status,
                  last_success_at, registered_at, session_id
      `) as DeviceRow[];

      // Lost the race to a concurrent registration of the same endpoint:
      // loop, lock the winner's row, and treat it as the existing case.
      if (inserted.length === 0) continue;

      const preferences = await upsertGrantedPreferences(
        tx,
        tenantId,
        accountId,
        input.consent.purposes,
        input.consent.textVersion,
        now
      );
      const device = toView(inserted[0]!, input.sessionId);
      await auditRegistration(tx, input, device.id, null, preferences);
      return { kind: "registered", transferred: false, device };
    }

    if (alreadyOwnedActive) {
      // A no-op re-registration (a browser re-issues subscribe() on every page
      // load once permission is granted): refresh the credentials and the
      // enrolling session, record consent, and do NOT audit - it would write one
      // row per page load. The caller learns nothing it did not already know.
      const rows = (await tx`
        UPDATE awcms_commerce_push_devices
        SET session_id = ${input.sessionId},
            storefront_origin = ${input.storefrontOrigin},
            endpoint_ciphertext = ${endpointCiphertext},
            p256dh_key = ${input.p256dhKey},
            auth_secret_ciphertext = ${authSecretCiphertext},
            user_agent_summary = ${input.userAgentSummary},
            updated_at = ${now}
        WHERE tenant_id = ${tenantId} AND id = ${existing.id}
        RETURNING id, endpoint_masked, user_agent_summary, status,
                  last_success_at, registered_at, session_id
      `) as DeviceRow[];

      const preferences = await upsertGrantedPreferences(
        tx,
        tenantId,
        accountId,
        input.consent.purposes,
        input.consent.textVersion,
        now
      );
      if (preferences.changed.length > 0) {
        await auditPreferences(
          tx,
          tenantId,
          accountId,
          preferences,
          input.correlationId
        );
      }
      return { kind: "unchanged", device: toView(rows[0]!, input.sessionId) };
    }

    // The row exists but is held by ANOTHER account (a transfer) or is the
    // caller's own tombstone (a revival). Either way the caller newly owns an
    // active device afterwards.
    const transferred = existing.account_id !== accountId;
    const rows = (await tx`
      UPDATE awcms_commerce_push_devices
      SET account_id = ${accountId},
          session_id = ${input.sessionId},
          storefront_origin = ${input.storefrontOrigin},
          endpoint_ciphertext = ${endpointCiphertext},
          p256dh_key = ${input.p256dhKey},
          auth_secret_ciphertext = ${authSecretCiphertext},
          user_agent_summary = ${input.userAgentSummary},
          status = 'active', status_reason = NULL, revoked_at = NULL,
          failure_count = 0, rebound_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${tenantId} AND id = ${existing.id}
      RETURNING id, endpoint_masked, user_agent_summary, status,
                last_success_at, registered_at, session_id
    `) as DeviceRow[];

    // Whoever held the device before: nothing addressed to them may reach it.
    await cancelPendingMessagesForDevices(
      tx,
      tenantId,
      [existing.id],
      "device_transferred"
    );

    const preferences = await upsertGrantedPreferences(
      tx,
      tenantId,
      accountId,
      input.consent.purposes,
      input.consent.textVersion,
      now
    );
    const device = toView(rows[0]!, input.sessionId);
    await auditRegistration(
      tx,
      input,
      device.id,
      transferred ? existing.account_id : null,
      preferences
    );
    return { kind: "registered", transferred, device };
  }

  throw new Error("Customer push device registration did not converge.");
}

async function auditRegistration(
  tx: Bun.TransactionSQL,
  input: RegisterCustomerPushInput,
  deviceId: string,
  previousAccountId: string | null,
  preferences: PreferenceUpsertResult
): Promise<void> {
  const { tenantId, accountId } = input;

  if (previousAccountId !== null) {
    // Ids only: never the endpoint, the keys or the secret. A failed audit write
    // rolls the whole registration back.
    await recordAuditEvent(tx, {
      tenantId,
      moduleKey: MODULE_KEY,
      action: CUSTOMER_PUSH_AUDIT_ACTIONS.transferred,
      resourceType: RESOURCE_TYPE,
      resourceId: deviceId,
      severity: "warning",
      message:
        "A customer push device moved to another account because the same browser endpoint was registered again.",
      attributes: { deviceId, previousAccountId, accountId },
      correlationId: input.correlationId
    });
    log("info", "commerce.customer_push.device_transferred", {
      tenantId,
      moduleKey: MODULE_KEY,
      deviceId
    });
  }

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: MODULE_KEY,
    action: CUSTOMER_PUSH_AUDIT_ACTIONS.registered,
    resourceType: RESOURCE_TYPE,
    resourceId: deviceId,
    message: "A customer push device was registered.",
    attributes: {
      deviceId,
      accountId,
      sessionId: input.sessionId,
      transferred: previousAccountId !== null
    },
    correlationId: input.correlationId
  });

  if (preferences.changed.length > 0) {
    await auditPreferences(
      tx,
      tenantId,
      accountId,
      preferences,
      input.correlationId
    );
  }
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** The caller's ACTIVE devices, newest first. Never selects a credential. */
export async function listOwnCustomerPushDevices(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  callerSessionId: string
): Promise<CustomerPushDeviceView[]> {
  const rows = (await tx`
    SELECT id, endpoint_masked, user_agent_summary, status, last_success_at,
           registered_at, session_id
    FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND status = 'active'
    ORDER BY registered_at DESC, id DESC
    LIMIT ${CUSTOMER_PUSH_MAX_DEVICES}
  `) as DeviceRow[];

  return rows.map((row) => toView(row, callerSessionId));
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export type TombstoneStatus = "revoked" | "gone" | "disabled";

/**
 * The one place a device leaves `active`: sets the status and reason, stamps
 * `revoked_at` (the retention cursor) and DESTROYS the credentials in the same
 * statement (I3), then cancels the devices' waiting messages. `ids` are
 * caller-selected rows already locked or owned; the `status = 'active'`
 * predicate makes a second call a no-op. Returns the ids actually tombstoned.
 */
export async function tombstoneCustomerPushDevices(
  tx: Bun.SQL,
  tenantId: string,
  ids: readonly string[],
  status: TombstoneStatus,
  reason: CustomerPushStatusReason,
  cancelReason: CustomerPushErrorCode,
  now: Date = new Date()
): Promise<string[]> {
  if (ids.length === 0) return [];

  const rows = (await tx`
    UPDATE awcms_commerce_push_devices
    SET status = ${status}, status_reason = ${reason}, revoked_at = ${now},
        endpoint_ciphertext = NULL, p256dh_key = NULL,
        auth_secret_ciphertext = NULL, updated_at = ${now}
    WHERE tenant_id = ${tenantId} AND status = 'active'
      AND id = ANY(${tx.array([...ids], "uuid")}::uuid[])
    RETURNING id
  `) as { id: string }[];

  const tombstoned = rows.map((row) => row.id);
  await cancelPendingMessagesForDevices(tx, tenantId, tombstoned, cancelReason);
  return tombstoned;
}

async function auditRevocation(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string | null,
  deviceIds: readonly string[],
  reason: CustomerPushStatusReason,
  correlationId?: string
): Promise<void> {
  if (deviceIds.length === 0) return;

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: MODULE_KEY,
    action: CUSTOMER_PUSH_AUDIT_ACTIONS.revoked,
    resourceType: RESOURCE_TYPE,
    resourceId: deviceIds.length === 1 ? deviceIds[0] : undefined,
    message: "Customer push device(s) revoked.",
    attributes: { deviceIds, accountId, reason },
    correlationId
  });
}

/**
 * Revokes ONE of the caller's own devices. Ownership is enforced inside the
 * WHERE (`id AND account_id = caller AND active`), so "absent", "someone else's"
 * and "already revoked" are indistinguishable to the caller: all return `false`.
 */
export async function revokeOwnCustomerPushDevice(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  deviceId: string,
  correlationId?: string,
  now: Date = new Date()
): Promise<boolean> {
  const owned = (await tx`
    SELECT id FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND id = ${deviceId}
      AND account_id = ${accountId} AND status = 'active'
    FOR UPDATE
  `) as { id: string }[];

  if (owned.length === 0) return false;

  const ids = await tombstoneCustomerPushDevices(
    tx,
    tenantId,
    [deviceId],
    "revoked",
    "customer_removed",
    "device_revoked",
    now
  );
  await auditRevocation(
    tx,
    tenantId,
    accountId,
    ids,
    "customer_removed",
    correlationId
  );
  return ids.length > 0;
}

/** Revokes every active device of the caller's account. Returns how many. */
export async function revokeAllOwnCustomerPushDevices(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  correlationId?: string,
  now: Date = new Date()
): Promise<number> {
  const owned = (await tx`
    SELECT id FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND status = 'active'
    FOR UPDATE
  `) as { id: string }[];

  const ids = await tombstoneCustomerPushDevices(
    tx,
    tenantId,
    owned.map((row) => row.id),
    "revoked",
    "customer_removed",
    "device_revoked",
    now
  );
  await auditRevocation(
    tx,
    tenantId,
    accountId,
    ids,
    "customer_removed",
    correlationId
  );
  return ids.length;
}

/**
 * Logout (ADR-0048 5.3): revokes every device the logging-out SESSION enrolled,
 * in the transaction that revokes the session, so a failure leaves both or
 * neither. A device another session of the same account enrolled is untouched.
 */
export async function revokeCustomerPushDevicesOfSession(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  correlationId?: string,
  now: Date = new Date()
): Promise<number> {
  const owned = (await tx`
    SELECT id, account_id FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND session_id = ${sessionId}
      AND status = 'active'
    FOR UPDATE
  `) as { id: string; account_id: string }[];

  const ids = await tombstoneCustomerPushDevices(
    tx,
    tenantId,
    owned.map((row) => row.id),
    "revoked",
    "logout",
    "logout",
    now
  );
  await auditRevocation(
    tx,
    tenantId,
    owned[0]?.account_id ?? null,
    ids,
    "logout",
    correlationId
  );
  return ids.length;
}

/** Block path (ADR-0048 5.3, T12): a blocked account keeps no device. */
export async function revokeCustomerPushDevicesOfAccount(
  tx: Bun.SQL,
  tenantId: string,
  accountId: string,
  reason: Extract<
    CustomerPushStatusReason,
    "account_blocked" | "account_erased"
  >,
  correlationId?: string,
  now: Date = new Date()
): Promise<number> {
  const owned = (await tx`
    SELECT id FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND status = 'active'
    FOR UPDATE
  `) as { id: string }[];

  const ids = await tombstoneCustomerPushDevices(
    tx,
    tenantId,
    owned.map((row) => row.id),
    "revoked",
    reason,
    reason,
    now
  );
  await auditRevocation(tx, tenantId, accountId, ids, reason, correlationId);
  return ids.length;
}

/**
 * Block path for the admin's customer block (`PATCH /api/v1/commerce/customers/
 * {id}` with `status: "blocked"`): revokes the devices of the account bound to
 * that customer row. The maintenance sweep is the backstop for a block set any
 * other way (an account's own `status`, or the customer row edited directly).
 */
export async function revokeCustomerPushDevicesOfCustomer(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  correlationId?: string,
  now: Date = new Date()
): Promise<number> {
  const owned = (await tx`
    SELECT d.id, d.account_id
    FROM awcms_commerce_push_devices d
    JOIN awcms_commerce_customer_accounts a
      ON a.tenant_id = d.tenant_id AND a.id = d.account_id
    WHERE d.tenant_id = ${tenantId} AND a.customer_id = ${customerId}
      AND d.status = 'active'
    FOR UPDATE OF d
  `) as { id: string; account_id: string }[];

  const ids = await tombstoneCustomerPushDevices(
    tx,
    tenantId,
    owned.map((row) => row.id),
    "revoked",
    "account_blocked",
    "account_blocked",
    now
  );
  await auditRevocation(
    tx,
    tenantId,
    owned[0]?.account_id ?? null,
    ids,
    "account_blocked",
    correlationId
  );
  return ids.length;
}

// ---------------------------------------------------------------------------
// Delivery target (for the dispatcher, #432)
// ---------------------------------------------------------------------------

export type CustomerPushDeliveryTarget = {
  deviceId: string;
  /** The device's CURRENT owner: the dispatcher compares it with the message's account (I5). */
  accountId: string;
  sessionId: string | null;
  storefrontOrigin: string;
  target: PushTarget;
};

/**
 * Decrypts an ACTIVE device into the upstream provider's `PushTarget`. This is
 * the single read of the raw endpoint and auth secret. `null` when the device is
 * absent or not active. Throws a `FieldEncryptionError` when the ciphertext cannot
 * be read (wrong ring, tampered, wrong tenant or endpoint): the caller treats any
 * throw as "cannot decrypt" and falls back to nothing. Decrypt OUTSIDE the
 * claim/finalize transactions, immediately before the provider call.
 */
export async function loadCustomerPushDeliveryTarget(
  tx: Bun.SQL,
  tenantId: string,
  deviceId: string,
  ring: KeyRing
): Promise<CustomerPushDeliveryTarget | null> {
  const rows = (await tx`
    SELECT id, account_id, session_id, storefront_origin, endpoint_hash,
           endpoint_masked, endpoint_ciphertext, p256dh_key,
           auth_secret_ciphertext
    FROM awcms_commerce_push_devices
    WHERE tenant_id = ${tenantId} AND id = ${deviceId} AND status = 'active'
  `) as {
    id: string;
    account_id: string;
    session_id: string | null;
    storefront_origin: string;
    endpoint_hash: string;
    endpoint_masked: string;
    endpoint_ciphertext: string | null;
    p256dh_key: string | null;
    auth_secret_ciphertext: string | null;
  }[];

  const row = rows[0];
  if (
    !row ||
    row.endpoint_ciphertext === null ||
    row.p256dh_key === null ||
    row.auth_secret_ciphertext === null
  ) {
    return null;
  }

  return {
    deviceId: row.id,
    accountId: row.account_id,
    sessionId: row.session_id,
    storefrontOrigin: row.storefront_origin,
    target: {
      transport: "web_push",
      endpoint: decryptCustomerPushEndpoint(
        row.endpoint_ciphertext,
        tenantId,
        row.endpoint_hash,
        ring
      ),
      endpointMasked: row.endpoint_masked,
      p256dhKey: row.p256dh_key,
      authSecret: decryptCustomerPushAuthSecret(
        row.auth_secret_ciphertext,
        tenantId,
        row.endpoint_hash,
        ring
      )
    }
  };
}
