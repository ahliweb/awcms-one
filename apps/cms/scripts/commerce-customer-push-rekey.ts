/**
 * commerce-customer-push-rekey.ts - `bun run commerce:customer-push:rekey`
 * (Issue #430, ADR-0048 Q2). The key-rotation action for customer push
 * credentials: re-encrypts every active device's endpoint and auth-secret
 * ciphertext whose key id is not the ACTIVE (first) key of
 * `PUSH_AUTH_SECRET_ENCRYPTION_KEYS`, so an old key can be retired. The ring must
 * still contain the old key (all keys read, the first writes).
 *
 * Upstream's `push:auth-secret:backfill --rekey` covers only upstream's own table;
 * run both. Same guarantees as upstream's: idempotent, resumable, batched, worker
 * role, no key material or ciphertext in any output. Refuses to run (exit 1)
 * without the key ring - converting nothing and reporting success would let an
 * operator believe the rotation finished. Exits 2 when a tenant did not finish, 3
 * when rows could not be decrypted under the ring (reported as a count, left
 * untouched).
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { rekeyCustomerPushCredentialsForTenant } from "../src/modules/commerce/application/customer-push-rekey";
import { resolvePushAuthSecretRing } from "../src/modules/push-delivery/domain/push-auth-secret";

type TenantRow = { id: string };

async function main() {
  const label = "commerce:customer-push:rekey";
  const ring = resolvePushAuthSecretRing(process.env);

  if (!ring.ok) {
    console.error(
      `${label} REFUSED - ${ring.reason} Set PUSH_AUTH_SECRET_ENCRYPTION_KEYS first.`
    );
    process.exitCode = 1;
    return;
  }

  const sql = getWorkerDatabaseClient();
  const correlationId = crypto.randomUUID();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_tenants ORDER BY id
    `) as TenantRow[];

    let converted = 0;
    let failed = 0;
    let incomplete = 0;

    for (const tenant of tenants) {
      const result = await rekeyCustomerPushCredentialsForTenant(
        sql,
        tenant.id,
        ring,
        { correlationId }
      );

      converted += result.converted;
      failed += result.failed;
      if (!result.complete) incomplete += 1;
    }

    console.log(
      `${label} complete - correlationId=${correlationId} ` +
        `tenants=${tenants.length} converted=${converted} ` +
        `undecryptable=${failed} incompleteTenants=${incomplete}`
    );

    if (incomplete > 0) {
      process.exitCode = 2;
    } else if (failed > 0) {
      process.exitCode = 3;
    }
  } catch (error) {
    logScriptFailure(`${label} FAILED`, error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
