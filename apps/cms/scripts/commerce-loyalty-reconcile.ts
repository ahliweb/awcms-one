/**
 * commerce-loyalty-reconcile.ts — `bun run commerce:loyalty:reconcile`
 * (Issue #289). Internal worker entrypoint, not exposed over HTTP, run daily.
 *
 * READ-ONLY. For every active tenant it recomputes each loyalty account's
 * balance from the append-only ledger and reports (a) any account whose
 * projected `balance`/`version` disagrees with the ledger and (b) any ledger
 * row whose running `balance_after` is not the running sum. It never writes:
 * the worker role has no UPDATE on the ledger and this script does not ask for
 * one. Repair of a drifted PROJECTION is the authenticated, audited
 * `POST /api/v1/commerce/loyalty/reconcile` with `repair: true`; a ledger break
 * has no automatic repair at all (an append-only table that disagrees with
 * itself needs a human).
 *
 * Exits non-zero (`status: "partial"`) when anything is found, so the
 * scheduler's failure path surfaces it instead of a green run hiding drift.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { withTenantOrThrow } from "../src/lib/database/tenant-context";
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
import { reconcileLoyaltyForTenant } from "../src/modules/commerce/application/loyalty-ledger";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:loyalty:reconcile",
        description:
          "Recomputes every active tenant's loyalty balances from the ledger and reports projection drift and ledger running-balance breaks. Read-only.",
        handler: async (ctx) => {
          const tenants = await fetchActiveTenants(sql);

          let accountsChecked = 0;
          let driftedAccounts = 0;
          let ledgerBreakAccounts = 0;
          const affectedTenants: string[] = [];

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const report = await withTenantOrThrow(
              sql,
              tenant.id,
              (tx) =>
                reconcileLoyaltyForTenant(tx, tenant.id, {
                  repair: false,
                  correlationId: ctx.correlationId
                }),
              { workClass: "background_sync" }
            );

            accountsChecked += report.accountsChecked;
            driftedAccounts += report.drifted.length;
            ledgerBreakAccounts += report.ledgerBreaks.length;
            if (report.drifted.length > 0 || report.ledgerBreaks.length > 0) {
              affectedTenants.push(tenant.id);
            }
          }

          const clean = affectedTenants.length === 0;
          return {
            status: clean ? "success" : "partial",
            itemCounts: {
              tenantsChecked: tenants.length,
              accountsChecked,
              driftedAccounts,
              ledgerBreakAccounts
            },
            detail: clean
              ? undefined
              : `Loyalty drift found in ${affectedTenants.length} tenant(s): ${affectedTenants.join(", ")}. Repair projection drift with POST /api/v1/commerce/loyalty/reconcile {"repair": true}; a ledger break needs manual review.`
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
