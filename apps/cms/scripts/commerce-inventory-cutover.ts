#!/usr/bin/env bun
/**
 * commerce-inventory-cutover.ts — `bun run commerce:inventory:cutover`
 * (Issue #282, ADR-0038 D5). Moves ONE tenant's commerce stock from the counter
 * (`awcms_commerce_products.stock` / `…_product_variants.stock`) to the upstream
 * inventory ledger, atomically: it posts one `opening` movement per stock unit
 * and flips `inventory_mode` to `ledger` in a single tenant transaction.
 *
 *   bun run commerce:inventory:cutover --tenant <tenant-uuid> --location <inventory-location-uuid>
 *   bun run commerce:inventory:cutover --tenant <uuid> --location <uuid> --commit
 *
 * DRY-RUN BY DEFAULT. Without `--commit` the whole path runs - the exclusive
 * lock, the openings, the flip, the verification - and the transaction is then
 * ROLLED BACK, so a dry run proves a commit would succeed and changes nothing.
 * `--commit` is the only way to apply. Re-running after a commit is refused
 * (`already ledger`): the mode, not a flag, makes it a no-op.
 *
 * Preconditions the script checks before it changes anything: the tenant exists;
 * the `inventory` module is enabled for it; the location exists in that tenant
 * and is `active`. Quiesce nothing: the exclusive mode lock makes in-flight
 * orders finish first and new ones wait (`application/commerce-inventory.ts`).
 *
 * ## Why this file imports the inventory module's internals
 *
 * Openings are NOT on `InventoryLedgerPort` (they need `movements.adjust`
 * authority and the first-movement rule). A script is a composition root, so it
 * may name the inventory module's application function; the commerce module
 * itself receives it as the `postOpening` callback and never imports it.
 *
 * ## Roll back later
 *
 * `POST /api/v1/commerce/inventory/rollback` (`commerce.inventory.configure`,
 * audited) sets the mode back to `counter`. The cache is already the last
 * ledger-derived value, so nothing else is needed.
 *
 * Runs as the web role (`awcms_app`): it needs `awcms_inventory_*` INSERT/UPDATE
 * that role holds, and it is operator-run, not a scheduled worker job.
 */
import { randomUUID } from "node:crypto";

import { getDatabaseClient } from "../src/lib/database/client";
import {
  assertUuid,
  withTenantOrThrow
} from "../src/lib/database/tenant-context";
import { postMovement } from "../src/modules/inventory/application/inventory-ledger";
import { validateOpeningInput } from "../src/modules/inventory/domain/inventory-validation";
import {
  CutoverOpeningRefusedError,
  runCommerceInventoryCutover,
  type OpeningPoster
} from "../src/modules/commerce/application/commerce-inventory-cutover";

export type CutoverArgs = {
  tenantId: string;
  locationId: string;
  commit: boolean;
};

export function parseCutoverArgs(argv: string[]): CutoverArgs {
  const read = (flag: string): string => {
    const index = argv.indexOf(flag);
    const value = index >= 0 ? argv[index + 1] : undefined;
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} <uuid> is required.`);
    }
    return assertUuid(value);
  };

  return {
    tenantId: read("--tenant"),
    locationId: read("--location"),
    commit: argv.includes("--commit")
  };
}

/** The opening poster the script wires: the inventory module's own validation and posting core. */
export const postOpeningThroughInventory: OpeningPoster = async (
  tx,
  tenantId,
  request
) => {
  const validation = validateOpeningInput({
    locationId: request.locationId,
    itemType: request.itemType,
    itemRef: request.itemRef,
    unitCode: request.unitCode,
    quantity: request.quantity,
    source: request.source
  });
  if (!validation.valid) {
    throw new Error(
      `Opening refused by validation: ${validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`
    );
  }

  const result = await postMovement(tx, tenantId, validation.value, {
    actorTenantUserId: null,
    correlationId: request.correlationId
  });

  return result.outcome;
};

/** Thrown inside the transaction to ROLL IT BACK on a dry run. */
class DryRunRollback extends Error {
  constructor(readonly summary: unknown) {
    super("dry-run");
  }
}

async function main(): Promise<void> {
  const { tenantId, locationId, commit } = parseCutoverArgs(
    process.argv.slice(2)
  );
  const sql = getDatabaseClient();
  const correlationId = `commerce-inventory-cutover-${randomUUID()}`;

  try {
    const outcome = await withTenantOrThrow(
      sql,
      tenantId,
      async (tx) => {
        const modules = (await tx`
          SELECT 1 FROM awcms_tenant_modules
          WHERE tenant_id = ${tenantId} AND module_key = 'inventory' AND enabled = true
        `) as unknown[];
        if (modules.length === 0) {
          return {
            kind: "refused" as const,
            reason: "the inventory module is not enabled for this tenant."
          };
        }

        const locations = (await tx`
          SELECT status FROM awcms_inventory_locations
          WHERE tenant_id = ${tenantId} AND id = ${locationId}
        `) as { status: string }[];
        if (locations.length === 0) {
          return {
            kind: "refused" as const,
            reason: "the location does not exist in this tenant."
          };
        }
        if (locations[0]!.status !== "active") {
          return {
            kind: "refused" as const,
            reason: "the location is not active."
          };
        }

        const result = await runCommerceInventoryCutover(
          tx,
          tenantId,
          locationId,
          postOpeningThroughInventory,
          correlationId
        );

        if (result.kind === "completed" && !commit) {
          throw new DryRunRollback(result);
        }

        return { kind: "result" as const, result };
      },
      { workClass: "background_sync" }
    ).catch((error: unknown) => {
      if (error instanceof DryRunRollback) {
        return { kind: "dry_run" as const, result: error.summary };
      }
      if (error instanceof CutoverOpeningRefusedError) {
        // The transaction is already rolled back: nothing was backfilled.
        return { kind: "refused" as const, reason: error.message };
      }
      throw error;
    });

    if (outcome.kind === "refused") {
      console.error(`commerce:inventory:cutover REFUSED: ${outcome.reason}`);
      process.exitCode = 1;
    } else if (outcome.kind === "dry_run") {
      console.log(
        "commerce:inventory:cutover DRY-RUN (rolled back):",
        outcome.result
      );
      console.log("Re-run with --commit to apply.");
    } else if (outcome.result.kind === "completed") {
      console.log("commerce:inventory:cutover COMMITTED:", outcome.result);
    } else if (outcome.result.kind === "already_ledger") {
      console.log(
        "commerce:inventory:cutover: this tenant is already in ledger mode; nothing to do."
      );
    } else {
      console.error(
        "commerce:inventory:cutover REFUSED by the ledger:",
        outcome.result
      );
      process.exitCode = 1;
    }
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
