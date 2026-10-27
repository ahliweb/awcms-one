/**
 * commerce-customer-push-dispatch.ts - `bun run commerce:customer-push:dispatch`
 * (Issue #432, ADR-0048 sections 5.5 and 5.6). Internal worker entrypoint for the
 * customer Web Push dispatcher
 * (`src/modules/commerce/application/customer-push-dispatch.ts`), run on a
 * schedule (`module.ts`'s `jobs` descriptor), never exposed over HTTP.
 *
 * For every active tenant it drains the due customer push outbox in bounded
 * passes: claim, re-check eligibility, send through the upstream Web Push
 * provider, finalize. The job runner gives it the advisory lock (a second
 * concurrent run safely skips), a timeout and SIGTERM cancellation, `--dry-run`
 * and JSON telemetry.
 *
 * It claims nothing and exits 0 unless `PUSH_ENABLED=true`, the `web_push`
 * provider, a VAPID key pair and the auth-secret key ring are configured, and
 * the tenant turned the `customerPush` feature on (the kill switches). `--dry-run`
 * only counts the tenants: a pass claims and sends, which is not previewable.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import {
  fetchActiveTenants,
  iterateTenantsInBatches
} from "../src/lib/jobs/batching";
import {
  applyJobExitCode,
  formatJobOutcomeLine,
  isJobResultOk,
  parseJobCliArgs,
  printJobTelemetry,
  runJob,
  writeJobTelemetry
} from "../src/lib/jobs/job-runner";
import {
  dispatchCustomerPushForTenant,
  type CustomerPushDispatchGate,
  type DispatchCustomerPushResult
} from "../src/modules/commerce/application/customer-push-dispatch";

const MAX_PASSES_PER_TENANT = 20;

type Totals = Omit<
  DispatchCustomerPushResult,
  "breakerOpen" | "gated" | "count"
>;

const ZERO_TOTALS: Totals = {
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  gone: 0,
  cancelled: 0,
  expired: 0,
  deferred: 0,
  released: 0,
  leaseLost: 0
};

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:customer-push:dispatch",
        description:
          "Dispatches the due customer Web Push outbox in every active tenant that enabled the customerPush feature: eligibility re-check, per-account cap, TTL and urgency, 404/410 revokes the device, exponential backoff.",
        handler: async (ctx) => {
          if (ctx.dryRun) {
            const tenants = await fetchActiveTenants(sql);
            return {
              status: "success" as const,
              itemCounts: { tenantsChecked: tenants.length, ...ZERO_TOTALS },
              detail: "dry-run: nothing was claimed or sent."
            };
          }

          const gates = new Set<CustomerPushDispatchGate>();
          let breakerOpen = false;

          const { tenants, perTenant } = await iterateTenantsInBatches(
            sql,
            async (tenantId) => {
              const pass = await dispatchCustomerPushForTenant(sql, tenantId, {
                correlationId: ctx.correlationId
              });
              if (pass.gated) gates.add(pass.gated);
              breakerOpen ||= pass.breakerOpen;
              return pass;
            },
            { signal: ctx.signal, maxPasses: MAX_PASSES_PER_TENANT }
          );

          const totals = { ...ZERO_TOTALS };
          const tenantsHitPassLimit: string[] = [];
          for (const [tenantId, outcome] of perTenant) {
            if (outcome.hitPassLimit) tenantsHitPassLimit.push(tenantId);
            for (const pass of outcome.passes) {
              for (const key of Object.keys(totals) as (keyof Totals)[]) {
                totals[key] += pass[key];
              }
            }
          }

          console.log(
            `commerce:customer-push:dispatch complete - correlationId=${ctx.correlationId} ` +
              `tenants=${tenants.length} claimed=${totals.claimed} sent=${totals.sent} ` +
              `retried=${totals.retried} failed=${totals.failed} gone=${totals.gone} ` +
              `cancelled=${totals.cancelled} expired=${totals.expired} ` +
              `deferred=${totals.deferred} released=${totals.released} ` +
              `leaseLost=${totals.leaseLost} breakerOpen=${breakerOpen}` +
              (gates.size > 0 ? ` gated=${[...gates].join(",")}` : "")
          );

          // An open breaker is transient and self-healing (the rows were
          // released unattempted), so it is reported but is not a failure.
          return {
            status:
              tenantsHitPassLimit.length > 0
                ? ("partial" as const)
                : ("success" as const),
            itemCounts: { tenantsChecked: tenants.length, ...totals },
            detail:
              tenantsHitPassLimit.length > 0
                ? `Backlog not fully drained for: ${tenantsHitPassLimit.join(", ")}`
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
