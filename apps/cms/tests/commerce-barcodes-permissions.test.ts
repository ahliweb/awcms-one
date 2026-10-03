/**
 * Barcode permission separation (Issue #292, ADR-0032). Pure - no database.
 * The rule: resolving a scanned code, assigning one, and ringing up a sale are
 * different authorities. A barcode is an identifier, never a credential, so the
 * caller is authorised before the code is looked at. Proved the same ways
 * `commerce-documents-permissions.test.ts` proves its own: the keys are
 * declared and seeded, each is enforced by exactly the route that needs it
 * (read from the route SOURCE), and a REAL access evaluation of cashier-shaped
 * grants.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import {
  evaluateAccess,
  type AccessAction,
  type TenantContext
} from "../src/modules/identity-access/domain/access-control";
import { COMMERCE_BARCODES_ACTIVITY_CODE } from "../src/modules/commerce/domain/commerce-permissions";

const KEYS = ["commerce.barcodes.read", "commerce.barcodes.update"] as const;

describe("barcode permissions are declared, seeded and enforced", () => {
  test("module.ts declares exactly the two keys", () => {
    const declared = (
      listModules().find((module) => module.key === "commerce")?.permissions ??
      []
    )
      .filter(
        (permission) =>
          permission.activityCode === COMMERCE_BARCODES_ACTIVITY_CODE
      )
      .map(
        (permission) =>
          `commerce.${permission.activityCode}.${permission.action}`
      );
    expect(declared.sort()).toEqual([...KEYS].sort());
  });

  test("sql/976 seeds exactly those keys", async () => {
    const sql = await readFile(
      "sql/976_awcms_commerce_barcodes_permissions.sql",
      "utf8"
    );
    const seeded = [
      ...sql.matchAll(/\('commerce', '([a-z_]+)', '([a-z_]+)',/g)
    ].map((match) => `commerce.${match[1]}.${match[2]}`);
    expect(seeded.sort()).toEqual([...KEYS].sort());
  });

  test("the shared guards name the two keys, and each route uses the right one", async () => {
    const shared = await readFile(
      "src/modules/commerce/application/barcode-http.ts",
      "utf8"
    );
    expect(shared).toMatch(
      /BARCODE_READ_GUARD = \{[^}]*COMMERCE_BARCODES_ACTIVITY_CODE[^}]*action: "read"/s
    );
    expect(shared).toMatch(
      /BARCODE_UPDATE_GUARD = \{[^}]*COMMERCE_BARCODES_ACTIVITY_CODE[^}]*action: "update"/s
    );

    const lookup = await readFile(
      "src/pages/api/v1/commerce/barcodes/lookup.ts",
      "utf8"
    );
    expect(lookup).toContain("authorize: BARCODE_READ_GUARD");
    expect(lookup).not.toContain("BARCODE_UPDATE_GUARD");

    const index = await readFile(
      "src/pages/api/v1/commerce/barcodes/index.ts",
      "utf8"
    );
    // GET reads, PUT updates - and nothing else.
    expect(index.match(/authorize: BARCODE_READ_GUARD/g)).toHaveLength(1);
    expect(index.match(/authorize: BARCODE_UPDATE_GUARD/g)).toHaveLength(1);
  });

  test("no barcode route requires commerce.pos.create or a products key", async () => {
    for (const file of ["lookup.ts", "index.ts"]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/barcodes/${file}`,
        "utf8"
      );
      expect(source).not.toContain("COMMERCE_POS_ACTIVITY_CODE");
      expect(source).not.toContain("COMMERCE_PRODUCTS_ACTIVITY_CODE");
    }
  });

  test("every route is gated on the tenant's barcode feature", async () => {
    for (const file of ["lookup.ts", "index.ts"]) {
      const source = await readFile(
        `src/pages/api/v1/commerce/barcodes/${file}`,
        "utf8"
      );
      expect(source).toContain("requireBarcodeFeature(tx, tenantId)");
    }
  });
});

describe("grants do not leak across the barcode keys", () => {
  const CONTEXT: TenantContext = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    tenantUserId: "22222222-2222-4222-8222-222222222222",
    identityId: "33333333-3333-4333-8333-333333333333",
    roles: ["cashier"]
  };

  const allowed = (
    keys: ReadonlySet<string>,
    activityCode: string,
    action: AccessAction
  ): boolean =>
    evaluateAccess(
      CONTEXT,
      { moduleKey: "commerce", activityCode, action },
      keys
    ).allowed;

  test("a cashier or a product editor gains no barcode authority", () => {
    for (const grants of [
      new Set(["commerce.pos.create"]),
      new Set(["commerce.products.read", "commerce.products.update"])
    ]) {
      expect(allowed(grants, "barcodes", "read")).toBe(false);
      expect(allowed(grants, "barcodes", "update")).toBe(false);
    }
  });

  test("read does not imply update and update does not imply read", () => {
    const reader = new Set(["commerce.barcodes.read"]);
    expect(allowed(reader, "barcodes", "read")).toBe(true);
    expect(allowed(reader, "barcodes", "update")).toBe(false);
    const editor = new Set(["commerce.barcodes.update"]);
    expect(allowed(editor, "barcodes", "update")).toBe(true);
    expect(allowed(editor, "barcodes", "read")).toBe(false);
  });

  test("barcode keys grant nothing about selling", () => {
    const both = new Set(KEYS);
    expect(allowed(both, "pos", "create")).toBe(false);
    expect(allowed(both, "products", "update")).toBe(false);
  });
});
