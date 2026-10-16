/**
 * The commerce re-issue of `awcms_email_guard_worker_insert` (Issue #377,
 * `sql/1033`) must stay a superset of every earlier definition.
 *
 * Upstream's `sql/302` created the guard with an allow-list of worker e-mail
 * categories; commerce needs `derived.commerce_campaign` on it, and a commerce
 * migration sorts after every upstream one, so a later upstream re-issue of the
 * function (a new category) would be silently undone on a fresh database. This
 * test reads the migrations, collects the categories each definition allows, and
 * fails when the last definition (the commerce one) lacks a category an earlier
 * one has - the moment the next subtree sync must re-issue 1033.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SQL_DIR = path.join(import.meta.dir, "..", "sql");
const FUNCTION_NAME = "awcms_email_guard_worker_insert";

function prefix(name: string): number {
  return Number.parseInt(name.split("_")[0]!, 10);
}

function allowedCategories(sql: string): string[] {
  const body = sql.slice(sql.indexOf(FUNCTION_NAME));
  const list = /NEW\.category\s+NOT\s+IN\s*\(([^)]*)\)/i.exec(body);

  return list ? [...list[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!) : [];
}

describe("the worker e-mail guard re-issued by commerce", () => {
  const files = readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => prefix(a) - prefix(b))
    .map((name) => ({
      name,
      sql: readFileSync(path.join(SQL_DIR, name), "utf8")
    }))
    .filter(({ sql }) =>
      new RegExp(
        `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${FUNCTION_NAME}`,
        "i"
      ).test(sql)
    );

  test("the commerce migration is the last definition", () => {
    expect(files.at(-1)?.name).toBe(
      "1033_awcms_commerce_campaign_worker_email_category.sql"
    );
  });

  test("it allows every category an earlier definition allows, plus the campaign one", () => {
    const final = new Set(allowedCategories(files.at(-1)!.sql));

    for (const earlier of files.slice(0, -1)) {
      for (const category of allowedCategories(earlier.sql)) {
        expect(final.has(category)).toBe(true);
      }
    }
    expect(final.has("derived.commerce_campaign")).toBe(true);
  });

  test("it still pins search_path with pg_temp last and keeps the membership test", () => {
    const sql = files.at(-1)!.sql;

    expect(sql).toMatch(/SET search_path = public, pg_temp/);
    expect(sql).toMatch(
      /pg_has_role\(session_user, 'awcms_worker', 'MEMBER'\)/
    );
  });
});
