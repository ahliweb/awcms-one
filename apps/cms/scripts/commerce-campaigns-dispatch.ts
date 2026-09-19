/**
 * commerce-campaigns-dispatch.ts — `bun run commerce:campaigns:dispatch`.
 *
 * Issue #114 (contract #106/ADR-0017 D9). Internal worker entrypoint for the
 * campaign dispatcher
 * (`src/modules/commerce/application/campaign-dispatch.ts`) — intended to
 * run on a schedule (cron/systemd timer/k8s CronJob), not exposed over
 * HTTP. Mirrors `scripts/commerce-whatsapp-dispatch.ts`: iterates every
 * `active` tenant and drains its due campaign backlog, looping per tenant
 * until a pass claims nothing.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { dispatchCampaignQueue } from "../src/modules/commerce/application/campaign-dispatch";

const MAX_PASSES_PER_TENANT = 10;

type TenantRow = { id: string };

async function main() {
  const sql = getWorkerDatabaseClient();
  const correlationId = crypto.randomUUID();

  try {
    const tenants = (await sql`
      SELECT id FROM awcms_tenants WHERE status = 'active'
    `) as TenantRow[];

    let totalClaimed = 0;
    let totalSent = 0;
    let totalEnqueued = 0;
    let totalSkipped = 0;
    let totalCancelled = 0;

    for (const tenant of tenants) {
      for (let pass = 0; pass < MAX_PASSES_PER_TENANT; pass += 1) {
        const result = await dispatchCampaignQueue(sql, tenant.id, {
          correlationId
        });

        totalClaimed += result.claimed;
        totalSent += result.sent;
        totalEnqueued += result.recipientsEnqueued;
        totalSkipped += result.recipientsSkipped;
        totalCancelled += result.cancelledMidFlight;

        if (result.claimed === 0) {
          break;
        }
      }
    }

    console.log(
      `commerce:campaigns:dispatch complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} claimed=${totalClaimed} sent=${totalSent} ` +
        `recipientsEnqueued=${totalEnqueued} recipientsSkipped=${totalSkipped} ` +
        `cancelledMidFlight=${totalCancelled}`
    );
  } catch (error) {
    logScriptFailure("commerce:campaigns:dispatch FAILED", error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
