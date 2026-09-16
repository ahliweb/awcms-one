/**
 * `/admin/commerce` (product CRUD) and `/admin/commerce-categories`
 * (category CRUD) — Issue #23. Both screens claim every one of `commerce`'s
 * ten declared permissions (five per activity code, including `restore`),
 * which is what lets both leave `scripts/admin-screen-coverage-ledger.ts`'s
 * `NOT_YET_SCREENED` in the same change.
 *
 * Pure — no database, no network. Runs in `quality` on every PR.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { NOT_YET_SCREENED } from "../scripts/admin-screen-coverage-ledger";

const PRODUCTS_PAGE = "src/pages/admin/commerce.astro";
const CATEGORIES_PAGE = "src/pages/admin/commerce-categories.astro";

const PRODUCT_ROUTES = [
  "src/pages/api/v1/commerce/products/index.ts",
  "src/pages/api/v1/commerce/products/[id].ts",
  "src/pages/api/v1/commerce/products/[id]/restore.ts",
  "src/pages/api/v1/commerce/products/by-slug/[slug].ts",
  "src/pages/api/v1/commerce/products/[id]/images/index.ts",
  "src/pages/api/v1/commerce/products/[id]/images/[imageId].ts",
  "src/pages/api/v1/commerce/products/[id]/variants/index.ts",
  "src/pages/api/v1/commerce/products/[id]/variants/[variantId].ts"
];
const CATEGORY_ROUTES = [
  "src/pages/api/v1/commerce/categories/index.ts",
  "src/pages/api/v1/commerce/categories/[id].ts",
  "src/pages/api/v1/commerce/categories/[id]/restore.ts"
];

type Triple = `${string}.${string}.${string}`;

/** Same two spellings `admin-idn-regions-page-contract.test.ts` scans for — see Issue #450. */
function pageTriplesFrom(source: string): Set<Triple> {
  const found = new Set<Triple>();

  for (const match of source.matchAll(
    /permissionKey\(\s*"([a-z_]+)",\s*"([a-z_]+)",\s*"([a-z_]+)"\s*\)/g
  )) {
    found.add(`${match[1]}.${match[2]}.${match[3]}` as Triple);
  }

  for (const match of source.matchAll(
    /moduleKey:\s*"([a-z_]+)",\s*\n?\s*activityCode:\s*"([a-z_]+)",\s*\n?\s*action:\s*"([a-z_]+)"/g
  )) {
    found.add(`${match[1]}.${match[2]}.${match[3]}` as Triple);
  }

  return found;
}

function declaredTriples(): Set<Triple> {
  return new Set<Triple>(
    (listModules()
      .find((module) => module.key === "commerce")
      ?.permissions?.map(
        (permission) =>
          `commerce.${permission.activityCode}.${permission.action}`
      ) ?? []) as Triple[]
  );
}

/** Routes compose their guard from the shared activity-code constants, not literals. */
async function enforcedTriples(
  routes: readonly string[],
  activityCodeConstant: string,
  activityCode: string
): Promise<Set<Triple>> {
  const found = new Set<Triple>();

  for (const route of routes) {
    const source = await readFile(route, "utf8");
    for (const match of source.matchAll(
      new RegExp(
        `activityCode:\\s*${activityCodeConstant},\\s*\\n?\\s*action:\\s*"([a-z_]+)"`,
        "g"
      )
    )) {
      found.add(`commerce.${activityCode}.${match[1]}` as Triple);
    }
  }

  return found;
}

describe("commerce module descriptor — restore is declared for both activity codes", () => {
  test("ten permissions total, five per activity code, including restore", () => {
    const declared = declaredTriples();
    expect(declared.size).toBe(10);

    for (const activityCode of ["categories", "products"]) {
      for (const action of ["read", "create", "update", "delete", "restore"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(true);
      }
    }
  });

  test("neither commerce activity code's permissions remain on NOT_YET_SCREENED", () => {
    expect(
      NOT_YET_SCREENED.filter((key) => key.startsWith("commerce."))
    ).toEqual([]);
  });
});

describe("/admin/commerce (products) permission gates", () => {
  test("every key the page gates on is declared, and is one the routes enforce", async () => {
    const page = await readFile(PRODUCTS_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    const declared = declaredTriples();

    expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);
    // read/create/update/delete/restore — every products.* permission.
    expect(
      [...pageKeys].filter((key) => key.startsWith("commerce.products.")).length
    ).toBe(5);

    const enforced = await enforcedTriples(
      PRODUCT_ROUTES,
      "COMMERCE_PRODUCTS_ACTIVITY_CODE",
      "products"
    );
    expect(enforced.size).toBeGreaterThan(0);
    expect(
      [...pageKeys]
        .filter((key) => key.startsWith("commerce.products."))
        .filter((key) => !enforced.has(key))
    ).toEqual([]);
  });

  test("the page never writes raw SQL — every mutation posts to a guarded endpoint", async () => {
    const page = await readFile(PRODUCTS_PAGE, "utf8");

    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).toContain('"/api/v1/commerce/products"');
    expect(page).toContain("/restore`");
    expect(page).toContain("/images`");
    expect(page).toContain("/variants`");
  });

  test("the sidebar entry points at this page and is gated on a real permission", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find((entry) => entry.path === "/admin/commerce");

    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.products.read");
    expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(true);
  });

  test("costPrice is fetched through the admin-only path, never the public one", async () => {
    const page = await readFile(PRODUCTS_PAGE, "utf8");

    expect(page).toContain("listProductsForAdmin(");
    expect(page).not.toContain("listProducts(tx");
  });
});

describe("/admin/commerce-categories permission gates", () => {
  test("every key the page gates on is declared, and is one the routes enforce", async () => {
    const page = await readFile(CATEGORIES_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    const declared = declaredTriples();

    expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);
    expect(
      [...pageKeys].filter((key) => key.startsWith("commerce.categories."))
        .length
    ).toBe(5);

    const enforced = await enforcedTriples(
      CATEGORY_ROUTES,
      "COMMERCE_CATEGORIES_ACTIVITY_CODE",
      "categories"
    );
    expect(enforced.size).toBeGreaterThan(0);
    expect(
      [...pageKeys]
        .filter((key) => key.startsWith("commerce.categories."))
        .filter((key) => !enforced.has(key))
    ).toEqual([]);
  });

  test("the page never writes raw SQL — every mutation posts to a guarded endpoint", async () => {
    const page = await readFile(CATEGORIES_PAGE, "utf8");

    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).toContain('"/api/v1/commerce/categories"');
    expect(page).toContain("/restore`");
  });

  test("does not offer re-parenting on update — parentId is create-only", async () => {
    const page = await readFile(CATEGORIES_PAGE, "utf8");
    const updateCall = page.match(
      /sendJson\("PATCH",\s*`\/api\/v1\/commerce\/categories\/\$\{id\}`,\s*\{([\s\S]*?)\}\)/
    );

    expect(updateCall).not.toBeNull();
    expect(updateCall![1]).not.toContain("parentId");
  });

  test("the sidebar entry points at this page and is gated on a real permission", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find(
        (entry) => entry.path === "/admin/commerce-categories"
      );

    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.categories.read");
    expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(true);
  });
});
