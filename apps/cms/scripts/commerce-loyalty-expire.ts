/**
 * commerce-loyalty-expire.ts — `bun run commerce:loyalty:expire` (Issue #289).
 * Internal worker entrypoint, not exposed over HTTP, run on a schedule
 * (cron/systemd timer — `module.ts`'s `jobs` descriptor: hourly).
 *
 * For every active tenant, appends an `expire` entry to the loyalty ledger for
 * each earn lot whose `expires_at` has passed (a zero-point marker for a lot
 * that was already fully spent), so the expired points leave the balance. Never
 * an UPDATE or DELETE — the ledger is append-only — and idempotent: a lot
 * with an `expire` row is anti-joined out of the next scan. Built on the shared
 * worker runner, the same shape `commerce-orders-expire.ts` follows.
 *
 * Correctness does not depend on this job's cadence: a redemption, adjustment
 * or reversal expires the account's due lots itself, under the account lock,
 * before it acts. This job keeps balances and reports current for accounts
 * nobody is touching.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import { fetchActiveTenants } from "../src/lib/jobs/batching";
import { expireDueLoyaltyPointsForTenant } from "../src/modules/commerce/application/loyalty-ledger";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:loyalty:expire",
        description:
          "Appends an expire ledger entry for every loyalty earn lot past its expires_at in every active tenant (zero-point marker for an already-spent lot). Append-only and idempotent.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                accountsProcessed: 0,
                entriesWritten: 0,
                partialTenants: 0
              },
              detail: "dry-run: no loyalty entry was expired."
            };
          }

          let accountsProcessed = 0;
          let entriesWritten = 0;
          let partialTenants = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await expireDueLoyaltyPointsForTenant(
              sql,
              tenant.id,
              new Date(),
              ctx.correlationId
            );

            accountsProcessed += tenantResult.accountsProcessed;
            entriesWritten += tenantResult.entriesWritten;
            if (tenantResult.partial) partialTenants += 1;
          }

          return {
            status: partialTenants > 0 ? "partial" : "success",
            itemCounts: {
              tenantsChecked: tenants.length,
              accountsProcessed,
              entriesWritten,
              partialTenants
            },
            detail:
              partialTenants > 0
                ? `${partialTenants} tenant(s) still had expiring accounts remaining after this run's batch bound.`
                : undefined
          };
        }
      },
      { sql, dryRun: cliOptions.dryRun }
    );

    printJobTelemetry(result);
    await writeJobTelemetry(result, cliOptions.jsonOutputPath);

    if (!isJobResultOk(result)) {
      console.error(formatJobOutcomeLine(result));
    }

    applyJobExitCode(result);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
