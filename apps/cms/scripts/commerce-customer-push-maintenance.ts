/**
 * commerce-customer-push-maintenance.ts - `bun run commerce:customer-push:maintenance`
 * (Issue #430, ADR-0048 sections 5.3 and 5.7). Internal worker entrypoint, not
 * exposed over HTTP, run on a schedule (`module.ts`'s `jobs` descriptor).
 *
 * For every active tenant: revokes the customer push devices of ended sessions and
 * blocked accounts (destroying their stored credentials), then purges tombstoned
 * devices, terminal messages and attempts past the 30-day retention window
 * (`application/customer-push-maintenance.ts`). It does not depend on the
 * `customerPush` feature being on: rows from an earlier period still need
 * removing. Needs no encryption key and makes no network call.
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
import { purgeCustomerPushForTenant } from "../src/modules/commerce/application/customer-push-maintenance";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:customer-push:maintenance",
        description:
          "Revokes customer push devices of ended sessions and blocked accounts, and purges tombstones, terminal messages and attempts past retention, in every active tenant.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                expiredMessages: 0,
                sweptSessionEnded: 0,
                sweptAccountBlocked: 0,
                purgedDevices: 0,
                purgedMessages: 0,
                purgedAttempts: 0
              },
              detail: "dry-run: no row was changed or deleted."
            };
          }

          const totals = {
            expiredMessages: 0,
            sweptSessionEnded: 0,
            sweptAccountBlocked: 0,
            purgedDevices: 0,
            purgedMessages: 0,
            purgedAttempts: 0
          };

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await purgeCustomerPushForTenant(
              sql,
              tenant.id,
              { now: new Date() }
            );

            totals.expiredMessages += tenantResult.expiredMessages;
            totals.sweptSessionEnded += tenantResult.sweptSessionEnded;
            totals.sweptAccountBlocked += tenantResult.sweptAccountBlocked;
            totals.purgedDevices += tenantResult.purgedDevices;
            totals.purgedMessages += tenantResult.purgedMessages;
            totals.purgedAttempts += tenantResult.purgedAttempts;
          }

          return {
            status: "success" as const,
            itemCounts: { tenantsChecked: tenants.length, ...totals }
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
