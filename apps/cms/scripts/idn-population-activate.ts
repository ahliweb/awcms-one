/**
 * idn-population-activate.ts — `bun run idn-population:activate`.
 *
 * awcms-one ADR-0051 — chooses which imported BPS population dataset is SERVED
 * for its publication series and covered region. Runs as the least-privilege
 * `awcms_worker` role (grants in `sql/882`), touches no network.
 *
 * ```bash
 * bun run idn-population:activate -- --dataset <code|uuid>            # dry run
 * bun run idn-population:activate -- --dataset <code|uuid> --commit   # activates
 * ```
 *
 * Activating supersedes only the active dataset of the SAME series and covered
 * region (see `population-lifecycle.ts`): the provincial publication and each
 * regency's publication are active side by side.
 *
 * ## Why this is a job and not an endpoint
 *
 * The same reasoning as `idn-regions-activate.ts` (ADR-0052): the tables have no
 * `tenant_id` and no RLS, so there is no tenant this action belongs to and no
 * tenant permission can express it. This change adds no HTTP endpoint and no
 * permission at all.
 *
 * NOT tenant-scoped: global reference data, so a plain transaction rather than
 * `withTenant`.
 *
 * ## No audit row, and that is a deliberate, documented cost
 *
 * `recordAuditEvent` writes to the tenant-scoped `awcms_audit_events`; a global
 * action written into one tenant's log misrepresents it and is invisible to every
 * other affected tenant. The durable evidence is on the data itself — `status`,
 * `activated_at`, `activated_by` on `awcms_idn_population_datasets` — plus this
 * command's own output in the operator's shell or CI log. A correct cross-tenant
 * audit needs a global log this base does not have yet (ADR-0052
 * §Konsekuensi).
 */
import { getWorkerDatabaseClient } from "../src/lib/database/client";
import { safeErrorDetail } from "../src/lib/logging/error-sanitizer";
import { logScriptFailure } from "../src/lib/logging/error-log";
import {
  activatePopulationDataset,
  getActivePopulationDataset,
  listPopulationDatasets,
  PopulationLifecycleError
} from "../src/modules/idn-admin-regions/application/population-lifecycle";

function readFlagValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commit = argv.includes("--commit");
  const selector = readFlagValue(argv, "--dataset");

  if (!selector) {
    console.error(
      "idn-population:activate FAILED — --dataset <code|uuid> is required."
    );
    console.error(
      "  bun run idn-population:activate -- --dataset <code|uuid> [--commit]"
    );
    process.exitCode = 1;
    return;
  }

  const sql = getWorkerDatabaseClient();

  try {
    // Resolve the selector and print the transition BEFORE writing anything, so
    // the dry run and the commit describe the same decision from the same data.
    const resolved = await sql.begin(async (tx) => {
      const datasets = await listPopulationDatasets(tx as Bun.TransactionSQL);
      const target =
        datasets.find((dataset) => dataset.id === selector) ??
        datasets.find((dataset) => dataset.datasetCode === selector) ??
        null;
      const active = target
        ? await getActivePopulationDataset(
            tx as Bun.TransactionSQL,
            target.publicationSeries,
            target.coverageRegionCode
          )
        : null;
      return { target, active };
    });

    if (!resolved.target) {
      console.error(
        `idn-population:activate FAILED — no dataset matches "${selector}".`
      );
      process.exitCode = 1;
      return;
    }

    console.log(`target dataset : ${resolved.target.datasetCode}`);
    console.log(`  id           : ${resolved.target.id}`);
    console.log(`  status       : ${resolved.target.status}`);
    console.log(`  rows         : ${resolved.target.rowCount}`);
    console.log(
      `  covers       : ${resolved.target.coverageRegionCode} (${resolved.target.publicationSeries})`
    );
    console.log(
      `currently active for that series and region: ${
        resolved.active
          ? `${resolved.active.datasetCode} (${resolved.active.id})`
          : "none"
      }`
    );

    if (resolved.active?.id === resolved.target.id) {
      console.log(
        "already active — nothing to do (activation is idempotent by design)."
      );
      return;
    }

    if (
      resolved.target.status !== "validated" &&
      resolved.target.status !== "superseded"
    ) {
      console.error(
        `idn-population:activate FAILED — dataset is ${resolved.target.status}; only a validated or superseded dataset can be activated.`
      );
      process.exitCode = 1;
      return;
    }

    if (!commit) {
      console.log(
        "dry run OK — nothing written. Re-run with --commit to serve this dataset."
      );
      return;
    }

    const result = await sql.begin(async (tx) =>
      // `activatedBy` is null: there is no request-time subject here.
      activatePopulationDataset(tx as Bun.TransactionSQL, resolved.target!.id, {
        activatedBy: null
      })
    );

    console.log(
      result.changed
        ? `activated ${result.dataset.datasetCode} (${result.dataset.id})` +
            (result.supersededId
              ? ` — superseded ${result.supersededId}`
              : " — no previous active version")
        : `no-op — ${result.dataset.datasetCode} was already active.`
    );
  } catch (error) {
    if (error instanceof PopulationLifecycleError) {
      console.error(
        `idn-population:activate FAILED — ${safeErrorDetail(error)}`
      );
      process.exitCode = 1;
      return;
    }
    logScriptFailure("idn-population:activate", error);
  }
}

if (import.meta.main) {
  await main();
}
