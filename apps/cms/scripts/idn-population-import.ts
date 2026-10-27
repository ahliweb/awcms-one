/**
 * idn-population-import.ts — `bun run idn-population:import`.
 *
 * awcms-one ADR-0051 — imports BPS population statistics from a reviewed file
 * pair, `data/idn-population/datasets/<dataset_code>.json` (the provenance
 * manifest) plus `<dataset_code>.csv` (the extracted figures), as a NEW dataset.
 * Runs as the least-privilege `awcms_worker` role (grants in `sql/882`), reads
 * repo files and touches no network.
 *
 * ```bash
 * bun run idn-population:import -- --dataset <code>                # dry run
 * bun run idn-population:import -- --dataset <code> --commit       # write it
 * bun run idn-population:import -- --all-pending [--commit]        # every pair not yet in the database
 * ```
 *
 * ## Dry run is the default, and it is the same code path
 *
 * `--commit` runs the plan the dry run printed, then writes it. The region codes
 * are validated against the ACTIVE region dataset, so a dry run needs the
 * database too (read-only).
 *
 * ## The import never activates what it imports
 *
 * A dataset lands `validated`. Serving it is the separate operator job
 * `bun run idn-population:activate`. A CSV that fails validation is recorded as a
 * `rejected` dataset row carrying the problems (no statistics rows); a manifest
 * that disagrees with its CSV (checksum mismatch) is refused outright and
 * records nothing.
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
  listImportedDatasetCodes,
  listPendingDatasetCodes,
  loadActiveRegionLevels,
  planPopulationImport,
  PopulationImportError,
  recordRejectedPopulationImport,
  type PopulationImportPlan
} from "../src/modules/idn-admin-regions/application/population-import";

const PROBLEM_PRINT_LIMIT = 25;

function readFlagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function printPlan(plan: PopulationImportPlan): void {
  const m = plan.manifest;
  console.log(`dataset       : ${m.datasetCode}`);
  console.log(`publication   : ${m.publicationTitle} (${m.publisherName})`);
  console.log(
    `covers        : ${m.coverageRegionCode} (${m.publicationSeries})`
  );
  console.log(`csv sha256    : ${plan.csvSha256}`);
  console.log(`rows          : ${plan.report.rowCount}`);
  console.log(
    `by dimension  : ${
      Object.entries(plan.report.countsByDimension)
        .map(([name, count]) => `${name}=${count}`)
        .join(" ") || "none"
    }`
  );
  const kinds = Object.keys(
    plan.report.checksRun
  ) as (keyof typeof plan.report.checksRun)[];
  console.log(
    `checks        : ${kinds
      .map(
        (kind) =>
          `${kind} run=${plan.report.checksRun[kind]} skipped=${plan.report.checksSkipped[kind]}`
      )
      .join("; ")}`
  );
  console.log(`warnings      : ${plan.report.warningCount}`);
  for (const warning of plan.report.warnings.slice(0, 5)) {
    console.log(`  warning     : ${warning}`);
  }
  for (const sample of plan.report.skippedSamples.slice(0, 5)) {
    console.log(`  skipped     : ${sample}`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes("--commit");
  const allPending = argv.includes("--all-pending");
  const single = readFlagValue(argv, "--dataset");

  if ((single === null) === !allPending) {
    console.error(
      "idn-population:import FAILED — pass exactly one of --dataset <code> or --all-pending."
    );
    console.error(
      "  bun run idn-population:import -- (--dataset <code> | --all-pending) [--commit]"
    );
    process.exitCode = 1;
    return;
  }

  const sql = getWorkerDatabaseClient();

  try {
    const { regionDatasetId, levels } = await loadActiveRegionLevels(sql);

    let codes: string[];
    if (single !== null) {
      codes = [single];
    } else {
      const imported = await listImportedDatasetCodes(sql);
      codes = (await listPendingDatasetCodes()).filter(
        (code) => !imported.has(code)
      );
      console.log(`${codes.length} pending dataset(s).`);
    }

    let failed = false;

    for (const code of codes) {
      console.log(`\n== ${code}`);
      let plan: PopulationImportPlan;
      try {
        plan = await planPopulationImport({
          datasetCode: code,
          regionDatasetId,
          regionLevels: levels
        });
      } catch (error) {
        if (error instanceof PopulationImportError) {
          console.error(
            `idn-population:import FAILED — ${safeErrorDetail(error)}`
          );
          for (const problem of error.problems.slice(0, PROBLEM_PRINT_LIMIT)) {
            console.error(`  - ${problem}`);
          }
          failed = true;
          continue;
        }
        throw error;
      }

      printPlan(plan);

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
            `recorded rejected dataset ${rejected.datasetCode} (${rejected.datasetId}) with the problems; no statistics were written.`
          );
        }
        failed = true;
        continue;
      }

      if (!commit) {
        console.log(
          "dry run OK — nothing written. Re-run with --commit to import this dataset (it will land as `validated`, not active)."
        );
        continue;
      }

      try {
        const result = await sql.begin(async (tx) =>
          commitPopulationImport(tx as Bun.TransactionSQL, plan)
        );
        console.log(
          `imported dataset ${result.datasetCode} (${result.datasetId}) with ${result.rowCount} rows — status ${result.status}.`
        );
        console.log(
          "Activate it explicitly (`bun run idn-population:activate -- --dataset <code> --commit`) — importing never changes what is served."
        );
      } catch (error) {
        if (
          error instanceof Error &&
          /awcms_idn_population_datasets_dataset_code_key/.test(error.message)
        ) {
          console.error(
            `idn-population:import FAILED — dataset ${code} is already present; this command refuses to import a dataset code twice.`
          );
          failed = true;
          continue;
        }
        throw error;
      }
    }

    if (failed) process.exitCode = 1;
  } catch (error) {
    if (error instanceof PopulationImportError) {
      console.error(`idn-population:import FAILED — ${safeErrorDetail(error)}`);
      process.exitCode = 1;
      return;
    }
    logScriptFailure("idn-population:import", error);
  }
}

if (import.meta.main) {
  await main();
}
