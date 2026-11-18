/**
 * The worker e-mail guard must END table-driven, with commerce's campaign
 * category as a row, whichever order a database applies the migrations in
 * (upstream ADR-0164; owner decision 2026-11-18). Replaces the old
 * `commerce-email-worker-guard.test.ts`, which held the hard-coded commerce
 * body of `sql/1033` to a superset of every earlier definition: that body is
 * now only history, and `sql/1064` restores the data-driven function.
 *
 * Two orders exist and both are simulated here, statically (no database):
 *
 *   FRESH     every migration in numeric order: ... 371, 410, 1033, 1064.
 *   EXISTING  a database that applied everything up to the previous sync
 *             (`sql/1033` included) and now applies what arrived with this one:
 *             the applied ones first, then the pending ones in numeric order
 *             (371 ... 414, 1064).
 *
 * In both, the LAST migration that defines `awcms_email_guard_worker_insert`
 * must be `sql/1064`, its body must equal `sql/410`'s (so the function reads
 * `awcms_email_worker_categories` and nothing is hard-coded), and the rows the
 * table ends with must hold every category the pre-410 guard allowed plus
 * `derived.commerce_campaign`. What it does not prove: PostgreSQL executing the
 * function (`commerce-campaigns.integration.test.ts`, "one dispatch tick runs
 * end to end as the real awcms_worker role", is DATABASE_URL-gated).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  collectSeededWorkerCategories,
  GUARD_REISSUE_EXCEPTIONS
} from "../scripts/extension-points-check";

const SQL_DIR = path.join(import.meta.dir, "..", "sql");
const FUNCTION_NAME = "awcms_email_guard_worker_insert";
const TABLE_DRIVEN_MIGRATION =
  "410_awcms_email_worker_categories_allow_list.sql";
const COMMERCE_1033 = "1033_awcms_commerce_campaign_worker_email_category.sql";
const COMMERCE_1064 = "1064_awcms_commerce_worker_email_category_data.sql";

function prefix(name: string): number {
  return Number.parseInt(name.split("_")[0]!, 10);
}

const all = readdirSync(SQL_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort((a, b) => prefix(a) - prefix(b))
  .map((name) => ({
    name,
    sql: readFileSync(path.join(SQL_DIR, name), "utf8")
  }));

const byName = new Map(all.map((file) => [file.name, file.sql]));

const definesGuard = (sql: string) =>
  new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${FUNCTION_NAME}`,
    "i"
  ).test(sql);

/** The function statement of a migration, whitespace-normalised. */
function functionBody(sql: string): string {
  const start = sql.search(
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${FUNCTION_NAME}`, "i")
  );
  const end = sql.indexOf("$$;", sql.indexOf("$$", start) + 2);

  return sql.slice(start, end + 3).replace(/\s+/g, " ");
}

/** The migration whose definition of the guard is the one in force at the end. */
function lastDefiner(order: readonly string[]): string | undefined {
  return order.filter((name) => definesGuard(byName.get(name)!)).at(-1);
}

const fresh = all.map((file) => file.name);

// A database that had applied everything that existed at the previous sync:
// every commerce migration up to 1063 and upstream's up to 324.
const applied = all
  .filter((file) =>
    prefix(file.name) >= 880
      ? prefix(file.name) < 1064
      : prefix(file.name) <= 324
  )
  .map((file) => file.name);
const pending = all
  .map((file) => file.name)
  .filter((name) => !applied.includes(name));
const existing = [...applied, ...pending];

describe("the worker e-mail guard ends table-driven, in either migration order", () => {
  test("the simulation is not vacuous: sql/1033 is applied before 371 and 410 only in the existing order", () => {
    expect(existing.indexOf(COMMERCE_1033)).toBeLessThan(
      existing.indexOf(TABLE_DRIVEN_MIGRATION)
    );
    expect(fresh.indexOf(COMMERCE_1033)).toBeGreaterThan(
      fresh.indexOf(TABLE_DRIVEN_MIGRATION)
    );
    expect(pending).toContain(TABLE_DRIVEN_MIGRATION);
    expect(pending).toContain(COMMERCE_1064);
    expect(applied).toContain(COMMERCE_1033);
  });

  for (const [label, order] of [
    ["fresh", fresh],
    ["existing", existing]
  ] as const) {
    test(`${label}: the last definition of the guard is sql/1064`, () => {
      expect(lastDefiner(order)).toBe(COMMERCE_1064);
    });
  }

  test("sql/1064's function body is exactly sql/410's table-driven body", () => {
    expect(functionBody(byName.get(COMMERCE_1064)!)).toBe(
      functionBody(byName.get(TABLE_DRIVEN_MIGRATION)!)
    );
    expect(functionBody(byName.get(COMMERCE_1064)!)).toContain(
      "awcms_email_worker_categories"
    );
    expect(functionBody(byName.get(COMMERCE_1064)!)).not.toMatch(
      /category\s+NOT\s+IN\s*\(/i
    );
  });

  test("sql/1033 stays the hard-coded history it was (byte-identical, so its checksum holds)", () => {
    expect(functionBody(byName.get(COMMERCE_1033)!)).toMatch(
      /NEW\.category\s+NOT\s+IN\s*\(/i
    );
    expect(functionBody(byName.get(COMMERCE_1033)!)).toContain(
      "derived.commerce_campaign"
    );
  });

  test("the table ends with every pre-410 category plus the commerce campaign row", () => {
    const { seeded, unparseable } = collectSeededWorkerCategories(all);

    expect(unparseable).toEqual([]);
    for (const category of [
      "hr.attendance_correction_applied",
      "hr.attendance_correction_rejected",
      "hr.attendance_correction_cancelled",
      "crm.follow_up_assigned",
      "crm.follow_up_due",
      "crm.follow_up_escalated",
      "derived.commerce_campaign"
    ]) {
      expect(seeded.has(category), category).toBe(true);
    }
  });

  test("exactly sql/1033 and sql/1064 are excepted from the re-issue gate, and they are the only post-410 definers", () => {
    expect(Object.keys(GUARD_REISSUE_EXCEPTIONS).sort()).toEqual(
      [COMMERCE_1033, COMMERCE_1064].sort()
    );
    expect(
      fresh
        .filter((name) => prefix(name) > 410)
        .filter((name) => definesGuard(byName.get(name)!))
        .sort()
    ).toEqual([COMMERCE_1033, COMMERCE_1064].sort());
  });
});
