/**
 * `commerce` never reads the commission ledger (Issue #391, ADR-0046).
 *
 * The acceptance criterion "commerce never reads commission tables" is a
 * property of the SOURCE, so it is asserted over the source: nothing under
 * `src/modules/commerce`, `src/pages/api/v1/commerce` or the commerce admin
 * screens may
 *
 *   - name a table owned by `hr_commission` or `hr_workforce` (`awcms_hr_*`),
 *   - import, require or dynamically import anything under `hr-commission/` or
 *     `hr-workforce/` (their `application/` and `domain/` code).
 *
 * with exactly ONE exception: `application/commission-attribution-port.ts`
 * imports `hr_commission`'s concrete `CommissionAccrualPort` adapter
 * (`createCommissionAccrualPort`), because the port's own contract says the
 * adapter is wired at the consumer's composition root and that file is
 * commerce's. Every other file depends on the TYPE in `_shared/ports/` and on
 * nothing else. If another file ever needs a commission fact, the answer is a
 * wider port, not a wider import.
 *
 * The migrations get the same treatment: no commerce-band migration may declare a
 * foreign key into an `awcms_hr_*` table (the employment id is opaque), and the
 * only statements that mention one are the worker grants the port's posting core
 * needs (`sql/1031`, and the four-column void grant of `sql/1051`).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const absolute = path.join(root, dir);
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(relative, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(relative);
    }
  }
  return out;
}

const COMMERCE_SOURCES = [
  ...sourceFiles("src/modules/commerce", [".ts"]),
  ...sourceFiles("src/pages/api/v1/commerce", [".ts"]),
  ...sourceFiles("src/pages/admin", [".astro"]).filter((file) =>
    path.basename(file).startsWith("commerce")
  ),
  ...sourceFiles("src/lib/ui", [".ts"]).filter((file) =>
    path.basename(file).startsWith("commerce")
  )
];

const ALLOWED_PORT_SEAM =
  "src/modules/commerce/application/commission-attribution-port.ts";
const ALLOWED_PORT_IMPORT =
  "../../hr-commission/application/hr-commission-accrual-port-adapter";

/** `hr-commission/` or `hr-workforce/` in any import-ish position (static, dynamic, require, re-export). */
const HR_DIRECTORY_REFERENCE =
  /["'`][^"'`\n]*\/hr-(?:commission|workforce)\/[^"'`\n]*["'`]/g;
const HR_TABLE_REFERENCE = /awcms_hr_[a-z_]+/g;

describe("commerce source files never reach into the hr_* ledgers", () => {
  test("the scan covers the commerce module, its API routes and its admin screens (it is not vacuous)", () => {
    expect(COMMERCE_SOURCES.length).toBeGreaterThan(150);
    expect(COMMERCE_SOURCES).toContain(ALLOWED_PORT_SEAM);
    expect(
      COMMERCE_SOURCES.some((file) => file.includes("commission/settings.ts"))
    ).toBe(true);
  });

  test("no commerce file names an hr_commission / hr_workforce table", () => {
    const offenders: string[] = [];
    for (const file of COMMERCE_SOURCES) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const match of text.matchAll(HR_TABLE_REFERENCE)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no commerce file imports hr-commission/ or hr-workforce/ code, except the one port seam and only for the adapter", () => {
    const offenders: string[] = [];
    for (const file of COMMERCE_SOURCES) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const match of text.matchAll(HR_DIRECTORY_REFERENCE)) {
        const specifier = match[0].slice(1, -1);
        if (file === ALLOWED_PORT_SEAM && specifier === ALLOWED_PORT_IMPORT) {
          continue;
        }
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the seam imports exactly the adapter and nothing else from hr-commission", () => {
    const text = readFileSync(path.join(root, ALLOWED_PORT_SEAM), "utf8");
    const specifiers = [...text.matchAll(HR_DIRECTORY_REFERENCE)].map((match) =>
      match[0].slice(1, -1)
    );
    expect(specifiers).toEqual([ALLOWED_PORT_IMPORT]);
  });

  test("the consumer and the directory depend on the port TYPE and the seam, nothing concrete", () => {
    for (const file of [
      "src/modules/commerce/application/commission-attribution.ts",
      "src/modules/commerce/application/commission-attribution-directory.ts",
      "src/modules/commerce/domain/commission-attribution.ts"
    ]) {
      const text = readFileSync(path.join(root, file), "utf8");
      expect(text).not.toMatch(HR_DIRECTORY_REFERENCE);
      expect(text).not.toMatch(HR_TABLE_REFERENCE);
    }
    const consumer = readFileSync(
      path.join(
        root,
        "src/modules/commerce/application/commission-attribution.ts"
      ),
      "utf8"
    );
    expect(consumer).toContain("_shared/ports/commission-accrual-port");
    expect(consumer).toContain("./commission-attribution-port");
  });

  test("the consumer never voids, reverses or rewrites an accrual: no void/reverse call, no UPDATE or DELETE of anything", () => {
    for (const file of [
      "src/modules/commerce/application/commission-attribution.ts",
      "src/modules/commerce/application/commission-attribution-port.ts"
    ]) {
      const text = readFileSync(path.join(root, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(text).not.toMatch(
        /\btransitionAccrual\b|\bvoidAccrual\b|\.void\(|\.reverse\(/
      );
      expect(text).not.toMatch(/\b(UPDATE|DELETE)\b/);
    }
  });
});

describe("commerce migrations never constrain against an hr_* table", () => {
  const COMMERCE_MIGRATION =
    /^(88\d|89\d|9\d\d|1\d{3})_awcms_commerce_.*\.sql$/;

  test("no commerce-band migration declares a foreign key into an awcms_hr_ table", () => {
    const files = readdirSync(path.join(root, "sql")).filter((name) =>
      COMMERCE_MIGRATION.test(name)
    );
    expect(files.length).toBeGreaterThan(80);

    const offenders: string[] = [];
    for (const name of files) {
      const text = readFileSync(path.join(root, "sql", name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n");
      if (/REFERENCES\s+awcms_hr_/i.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("the only commerce-band migrations that mention an awcms_hr_ table in a statement are the worker-grant migrations 1031 and 1051", () => {
    const files = readdirSync(path.join(root, "sql")).filter((name) =>
      COMMERCE_MIGRATION.test(name)
    );
    const mentioning: string[] = [];
    for (const name of files) {
      const text = readFileSync(path.join(root, "sql", name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n");
      if (/awcms_hr_/i.test(text)) mentioning.push(name);
    }
    expect(mentioning).toEqual([
      "1031_awcms_commerce_commission_attribution_permissions_grants.sql",
      "1051_awcms_commerce_commission_reversal_worker_grants.sql"
    ]);
  });
});
