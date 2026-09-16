/**
 * commerce-orders-expire.ts — `bun run commerce:orders:expire` (Issue #29).
 * Internal worker entrypoint, not exposed over HTTP, run on a schedule
 * (cron/systemd timer — `module.ts`'s `jobs` descriptor: every 1-5 minutes).
 *
 * For every active tenant, moves every `pending_payment` order whose
 * `expires_at` has elapsed to `expired`, restocking its line items and
 * un-redeeming its voucher (if any). Built on the shared worker runner, the
 * same shape `commerce-flash-sales-tick.ts` already follows for this
 * module's other scheduled job.
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
import { expireOrdersForTenant } from "../src/modules/commerce/application/order-directory";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:orders:expire",
        description:
          "Moves every pending_payment order in every active tenant whose expires_at has elapsed to expired, restocking its line items and un-redeeming its voucher.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                expired: 0,
                partialTenants: 0
              },
              detail: "dry-run: no order was expired."
            };
          }

          let totalExpired = 0;
          let partialTenants = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await expireOrdersForTenant(
              sql,
              tenant.id,
              new Date(),
              ctx.correlationId
            );

            totalExpired += tenantResult.expiredCount;
            if (tenantResult.partial) partialTenants += 1;
          }

          return {
            status: partialTenants > 0 ? "partial" : "success",
            itemCounts: {
              tenantsChecked: tenants.length,
              expired: totalExpired,
              partialTenants
            },
            detail:
              partialTenants > 0
                ? `${partialTenants} tenant(s) still had an expiry backlog remaining after this run's batch bound.`
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
