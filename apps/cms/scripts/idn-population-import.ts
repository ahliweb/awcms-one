/**
 * idn-population-import.ts — `bun run idn-population:import`.
 *
 * awcms-one ADR-0053 — imports the population (total, male, female) and area
 * figures of Kepmendagri No 300.2.2-2138 Tahun 2025 per province and
 * regency/city, from the two files vendored beside the region dump:
 * `data/idn-admin-regions/upstream/cahyadsn-wilayah/db/wilayah_penduduk.sql`
 * (persons, per the decree) and `db/wilayah_luas.sql` (area in km2, from Badan
 * Informasi Geospasial, with the decree's codes). Runs as the least-privilege
 * `awcms_worker` role (grants in `sql/882`), reads repo files and touches no
 * network.
 *
 * ```bash
 * bun run idn-population:import             # dry run
 * bun run idn-population:import -- --commit # write it
 * ```
 *
 * ## Verified before it is read
 *
 * Each file's sha256 and size are checked against `manifest.json` AND
 * `checksums.sha256`, and each header must still cite the decree (and, for the
 * area file, BIG's letter). Any disagreement refuses the run and records
 * nothing.
 *
 * ## Dry run is the default, and it is the same code path
 *
 * `--commit` runs the plan the dry run printed, then writes it. The region codes
 * are validated against the ACTIVE region dataset, so a dry run needs the
 * database too (read-only).
 *
 * ## Re-running is a no-op; the import never activates what it imports
 *
 * The dataset code is derived from the decree and both files' sha256, so
 * running again over identical bytes reports "already imported" and exits 0.
 * A dataset lands `validated`; serving it is the separate operator job
 * `bun run idn-population:activate`. Files that fail validation are recorded as
 * a `rejected` dataset row carrying the problems (no statistics rows).
 *
 * NOT tenant-scoped: global reference data, so a plain transaction rather than
 * `withTenant`. Writes no `awcms_audit_events` row, for the reason documented in
 * `idn-regions-activate.ts` (ADR-0052): that table is tenant-scoped and this
 * action is global; the evidence is the dataset row and this command's output.
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { logScriptFailure } from "../src/lib/logging/error-log";
import { safeErrorDetail } from "../src/lib/logging/error-sanitizer";
import {
  commitPopulationImport,
  findPopulationDatasetStatus,
  loadActiveRegionDataset,
  planPopulationImport,
  PopulationAlreadyImportedError,
  PopulationImportError,
  readPopulationSources,
  recordRejectedPopulationImport,
  type PopulationImportPlan
} from "../src/modules/idn-admin-regions/application/population-import";

const PROBLEM_PRINT_LIMIT = 25;
const KNOWN_FLAGS = new Set(["--commit"]);

function printPlan(
  plan: PopulationImportPlan,
  regionDatasetCode: string
): void {
  console.log(`dataset       : ${plan.datasetCode}`);
  for (const source of plan.sources) {
    console.log(
      `source        : ${source.path} (${source.role}, sha256 ${source.sha256}, ${source.bytes} bytes)`
    );
  }
  console.log(`region dataset: ${regionDatasetCode}`);
  console.log(`figures       : ${plan.report.rowCount}`);
  console.log(
    `by dimension  : ${Object.entries(plan.report.countsByDimension)
      .map(([name, count]) => `${name}=${count}`)
      .join(" ")}`
  );
  console.log(
    `by level      : ${Object.entries(plan.report.countsByLevel)
      .map(([level, count]) => `${level}=${count}`)
      .join(" ")}`
  );
  console.log(
    `checks run    : ${Object.entries(plan.report.checksRun)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(" ")}`
  );
  for (const skipped of plan.report.checksSkipped) {
    console.log(`  not run     : ${skipped}`);
  }
  for (const skipped of plan.report.skipped) {
    console.log(
      `  skipped row : ${skipped.sourceTable} line ${skipped.lineNumber} (${skipped.code}) — ${skipped.reason}`
    );
  }
  console.log(`code repairs  : ${plan.report.codeRepairs.length}`);
  for (const repair of plan.report.codeRepairs) {
    console.log(
      `  repaired    : ${repair.sourceTable} line ${repair.lineNumber} "${repair.sourceCode}" -> ${repair.code} (${repair.name})`
    );
  }
  console.log(`warnings      : ${plan.report.warningCount}`);
  for (const warning of plan.report.warnings.slice(0, 10)) {
    console.log(`  warning     : ${warning}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length > 0) {
    console.error(
      `idn-population:import FAILED — unknown argument(s): ${unknown.join(" ")}. The source is fixed (the vendored Kepmendagri files); the only flag is --commit.`
    );
    console.error("  bun run idn-population:import [-- --commit]");
    process.exitCode = 1;
    return;
  }
  const commit = argv.includes("--commit");

  const sql = getWorkerDatabaseClient();

  try {
    const sources = await readPopulationSources();
    const regionDataset = await loadActiveRegionDataset(sql);
    const plan = planPopulationImport(sources, regionDataset);

    printPlan(plan, regionDataset.datasetCode);

    const existing = await findPopulationDatasetStatus(sql, plan.datasetCode);
    if (existing !== null && existing !== "rejected") {
      console.log(
        new PopulationAlreadyImportedError(plan.datasetCode, existing).message
      );
      return;
    }

    if (plan.errors.length > 0) {
      console.error(
        `idn-population:import FAILED — ${plan.errors.length} validation problem(s):`
      );
      for (const problem of plan.errors.slice(0, PROBLEM_PRINT_LIMIT)) {
        console.error(`  - ${problem}`);
      }
      if (plan.errors.length > PROBLEM_PRINT_LIMIT) {
        console.error(
          `  ... and ${plan.errors.length - PROBLEM_PRINT_LIMIT} more.`
        );
      }
      if (commit) {
        const rejected = await recordRejectedPopulationImport(sql, plan);
        console.error(
          `recorded rejected dataset ${rejected.datasetCode} (${rejected.datasetId}) with the problems; no figures were written.`
        );
      }
      process.exitCode = 1;
      return;
    }

    if (!commit) {
      console.log(
        "dry run OK — nothing written. Re-run with --commit to import this dataset (it will land as `validated`, not active)."
      );
      return;
    }

    const result = await sql.begin(async (tx) =>
      commitPopulationImport(tx as Bun.TransactionSQL, plan)
    );
    console.log(
      `imported dataset ${result.datasetCode} (${result.datasetId}) with ${result.rowCount} figures — status ${result.status}${
        result.promotedFromRejected
          ? " (promoted from an earlier rejected attempt; its summary is kept as previousRejection)"
          : ""
      }.`
    );
    console.log(
      "Activate it explicitly (`bun run idn-population:activate -- --dataset <code> --commit`) — importing never changes what is served."
    );
  } catch (error) {
    if (error instanceof PopulationAlreadyImportedError) {
      console.log(error.message);
      return;
    }
    if (error instanceof PopulationImportError) {
      console.error(`idn-population:import FAILED — ${safeErrorDetail(error)}`);
      for (const problem of error.problems.slice(0, PROBLEM_PRINT_LIMIT)) {
        console.error(`  - ${problem}`);
      }
      process.exitCode = 1;
      return;
    }
    logScriptFailure("idn-population:import", error);
  }
}

if (import.meta.main) {
  await main();
}
