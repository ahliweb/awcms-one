/**
 * commerce-flash-sales-tick.ts — `bun run commerce:flash-sales:tick` (Issue
 * #26). Internal worker entrypoint, not exposed over HTTP, run on a schedule
 * (cron/systemd timer — `module.ts`'s `jobs` descriptor: every 1-5 minutes).
 *
 * For every active tenant, recomputes every non-draft, non-ended flash sale
 * against `now()` (`domain/flash-sale-status.ts`'s `deriveFlashSaleStatus`)
 * and persists the derived status when it changed, firing
 * `commerce.flash_sale.started`/`.ended` on the transition. Built on the
 * shared worker runner (`../src/lib/jobs/job-runner.ts`), the current
 * convention for a new job in this base — same shape
 * `blog-scheduled-publish.ts` follows.
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
import { tickFlashSalesForTenant } from "../src/modules/commerce/application/flash-sale-directory";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:flash-sales:tick",
        description:
          "Recomputes every active tenant's non-draft, non-ended flash sales against now() and persists the derived status, firing commerce.flash_sale.started/.ended on the transition.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                started: 0,
                ended: 0,
                partialTenants: 0
              },
              detail: "dry-run: no flash sale status was changed."
            };
          }

          let totalStarted = 0;
          let totalEnded = 0;
          let partialTenants = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await tickFlashSalesForTenant(
              sql,
              tenant.id,
              new Date(),
              ctx.correlationId
            );

            totalStarted += tenantResult.startedCount;
            totalEnded += tenantResult.endedCount;

            if (tenantResult.partial) {
              // This tenant had a full batch this run; its remaining rows
              // are picked up on the next scheduled tick (idempotent).
              partialTenants += 1;
            }
          }

          return {
            status: partialTenants > 0 ? "partial" : "success",
            itemCounts: {
              tenantsChecked: tenants.length,
              started: totalStarted,
              ended: totalEnded,
              partialTenants
            },
            detail:
              partialTenants > 0
                ? `${partialTenants} tenant(s) still had a flash-sale backlog remaining after this run's batch bound.`
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
