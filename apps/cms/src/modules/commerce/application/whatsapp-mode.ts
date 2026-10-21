/**
 * The per-tenant WhatsApp delivery mode: where it is read (Issue #392, ADR-0133
 * section 6 phase 2). The guarded flip that writes it is `whatsapp-mode-flip.ts`
 * (issue #393).
 *
 * ## Where the mode lives
 *
 * Two columns on `awcms_commerce_store_settings` (`sql/1027`), the shape
 * `inventory_mode` already uses (`application/commerce-inventory.ts`). Columns,
 * not the settings jsonb, so an owner's "reset my store to defaults" cannot move
 * a tenant between queues; `deleted_at` on the row is ignored for the same
 * reason. A tenant with no settings row is `legacy`.
 *
 * ## Reading, and the lock that makes the answer stable
 *
 * `resolveWhatsappMode` is for a WRITE (it is what `enqueueWhatsappMessage`
 * calls): it takes `pg_advisory_xact_lock_shared` on a per-tenant key BEFORE
 * reading, so the answer cannot change under the transaction. Shared, so
 * concurrent enqueues never wait for one another. The flip (issue #393) takes
 * the EXCLUSIVE lock through `lockWhatsappModeExclusive` before it checks that
 * the legacy queue holds no non-terminal row and before it writes the column: a
 * legacy enqueue that read `legacy` has committed its row by the time the flip
 * counts, and one that starts afterwards waits, then reads the new mode. Without
 * the lock a legacy row could be inserted after the flip's drain check and sit
 * in the old queue forever, which is exactly the "two live queues for one
 * tenant" ADR-0133 refuses. The lock is released at commit/rollback.
 *
 * `readWhatsappMode` takes no lock: for reads that do not write a message (the
 * channel-availability checks, the status read, a status endpoint).
 *
 * ## Where the mode is WRITTEN
 *
 * Not here. `whatsapp-mode-flip.ts` (issue #393) holds the one writer
 * (`flipWhatsappMode`); `tests/commerce-whatsapp-upstream-boundary.test.ts` fails
 * if a second file writes the column. It takes `lockWhatsappModeExclusive`,
 * refuses while the queue being left holds a non-terminal row (the legacy
 * table's are `queued` and `sending` - a retry is `queued` again, that table has
 * no `retry_wait`; the upstream queue's also include `retry_wait`), upserts the
 * settings row, writes `whatsapp_mode` + `whatsapp_mode_changed_at` and audits.
 * This file stays the reader, and stays free of both queues' tables.
 */
import {
  DEFAULT_WHATSAPP_MODE,
  parseWhatsappMode,
  type WhatsappMode
} from "../domain/whatsapp-mode";

function modeLockKey(tenantId: string): string {
  return `commerce.whatsapp_mode|${tenantId}`;
}

/** Takes the flip's EXCLUSIVE mode lock: waits for every in-flight enqueue, blocks new ones. For issue #393. */
export async function lockWhatsappModeExclusive(
  tx: Bun.SQL,
  tenantId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${modeLockKey(tenantId)}, 0))`;
}

type ModeRow = { whatsapp_mode: string };

/** The tenant's mode, without taking the mode lock. */
export async function readWhatsappMode(
  tx: Bun.SQL,
  tenantId: string
): Promise<WhatsappMode> {
  const rows = (await tx`
    SELECT whatsapp_mode
    FROM awcms_commerce_store_settings
    WHERE tenant_id = ${tenantId}
  `) as ModeRow[];

  return rows[0]
    ? parseWhatsappMode(rows[0].whatsapp_mode)
    : DEFAULT_WHATSAPP_MODE;
}

/**
 * The tenant's mode for a WRITE: takes the shared mode lock first (see the
 * header). Two statements on purpose - under READ COMMITTED a lock and a read in
 * one statement would read the snapshot taken before the lock was granted.
 */
export async function resolveWhatsappMode(
  tx: Bun.SQL,
  tenantId: string
): Promise<WhatsappMode> {
  await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${modeLockKey(tenantId)}, 0))`;

  return readWhatsappMode(tx, tenantId);
}
