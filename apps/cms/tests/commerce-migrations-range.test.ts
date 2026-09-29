/**
 * The guard that keeps issue #72's rule true after every future `git subtree
 * pull`: every LOCAL-ONLY migration (one that exists only in `awcms-one`,
 * never in upstream `ahliweb/awcms`) lives in the reserved `900`-`999`
 * range, and no other (upstream-owned) migration does. See
 * `docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md` and
 * `docs/adr/0024-local-only-modules-that-depend-on-commerce-also-live-in-9xx.md`
 * in awcms-one, and `AGENTS.md`'s subtree section.
 *
 * ADR-0015 phrased this around `commerce` specifically — the only local-only
 * migration set that existed at the time. ADR-0024 (Issue #270) generalizes
 * it: `practice_irm` is a SECOND local-only module, admitted to the same
 * `9xx` range for the same collision-avoidance reason, plus a real ordering
 * one of its own — `awcms_practice_irm_sessions` has a hard FK into
 * `commerce`'s own tables, so its migration cannot be numbered below the
 * commerce migrations that create them. `LOCAL_ONLY_AREA_PREFIXES` is that
 * allowlist: SMALL and REASONED on purpose (ADR-0024's own "Consequences" —
 * a future entry needs the same two-part justification, not just "it would
 * be convenient").
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const SQL_DIR = path.resolve(import.meta.dir, "..", "sql");
const FILE_PATTERN = /^(\d{3})_awcms_([a-z0-9_]+)\.sql$/;

/**
 * Area prefixes (the `awcms_<area>_...` segment of a migration filename)
 * that are LOCAL-ONLY to `awcms-one` and therefore exempt from the `< 900`
 * rule — see this file's own header and ADR-0024.
 *
 * - `commerce` (ADR-0015, issue #72) — the original entry.
 * - `practice_irm` (ADR-0024, issue #270) — IRMbyDUS's five-domain content +
 *   practice-session module; `awcms_practice_irm_sessions` has a hard FK
 *   into `commerce`'s own tables, so it cannot be numbered below them.
 */
const LOCAL_ONLY_AREA_PREFIXES = ["commerce", "practice_irm"] as const;

function migrationFiles(): {
  name: string;
  prefix: number;
  isLocalOnly: boolean;
}[] {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = FILE_PATTERN.exec(name);

      if (!match) {
        throw new Error(`Unexpected migration file name: ${name}`);
      }

      const [, prefix, area] = match as unknown as [string, string, string];

      return {
        name,
        prefix: Number(prefix),
        isLocalOnly: LOCAL_ONLY_AREA_PREFIXES.some(
          (allowed) => area === allowed || area.startsWith(`${allowed}_`)
        )
      };
    });
}

describe("commerce migrations stay in the reserved 9xx range", () => {
  test("every local-only migration has a 3-digit prefix in 900-999", () => {
    for (const file of migrationFiles().filter((f) => f.isLocalOnly)) {
      expect(file.prefix).toBeGreaterThanOrEqual(900);
      expect(file.prefix).toBeLessThanOrEqual(999);
    }
  });

  test("every other migration has a 3-digit prefix below 900", () => {
    for (const file of migrationFiles().filter((f) => !f.isLocalOnly)) {
      expect(file.prefix).toBeLessThan(900);
    }
  });

  test("at least the sixteen known commerce migrations are present", () => {
    const commerceFiles = migrationFiles().filter(
      (f) =>
        f.name.includes("_awcms_commerce_") ||
        f.name.includes("_awcms_commerce.")
    );

    expect(commerceFiles.length).toBeGreaterThanOrEqual(16);
  });

  test("at least the four known practice_irm migrations are present", () => {
    const practiceIrmFiles = migrationFiles().filter((f) =>
      f.name.includes("_awcms_practice_irm_")
    );

    expect(practiceIrmFiles.length).toBeGreaterThanOrEqual(4);
  });
});
