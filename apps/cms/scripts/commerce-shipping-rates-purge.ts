/**
 * commerce-shipping-rates-purge.ts — `bun run commerce:shipping-rates:purge`
 * (Issue #107). Internal worker entrypoint, not exposed over HTTP, run on a
 * schedule (`module.ts`'s `jobs` descriptor).
 *
 * Deletes every EXPIRED `awcms_commerce_shipping_rates` row, per active
 * tenant, bounded per tick — the same shape `commerce-orders-expire.ts`
 * already follows for this module's other scheduled job. No external
 * provider call: a pure DELETE, safe in any deployment profile.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  printJobTelemetry,
  runJob,
  writeJobTelemetry,
  parseJobCliArgs
} from "../src/lib/jobs/job-runner";
import { fetchActiveTenants } from "../src/lib/jobs/batching";
import { purgeExpiredShippingRatesForTenant } from "../src/modules/commerce/application/shipping-rate-directory";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:shipping-rates:purge",
        description:
          "Deletes every expired awcms_commerce_shipping_rates row across all active tenants.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: { tenantsChecked: tenants.length, purged: 0 },
              detail: "dry-run: no row was purged."
            };
          }

          let totalPurged = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            totalPurged += await purgeExpiredShippingRatesForTenant(
              sql,
              tenant.id,
              new Date()
            );
          }

          return {
            status: "success" as const,
            itemCounts: { tenantsChecked: tenants.length, purged: totalPurged }
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
