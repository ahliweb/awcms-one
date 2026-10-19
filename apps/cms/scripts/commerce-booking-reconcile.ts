#!/usr/bin/env bun
/**
 * commerce-booking-reconcile.ts — `bun run commerce:booking:reconcile`
 * (Issue #396, epic #280 item 35 adapter half; threat controls C-09 and C-38,
 * ADR-0045). The booking adapter's post-restore reconciliation.
 *
 *   bun run commerce:booking:reconcile
 *   bun run commerce:booking:reconcile --tenant <uuid> --json
 *   bun run commerce:booking:reconcile --require-links --evidence-log /backup/restore-drill-evidence.jsonl
 *
 * READ-ONLY. It runs the catalog structure check once and then, for every
 * active tenant (or the one named), the zero-or-two-references reconciliation
 * between reservation links and orders (C-38), the C-09 settlement-versus-
 * reservation comparison and the refund-decision-versus-refund-leg comparison,
 * each in a READ ONLY tenant transaction. It never writes a row.
 *
 * Exit code: 0 when there is zero drift; 1 on any drift, or (with
 * `--require-links`) when the database holds no reservation link at all, since a
 * drill that checked nothing proves nothing. A run that cannot connect or query
 * throws and exits non-zero as well.
 *
 * ## Running it against a restored database
 *
 * Upstream's `restore-drill.sh` restores into a scratch database and drops it, so
 * this runs in between: restore with `--keep`, point `DATABASE_URL` at the
 * scratch database, run this, then drop the scratch database. Use the migration
 * owner DSN or `awcms_app`: `awcms_worker` cannot read Booking's reservations.
 * `docs/deployment.md` ("Booking adapter restore drill") has the commands.
 *
 * `--evidence-log <path>` appends ONE JSON line (outcome, counts, drift kinds:
 * no identifiers, no amounts) in the shape of `restore-drill.sh`'s own evidence
 * log, so the drill's log carries the adapter half beside the restore half.
 * `--json` prints the full report, with the ids an operator needs to find the
 * rows, instead of the text summary.
 *
 * Runs as the web role or the owner role, operator-run (the shape of
 * `commerce:inventory:cutover`), not as a scheduled worker job.
 */
import { appendFileSync } from "node:fs";

import { getDatabaseClient } from "../src/lib/database/client";
import { runBookingRestoreReconciliation } from "../src/modules/commerce/application/booking-restore-reconciliation";
import {
  buildDrillEvidenceLine,
  drillExitCode,
  evaluateBookingRestoreReport,
  formatDrillText,
  parseReconcileArgs
} from "../src/modules/commerce/domain/booking-restore-drill";

async function main(): Promise<void> {
  const args = parseReconcileArgs(process.argv.slice(2));
  const startedAt = new Date();
  const sql = getDatabaseClient();

  try {
    const report = await runBookingRestoreReconciliation(sql, {
      tenantId: args.tenantId
    });
    const verdict = evaluateBookingRestoreReport(report, {
      requireLinks: args.requireLinks
    });

    if (args.json) {
      console.log(JSON.stringify({ verdict, report }, null, 2));
    } else {
      for (const line of formatDrillText(report, verdict)) {
        console.log(line);
      }
    }

    if (args.evidenceLog) {
      appendFileSync(
        args.evidenceLog,
        `${buildDrillEvidenceLine({
          startedAt,
          durationMs: Date.now() - startedAt.getTime(),
          verdict
        })}\n`
      );
    }

    process.exitCode = drillExitCode(verdict.status);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
