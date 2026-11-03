/**
 * Key re-encryption for customer push credentials (Issue #430, ADR-0048 Q2 and
 * section 9 "Key rotation"). Upstream's re-key command covers only upstream's own
 * table (`awcms_push_subscriptions`); a customer device's two ciphertexts live in
 * `awcms_commerce_push_devices` under a different AAD purpose each, so
 * commerce ships its own, built on the same contract.
 *
 * Runbook: prepend a NEW key to `PUSH_AUTH_SECRET_ENCRYPTION_KEYS` (the first
 * key writes, every key reads), deploy, run `bun run commerce:customer-push:rekey`
 * (and upstream's `push:auth-secret:backfill --rekey`) until
 * {@link countCustomerPushCredentialsByKeyId} shows no row under the old key id,
 * and only then retire the old key.
 *
 * - **Idempotent.** The work predicate is "an active device with a ciphertext not
 *   under the active key id"; a re-keyed row no longer matches.
 * - **Resumable and batched.** Progress is the data; a keyset cursor skips a row
 *   that cannot be converted within one run; one transaction per batch.
 * - **Race-safe.** Rows are read `FOR UPDATE` and the UPDATE is a compare-and-swap
 *   on BOTH old ciphertexts, so a concurrent re-registration wins and is never
 *   overwritten with a stale credential.
 * - **Fail visible.** A row that cannot be decrypted under the ring (its key was
 *   already dropped, or authentication fails) is counted in `failed` and left
 *   untouched, never silently "fixed".
 * - **Nothing secret leaves.** No plaintext, ciphertext or key reaches a log, a
 *   result or an error; only counts.
 *
 * Runs as `awcms_worker`; its UPDATE of the two ciphertext columns is allowed
 * only while the device stays active (the guard of sql/1058).
 */
import { withTenantOrThrow } from "../../../lib/database/tenant-context";
import type { KeyRing } from "../../../lib/security/field-encryption";
import { log } from "../../../lib/logging/logger";
import {
  decryptCustomerPushAuthSecret,
  decryptCustomerPushEndpoint,
  encryptCustomerPushAuthSecret,
  encryptCustomerPushEndpoint
} from "../domain/customer-push-secrets";

export const CUSTOMER_PUSH_REKEY_DEFAULT_LIMIT = 200;

export type RekeyCustomerPushResult = {
  converted: number;
  failed: number;
  complete: boolean;
  lastId: string | null;
};

type DeviceCredentialRow = {
  id: string;
  endpoint_hash: string;
  endpoint_ciphertext: string;
  auth_secret_ciphertext: string;
};

export async function rekeyCustomerPushCredentialsBatch(
  sql: Bun.SQL,
  tenantId: string,
  ring: KeyRing,
  options: { afterId?: string | null; limit?: number } = {}
): Promise<RekeyCustomerPushResult> {
  const limit = options.limit ?? CUSTOMER_PUSH_REKEY_DEFAULT_LIMIT;
  const afterId = options.afterId ?? null;
  const activeKeyId = ring.keys[0]!.id;

  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const rows = (await tx`
        SELECT id, endpoint_hash, endpoint_ciphertext, auth_secret_ciphertext
        FROM awcms_commerce_push_devices
        WHERE tenant_id = ${tenantId} AND status = 'active'
          AND (split_part(endpoint_ciphertext, ':', 2) <> ${activeKeyId}
               OR split_part(auth_secret_ciphertext, ':', 2) <> ${activeKeyId})
          AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
        ORDER BY id
        LIMIT ${limit}
        FOR UPDATE
      `) as DeviceCredentialRow[];

      let converted = 0;
      let failed = 0;

      for (const row of rows) {
        let freshEndpoint: string;
        let freshAuth: string;

        try {
          freshEndpoint = encryptCustomerPushEndpoint(
            decryptCustomerPushEndpoint(
              row.endpoint_ciphertext,
              tenantId,
              row.endpoint_hash,
              ring
            ),
            tenantId,
            row.endpoint_hash,
            ring
          );
          freshAuth = encryptCustomerPushAuthSecret(
            decryptCustomerPushAuthSecret(
              row.auth_secret_ciphertext,
              tenantId,
              row.endpoint_hash,
              ring
            ),
            tenantId,
            row.endpoint_hash,
            ring
          );
        } catch {
          failed += 1;
          continue;
        }

        const updated = (await tx`
          UPDATE awcms_commerce_push_devices
          SET endpoint_ciphertext = ${freshEndpoint},
              auth_secret_ciphertext = ${freshAuth},
              updated_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${row.id}
            AND status = 'active'
            AND endpoint_ciphertext = ${row.endpoint_ciphertext}
            AND auth_secret_ciphertext = ${row.auth_secret_ciphertext}
          RETURNING id
        `) as { id: string }[];

        converted += updated.length;
      }

      return {
        converted,
        failed,
        complete: rows.length < limit,
        lastId: rows.length > 0 ? rows[rows.length - 1]!.id : afterId
      };
    },
    { workClass: "maintenance" }
  );
}

/** Drains one tenant's re-key until nothing remains or `maxBatches` is hit. */
export async function rekeyCustomerPushCredentialsForTenant(
  sql: Bun.SQL,
  tenantId: string,
  ring: KeyRing,
  options: { limit?: number; maxBatches?: number; correlationId?: string } = {}
): Promise<{ converted: number; failed: number; complete: boolean }> {
  const maxBatches = options.maxBatches ?? 1000;
  let converted = 0;
  let failed = 0;
  let afterId: string | null = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result: RekeyCustomerPushResult =
      await rekeyCustomerPushCredentialsBatch(sql, tenantId, ring, {
        afterId,
        ...(options.limit === undefined ? {} : { limit: options.limit })
      });

    converted += result.converted;
    failed += result.failed;
    afterId = result.lastId;

    if (result.complete) {
      if (converted > 0 || failed > 0) {
        log("info", "commerce.customer_push.rekeyed", {
          tenantId,
          moduleKey: "commerce",
          converted,
          failed,
          ...(options.correlationId
            ? { correlationId: options.correlationId }
            : {})
        });
      }
      return { converted, failed, complete: true };
    }
  }

  return { converted, failed, complete: false };
}

/**
 * Active devices per ciphertext key id for one tenant (counts only; never a
 * value). The endpoint ciphertext and the auth-secret ciphertext are counted
 * separately; a value that is not a `v2` envelope is bucketed under `"?"`.
 */
export async function countCustomerPushCredentialsByKeyId(
  sql: Bun.SQL,
  tenantId: string
): Promise<{
  endpoint: Record<string, number>;
  authSecret: Record<string, number>;
}> {
  return withTenantOrThrow(
    sql,
    tenantId,
    async (tx) => {
      const endpointRows = (await tx`
        SELECT CASE WHEN endpoint_ciphertext ~ '^v2:[a-z0-9]{1,8}:'
                    THEN split_part(endpoint_ciphertext, ':', 2) ELSE '?' END AS key_id,
               count(*)::int AS n
        FROM awcms_commerce_push_devices
        WHERE tenant_id = ${tenantId} AND status = 'active'
        GROUP BY 1
      `) as { key_id: string; n: number }[];

      const authRows = (await tx`
        SELECT CASE WHEN auth_secret_ciphertext ~ '^v2:[a-z0-9]{1,8}:'
                    THEN split_part(auth_secret_ciphertext, ':', 2) ELSE '?' END AS key_id,
               count(*)::int AS n
        FROM awcms_commerce_push_devices
        WHERE tenant_id = ${tenantId} AND status = 'active'
        GROUP BY 1
      `) as { key_id: string; n: number }[];

      const toRecord = (rows: { key_id: string; n: number }[]) =>
        Object.fromEntries(rows.map((row) => [row.key_id, row.n]));

      return {
        endpoint: toRecord(endpointRows),
        authSecret: toRecord(authRows)
      };
    },
    { workClass: "maintenance" }
  );
}
