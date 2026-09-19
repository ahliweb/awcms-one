/**
 * commerce-payments-reconcile.ts — `bun run commerce:payments:reconcile`
 * (Issue #113, contract #106's D2). Internal worker entrypoint, not exposed
 * over HTTP, run on a schedule (`module.ts`'s `jobs` descriptor).
 *
 * For every active tenant, polls every payment-gateway session still
 * `pending` more than two minutes after creation via `provider.fetchStatus`
 * (called OUTSIDE any DB transaction, wrapped in `withTimeout` +
 * `getProviderCircuitBreaker` INSIDE the adapter itself — see
 * `infrastructure/midtrans-provider.ts`'s header) and applies the same
 * transition path the webhook route uses. Also expires every session past
 * its own `expires_at`, regardless of what `fetchStatus` answers.
 *
 * No-op (skips every tenant, exits 0) when `COMMERCE_PAYMENT_GATEWAY` does
 * not resolve to a configured provider — mirrors
 * `commerce-whatsapp-dispatch.ts`'s own "disabled feature is a clean no-op"
 * shape.
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
import { reconcilePendingSessionsForTenant } from "../src/modules/commerce/application/payment-reconcile";
import {
  resolvePaymentGatewayProvider,
  resolvePaymentGatewayProviderKey
} from "../src/modules/commerce/infrastructure/payment-gateway-provider-resolver";

async function main() {
  const sql = getWorkerDatabaseClient();
  const cliOptions = parseJobCliArgs(process.argv.slice(2));

  try {
    const result = await runJob(
      {
        name: "commerce:payments:reconcile",
        description:
          "Polls every pending, aged payment-gateway session across every active tenant via provider.fetchStatus and applies the same paid/expired transition the webhook route uses; also expires every session past expires_at regardless of fetchStatus.",
        handler: async (ctx) => {
          const providerKey = resolvePaymentGatewayProviderKey();
          const provider = resolvePaymentGatewayProvider();

          if (!providerKey || !provider) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: 0,
                checked: 0,
                markedPaid: 0,
                expiredSessions: 0,
                expiredOrders: 0,
                fetchFailures: 0
              },
              detail:
                "No payment-gateway provider configured (COMMERCE_PAYMENT_GATEWAY) — nothing to reconcile."
            };
          }

          const tenants = await fetchActiveTenants(sql);

          if (ctx.dryRun) {
            return {
              status: "success" as const,
              itemCounts: {
                tenantsChecked: tenants.length,
                checked: 0,
                markedPaid: 0,
                expiredSessions: 0,
                expiredOrders: 0,
                fetchFailures: 0
              },
              detail: "dry-run: no session was checked."
            };
          }

          let totalChecked = 0;
          let totalMarkedPaid = 0;
          let totalExpiredSessions = 0;
          let totalExpiredOrders = 0;
          let totalFetchFailures = 0;

          for (const tenant of tenants) {
            if (ctx.signal.aborted) break;

            const tenantResult = await reconcilePendingSessionsForTenant(
              sql,
              tenant.id,
              new Date(),
              provider,
              providerKey,
              ctx.correlationId
            );

            totalChecked += tenantResult.checked;
            totalMarkedPaid += tenantResult.markedPaid;
            totalExpiredSessions += tenantResult.expiredSessions;
            totalExpiredOrders += tenantResult.expiredOrders;
            totalFetchFailures += tenantResult.fetchFailures;
          }

          return {
            status: "success" as const,
            itemCounts: {
              tenantsChecked: tenants.length,
              checked: totalChecked,
              markedPaid: totalMarkedPaid,
              expiredSessions: totalExpiredSessions,
              expiredOrders: totalExpiredOrders,
              fetchFailures: totalFetchFailures
            },
            detail:
              totalFetchFailures > 0
                ? `${totalFetchFailures} session(s) could not be checked this tick (timeout/circuit breaker open/provider error) — left pending, retried next run.`
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
