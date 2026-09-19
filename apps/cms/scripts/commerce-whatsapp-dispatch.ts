/**
 * commerce-whatsapp-dispatch.ts — `bun run commerce:whatsapp:dispatch`.
 *
 * Issue #108 (contract #106/ADR-0017 D5). Internal worker entrypoint for the
 * WhatsApp dispatcher
 * (`src/modules/commerce/application/whatsapp-dispatch.ts`) — intended to
 * run on a schedule (cron/systemd timer/k8s CronJob), not exposed over
 * HTTP. Mirrors `scripts/email-dispatch.ts` exactly: iterates every
 * `active` tenant and drains its due `awcms_commerce_whatsapp_messages`
 * backlog in batches, looping per tenant until a batch claims nothing or
 * `MAX_PASSES_PER_TENANT` is hit.
 *
 * No-op (claims nothing, exits 0) when `COMMERCE_WHATSAPP_ENABLED` is not
 * `"true"` — see `dispatchWhatsappQueue`'s own early return.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { dispatchWhatsappQueue } from "../src/modules/commerce/application/whatsapp-dispatch";

const MAX_PASSES_PER_TENANT = 20;

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
    let totalRetried = 0;
    let totalFailed = 0;
    let totalDeferred = 0;
    let breakerSeenOpen = false;

    for (const tenant of tenants) {
      for (let pass = 0; pass < MAX_PASSES_PER_TENANT; pass += 1) {
        const result = await dispatchWhatsappQueue(sql, tenant.id, {
          correlationId
        });

        totalClaimed += result.claimed;
        totalSent += result.sent;
        totalRetried += result.retried;
        totalFailed += result.failed;
        totalDeferred += result.deferred;
        breakerSeenOpen ||= result.breakerOpen;

        if (result.claimed === 0) {
          break;
        }
      }
    }

    console.log(
      `commerce:whatsapp:dispatch complete — correlationId=${correlationId} ` +
        `tenants=${tenants.length} claimed=${totalClaimed} sent=${totalSent} ` +
        `retried=${totalRetried} failed=${totalFailed} ` +
        `deferred=${totalDeferred} breakerOpen=${breakerSeenOpen}`
    );

    if (totalDeferred > 0 || breakerSeenOpen) {
      // Deliberately not a non-zero exit — same reasoning
      // `email-dispatch.ts` gives: an open breaker is transient and
      // self-healing, the deferred rows are back in `queued` with their
      // retries intact.
      console.warn(
        "commerce:whatsapp:dispatch — a WhatsApp provider circuit breaker " +
          `was open; ${totalDeferred} claimed message(s) were released back ` +
          "to 'queued' without an attempt. They go out on the next pass once " +
          "the breaker closes."
      );
    }
  } catch (error) {
    logScriptFailure("commerce:whatsapp:dispatch FAILED", error);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
