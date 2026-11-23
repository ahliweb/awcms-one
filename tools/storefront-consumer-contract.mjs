/**
 * `bun run contract:storefront:check` / `contract:storefront:generate`.
 *
 * Freezes (generate) or verifies (check) the storefront's build-time reads
 * (issue #555) and browser calls (issue #556) against the committed OpenAPI bundle. See
 * `tools/lib/storefront-consumer-contract.mjs` for the rule and its limits.
 *
 * Generating is a deliberate act: it overwrites the frozen fixture with the
 * current bundle's shape, so it means "the contract changed and the storefront
 * changed with it". `--generate` requires `--reason "<why>"` so the intent is
 * written down; the reason is printed and belongs in the PR description.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  BUNDLE_PATH,
  FIXTURE_PATH,
  buildFixture,
  findResolvedPending,
  runChecks,
  serializeFixture
} from "./lib/storefront-consumer-contract.mjs";

const bundle = Bun.YAML.parse(readFileSync(BUNDLE_PATH, "utf8"));
const args = process.argv.slice(2);

if (args.includes("--generate")) {
  const at = args.indexOf("--reason");
  const reason = at >= 0 ? args[at + 1] : undefined;
  if (!reason || reason.startsWith("--")) {
    console.error('contract:storefront:generate needs --reason "<why the contract is being re-frozen>".');
    process.exit(2);
  }
  const fixture = buildFixture(bundle);
  writeFileSync(FIXTURE_PATH, serializeFixture(fixture), "utf8");
  console.log(
    `contract:storefront:generate OK - ${fixture.operations.length} operations, ` +
      `${Object.keys(fixture.paths).length} paths, ` +
      `${Object.values(fixture.components).reduce((n, group) => n + Object.keys(group).length, 0)} components ` +
      `frozen into ${FIXTURE_PATH}. Reason: ${reason}`
  );
} else {
  const frozen = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const problems = runChecks({ frozen, bundle, root: "." });
  if (problems.length > 0) {
    console.error("contract:storefront:check FAILED");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const build = frozen.operations.filter((entry) => entry.phase === "build").length;
  const browser = frozen.operations.filter((entry) => entry.phase === "browser").length;
  console.log(
    `contract:storefront:check OK - ${build} build-time reads and ${browser} browser calls still satisfied ` +
      "(responses additively, request bodies and parameters still accepted)."
  );
  for (const note of findResolvedPending(bundle)) console.log(`  note: ${note}`);
}
