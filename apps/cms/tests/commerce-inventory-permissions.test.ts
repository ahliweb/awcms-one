/**
 * Commerce inventory permissions (Issue #282, ADR-0038 D7). Pure - no database.
 * The keys are declared by the module, seeded by `sql/947`, enforced by exactly
 * the routes that need them (read from the route SOURCE), and the module
 * descriptor declares the `inventory` dependency (D10).
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { COMMERCE_INVENTORY_ACTIVITY_CODE } from "../src/modules/commerce/domain/commerce-permissions";

const KEYS = ["commerce.inventory.configure", "commerce.inventory.read"];

describe("commerce inventory permissions", () => {
  const commerce = listModules().find((module) => module.key === "commerce")!;

  test("module.ts declares exactly the two keys", () => {
    const declared = (commerce.permissions ?? [])
      .filter((p) => p.activityCode === COMMERCE_INVENTORY_ACTIVITY_CODE)
      .map((p) => `commerce.${p.activityCode}.${p.action}`);
    expect(declared.sort()).toEqual(KEYS);
  });

  test("sql/947 seeds exactly those keys", async () => {
    const sql = await readFile(
      "sql/947_awcms_commerce_inventory_adapter.sql",
      "utf8"
    );
    const seeded = [
      ...sql.matchAll(/\('commerce', '([a-z_]+)', '([a-z_]+)',/g)
    ].map((match) => `commerce.${match[1]}.${match[2]}`);
    expect(seeded.sort()).toEqual(KEYS);
  });

  test("the read routes use the read guard and the two writes the configure guard", async () => {
    const read = async (file: string) =>
      readFile(`src/pages/api/v1/commerce/inventory/${file}.ts`, "utf8");
    for (const file of ["index", "reconciliation"]) {
      expect(await read(file)).toContain("INVENTORY_READ_GUARD");
      expect(await read(file)).not.toContain("INVENTORY_CONFIGURE_GUARD");
    }
    for (const file of ["resync", "rollback"]) {
      expect(await read(file)).toContain("INVENTORY_CONFIGURE_GUARD");
      expect(await read(file)).not.toContain("INVENTORY_READ_GUARD");
    }
  });

  test("the shared guards name the keys", async () => {
    const http = await readFile(
      "src/modules/commerce/application/commerce-inventory-http.ts",
      "utf8"
    );
    expect(http).toMatch(
      /INVENTORY_READ_GUARD = \{[^}]*COMMERCE_INVENTORY_ACTIVITY_CODE[^}]*action: "read"/s
    );
    expect(http).toMatch(
      /INVENTORY_CONFIGURE_GUARD = \{[^}]*COMMERCE_INVENTORY_ACTIVITY_CODE[^}]*action: "configure"/s
    );
  });

  test("configure is a high-risk action; read is not", async () => {
    const source = await readFile(
      "src/modules/identity-access/domain/access-control.ts",
      "utf8"
    );
    const start = source.indexOf("const HIGH_RISK_ACTIONS");
    const block = source.slice(start, source.indexOf("]);", start));
    expect(block).toContain('"configure"');
    expect(block).not.toContain('"read"');
  });
});

describe("commerce depends on inventory (D10)", () => {
  test("the descriptor declares it, and inventory does not depend back", () => {
    const modules = listModules();
    const commerce = modules.find((module) => module.key === "commerce")!;
    const inventory = modules.find((module) => module.key === "inventory")!;
    expect(commerce.dependencies).toContain("inventory");
    expect(inventory.dependencies).not.toContain("commerce");
  });
});

describe("the migration is self-contained (ADR-0037 D2)", () => {
  test("sql/947 names no table from the 994-999 range", async () => {
    const sql = await readFile(
      "sql/947_awcms_commerce_inventory_adapter.sql",
      "utf8"
    );
    for (const table of [
      "awcms_commerce_returns",
      "awcms_commerce_return_lines",
      "awcms_commerce_refunds",
      "awcms_commerce_operational"
    ]) {
      expect(sql).not.toContain(table);
    }
  });
});
