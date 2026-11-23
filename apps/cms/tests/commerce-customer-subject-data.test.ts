/**
 * The shopper data-subject registry cannot silently miss a table (Issue #529,
 * ADR-0055 D2/D4). Pure: parses `sql/` and the registry, no database.
 *
 * What it holds in place:
 *   1. Every `awcms_commerce_*` table is in EXACTLY ONE of the registry, the
 *      contact-matched list or the "not about a customer" list, and nothing
 *      names a table that does not exist.
 *   2. A table with a customer, account, owner-customer or order column is
 *      always in the registry (a new one fails here, not in a shopper's export).
 *   3. Every registered key, redacted and anonymised column exists.
 *   4. A column whose name looks like a secret is redacted or reviewed.
 *   5. The erasure code deletes and updates exactly the tables the registry says
 *      it does, and writes nothing to a retained table.
 *   6. Every commerce `subjectData` descriptor key resolves to a classified table.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { commerceModule } from "../src/modules/commerce/module";
import {
  CONTACT_MATCHED_TABLES,
  NOT_ABOUT_A_CUSTOMER,
  REVIEWED_NOT_SECRET_COLUMNS,
  SECRET_COLUMN_PATTERN,
  SUBJECT_TABLES,
  SUBJECT_TABLE_NAMES,
  allClassifiedTables
} from "../src/modules/commerce/domain/customer-subject-data";

const SQL_DIR = path.resolve(import.meta.dir, "../sql");
const ERASURE_SOURCE = readFileSync(
  path.resolve(
    import.meta.dir,
    "../src/modules/commerce/application/customer-subject-erasure.ts"
  ),
  "utf8"
);

function migrationOrder(name: string): number {
  return Number(/^(\d+)_/.exec(name)?.[1] ?? "0");
}

function parseCommerceColumns(): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => migrationOrder(a) - migrationOrder(b));

  for (const file of files) {
    const text = readFileSync(path.join(SQL_DIR, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    for (const match of text.matchAll(
      /CREATE TABLE IF NOT EXISTS (awcms_commerce_\w+)\s*\(([\s\S]*?)\n\);/g
    )) {
      const columns = new Set<string>();
      let depth = 0;
      for (const line of match[2]!.split("\n")) {
        if (depth === 0) {
          const column =
            /^\s{2}([a-z_][a-z0-9_]*)\s+[a-z]/.exec(line)?.[1] ?? null;
          if (
            column &&
            !["constraint", "primary", "unique", "foreign", "check"].includes(
              column
            )
          ) {
            columns.add(column);
          }
        }
        for (const ch of line) {
          if (ch === "(") depth += 1;
          if (ch === ")") depth -= 1;
        }
      }
      tables.set(match[1]!, columns);
    }

    for (const statement of text.split(";")) {
      const alter = /ALTER TABLE (awcms_commerce_\w+)/.exec(statement);
      if (!alter) continue;
      const columns = tables.get(alter[1]!);
      if (!columns) continue;
      for (const add of statement.matchAll(
        /ADD COLUMN IF NOT EXISTS ([a-z_][a-z0-9_]*)/g
      )) {
        columns.add(add[1]!);
      }
    }
  }
  return tables;
}

const TABLES = parseCommerceColumns();
const CUSTOMER_LINK_COLUMNS = [
  "customer_id",
  "account_id",
  "owner_customer_id",
  "order_id",
  "to_phone_hash"
];

describe("customer subject registry covers every commerce table", () => {
  test("the parser found the schema", () => {
    expect(TABLES.size).toBeGreaterThan(90);
    expect(TABLES.get("awcms_commerce_customers")?.has("phone")).toBe(true);
    expect(TABLES.get("awcms_commerce_customers")?.has("erased_at")).toBe(true);
  });

  test("every table is classified exactly once, and nothing names a missing table", () => {
    const registry = new Set(SUBJECT_TABLE_NAMES);
    const contact = new Set(Object.keys(CONTACT_MATCHED_TABLES));
    const notAbout = new Set(Object.keys(NOT_ABOUT_A_CUSTOMER));

    const unclassified = [...TABLES.keys()].filter(
      (t) => !registry.has(t) && !contact.has(t) && !notAbout.has(t)
    );
    expect(unclassified).toEqual([]);

    const twice = [...TABLES.keys()].filter(
      (t) =>
        [registry.has(t), contact.has(t), notAbout.has(t)].filter(Boolean)
          .length > 1
    );
    expect(twice).toEqual([]);

    const missing = [...allClassifiedTables()].filter((t) => !TABLES.has(t));
    expect(missing).toEqual([]);
  });

  test("a table with a customer, account or order column is never filed as 'not about a customer'", () => {
    const wrong = Object.keys(NOT_ABOUT_A_CUSTOMER).filter((table) => {
      const columns = TABLES.get(table);
      return (
        columns && CUSTOMER_LINK_COLUMNS.some((column) => columns.has(column))
      );
    });
    expect(wrong).toEqual([]);

    const uncovered = [...TABLES.entries()]
      .filter(([, columns]) =>
        CUSTOMER_LINK_COLUMNS.some((column) => columns.has(column))
      )
      .map(([table]) => table)
      .filter(
        (table) =>
          !SUBJECT_TABLE_NAMES.includes(table) &&
          !(table in CONTACT_MATCHED_TABLES)
      );
    expect(uncovered).toEqual([]);
  });

  test("every registered key, redacted and anonymised column exists", () => {
    const problems: string[] = [];
    for (const entry of SUBJECT_TABLES) {
      const columns = TABLES.get(entry.table);
      if (!columns) {
        problems.push(`${entry.table}: no such table`);
        continue;
      }
      if (!columns.has(entry.keyColumn)) {
        problems.push(`${entry.table}.${entry.keyColumn}: key column missing`);
      }
      for (const column of entry.redactedColumns) {
        if (!columns.has(column)) {
          problems.push(`${entry.table}.${column}: redacted column missing`);
        }
      }
      if (entry.erasure.action === "anonymize") {
        for (const column of entry.erasure.columns) {
          if (!columns.has(column)) {
            problems.push(
              `${entry.table}.${column}: anonymised column missing`
            );
          }
        }
      }
      expect(entry.table).toMatch(/^awcms_commerce_[a-z_]+$/);
    }
    expect(problems).toEqual([]);
  });

  test("a secret-looking column is redacted or reviewed", () => {
    const leaks: string[] = [];
    for (const entry of SUBJECT_TABLES) {
      if (!entry.exported) continue;
      for (const column of TABLES.get(entry.table) ?? []) {
        if (!SECRET_COLUMN_PATTERN.test(column)) continue;
        if (entry.redactedColumns.includes(column)) continue;
        if (`${entry.table}.${column}` in REVIEWED_NOT_SECRET_COLUMNS) continue;
        leaks.push(`${entry.table}.${column}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("the reviewed allow-list names only real columns", () => {
    const stale = Object.keys(REVIEWED_NOT_SECRET_COLUMNS).filter((key) => {
      const [table, column] = key.split(".") as [string, string];
      return !TABLES.get(table)?.has(column);
    });
    expect(stale).toEqual([]);
  });

  test("every commerce subjectData descriptor resolves to a classified table", () => {
    const classified = allClassifiedTables();
    const orphans = (commerceModule.subjectData ?? [])
      .filter((descriptor) => !classified.has(descriptor.tableName))
      .map((descriptor) => descriptor.key);
    expect(orphans).toEqual([]);
  });

  test("the rationale of a customer-keyed descriptor names the flow", () => {
    const orders = commerceModule.subjectData?.find(
      (d) => d.tableName === "awcms_commerce_orders"
    );
    expect(orders?.rationale).toContain("ADR-0055");
    const loyalty = commerceModule.subjectData?.find(
      (d) => d.tableName === "awcms_commerce_wishlists"
    );
    expect(loyalty?.rationale).toContain("DELETES");
  });
});

describe("the erasure code does what the registry says", () => {
  const deleted = new Set(
    [...ERASURE_SOURCE.matchAll(/DELETE FROM (awcms_commerce_\w+)/g)].map(
      (m) => m[1]!
    )
  );
  const updated = new Set(
    [...ERASURE_SOURCE.matchAll(/UPDATE (awcms_commerce_\w+)/g)].map(
      (m) => m[1]!
    )
  );

  test("every 'delete' table is deleted, and only those (OTPs by contact aside)", () => {
    const expected = new Set(
      SUBJECT_TABLES.filter((e) => e.erasure.action === "delete").map(
        (e) => e.table
      )
    );
    for (const [table, value] of Object.entries(CONTACT_MATCHED_TABLES)) {
      if (value.erasedByContact) expected.add(table);
    }
    expect(deleted).toEqual(expected);
  });

  test("every 'anonymize' table is updated, and nothing else is", () => {
    const expected = new Set(
      SUBJECT_TABLES.filter(
        (e) =>
          e.erasure.action === "anonymize" ||
          (e.erasure.action === "retain" && e.erasure.suspendOnErasure)
      ).map((e) => e.table)
    );
    expect(updated).toEqual(expected);
  });

  test("a retained table is never written by the erasure", () => {
    for (const entry of SUBJECT_TABLES) {
      if (entry.erasure.action !== "retain") continue;
      expect(deleted.has(entry.table)).toBe(false);
      // The one allowed write to a retained row is a declared suspension.
      expect(updated.has(entry.table)).toBe(!!entry.erasure.suspendOnErasure);
    }
  });

  test("every retain entry records a legal basis awaiting counsel", () => {
    for (const entry of SUBJECT_TABLES) {
      if (entry.erasure.action !== "retain") continue;
      expect(entry.erasure.legalBasis.length).toBeGreaterThan(40);
    }
  });
});
