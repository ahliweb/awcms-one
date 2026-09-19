/**
 * commerce-whatsapp-purge.ts — `bun run commerce:whatsapp:purge` (Issue
 * #108). Internal worker entrypoint, not exposed over HTTP, run on a
 * schedule (`module.ts`'s `jobs` descriptor).
 *
 * For every active tenant, deletes terminal (`sent`/`failed`)
 * `awcms_commerce_whatsapp_messages` rows and
 * `awcms_commerce_whatsapp_delivery_attempts` rows past their own retention
 * window (`application/whatsapp-queue-purge.ts`). Same job-runner shape
 * `commerce-customer-auth-purge.ts` already follows for this module's other
 * scheduled purge.
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
import { purgeWhatsappQueue } from "../src/modules/commerce/application/whatsapp-queue-purge";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:whatsapp:purge",
        description:
          "Deletes terminal (sent/failed) WhatsApp outbox messages and delivery attempts past their retention window, in every active tenant.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                purgedMessages: 0,
                purgedAttempts: 0
              },
              detail: "dry-run: no row was deleted."
            };
          }

          let totalMessages = 0;
          let totalAttempts = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await purgeWhatsappQueue(sql, tenant.id, {
              now: new Date()
            });

            totalMessages += tenantResult.purgedMessages;
            totalAttempts += tenantResult.purgedAttempts;
          }

          return {
            status: "success" as const,
            itemCounts: {
              tenantsChecked: tenants.length,
              purgedMessages: totalMessages,
              purgedAttempts: totalAttempts
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
