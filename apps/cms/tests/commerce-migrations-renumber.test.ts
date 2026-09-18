/**
 * `commerce:migrations:renumber` (issue #72, awcms-one) — pure unit tests for
 * `scripts/commerce-migrations-renumber.ts`'s `OLD_TO_NEW` map and
 * `planRenames`. No database, no network.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  OLD_TO_NEW,
  planRenames
} from "../scripts/commerce-migrations-renumber";

const SQL_DIR = path.resolve(import.meta.dir, "..", "sql");
const sqlFiles = new Set(readdirSync(SQL_DIR));

describe("OLD_TO_NEW", () => {
  test("has exactly 16 entries", () => {
    expect(Object.keys(OLD_TO_NEW)).toHaveLength(16);
  });

  test("every new name exists on disk under sql/", () => {
    for (const newName of Object.values(OLD_TO_NEW)) {
      expect(sqlFiles.has(newName)).toBe(true);
    }
  });

  test("every old name does not exist on disk under sql/", () => {
    for (const oldName of Object.keys(OLD_TO_NEW)) {
      expect(sqlFiles.has(oldName)).toBe(false);
    }
  });

  test("every new name is a 9xx commerce migration", () => {
    for (const newName of Object.values(OLD_TO_NEW)) {
      expect(newName).toMatch(/^9\d{2}_awcms_commerce_[a-z0-9_]+\.sql$/);
    }
  });
});

describe("planRenames", () => {
  test("nothing applied -> nothing to do", () => {
    const plan = planRenames([]);

    expect(plan.rename).toHaveLength(0);
    expect(plan.skip).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test("nothing applied among unrelated migrations -> nothing to do", () => {
    const plan = planRenames([
      "001_awcms_bootstrap.sql",
      "153_awcms_blog_institution_logo.sql"
    ]);

    expect(plan.rename).toHaveLength(0);
    expect(plan.skip).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test("all 16 old names applied -> 16 renames", () => {
    const plan = planRenames(Object.keys(OLD_TO_NEW));

    expect(plan.rename).toHaveLength(16);
    expect(plan.skip).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);

    const renamedOldNames = new Set(plan.rename.map(([oldName]) => oldName));
    const renamedNewNames = new Set(plan.rename.map(([, newName]) => newName));

    for (const [oldName, newName] of Object.entries(OLD_TO_NEW)) {
      expect(renamedOldNames.has(oldName)).toBe(true);
      expect(renamedNewNames.has(newName)).toBe(true);
    }
  });

  test("both old and new applied for the same migration -> conflict", () => {
    const [oldName, newName] = Object.entries(OLD_TO_NEW)[0]!;
    const plan = planRenames([oldName, newName]);

    expect(plan.conflicts).toEqual([[oldName, newName]]);
    expect(plan.rename).toHaveLength(0);
  });

  test("already renamed (new name applied, old not) -> skip", () => {
    const newName = Object.values(OLD_TO_NEW)[0]!;
    const plan = planRenames([newName]);

    expect(plan.skip).toEqual([newName]);
    expect(plan.rename).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  test("mixed: some old applied, some new applied, some untouched", () => {
    const entries = Object.entries(OLD_TO_NEW);
    const [oldA] = entries[0]!;
    const [, newB] = entries[1]!;

    const plan = planRenames([oldA, newB]);

    expect(plan.rename).toEqual([[oldA, OLD_TO_NEW[oldA]!]]);
    expect(plan.skip).toEqual([newB]);
    expect(plan.conflicts).toHaveLength(0);
  });
});
