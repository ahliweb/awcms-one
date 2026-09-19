/**
 * commerce-customer-auth-purge.ts — `bun run commerce:customer-auth:purge`
 * (Issue #87, C1). Internal worker entrypoint, not exposed over HTTP, run on
 * a schedule (cron/systemd timer — `module.ts`'s `jobs` descriptor: every
 * 5-15 minutes).
 *
 * For every active tenant, deletes every expired
 * `awcms_commerce_customer_otps` row and every `awcms_commerce_customer_sessions`
 * row that is either expired or revoked more than 7 days ago. Built on the
 * shared worker runner, the same shape `commerce-orders-expire.ts` already
 * follows for this module's other scheduled job.
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
import { purgeCustomerAuthForTenant } from "../src/modules/commerce/application/customer-account-store";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:customer-auth:purge",
        description:
          "Deletes every expired customer OTP and every expired or revoked-more-than-7-days-ago customer session, in every active tenant.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                otpsDeleted: 0,
                sessionsDeleted: 0
              },
              detail: "dry-run: no row was deleted."
            };
          }

          let totalOtps = 0;
          let totalSessions = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await purgeCustomerAuthForTenant(
              sql,
              tenant.id,
              new Date()
            );

            totalOtps += tenantResult.otpsDeleted;
            totalSessions += tenantResult.sessionsDeleted;
          }

          return {
            status: "success" as const,
            itemCounts: {
              tenantsChecked: tenants.length,
              otpsDeleted: totalOtps,
              sessionsDeleted: totalSessions
            }
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
