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
  test("fifty-one permissions total — five per catalog activity code (incl. restore), four per marketing code, two for settings, two each for orders/customers/affiliates/affiliate_commissions/conversations, three for reviews, one for whatsapp, three for campaigns, one for webhook_endpoints, one for pos", () => {
    // Issue #23: categories/products carry read/create/update/delete/restore.
    // Issue #26: flash_sales/vouchers/sliders/testimonials/popups carry
    // read/create/update/delete (soft delete only, no restore — the marketing
    // tables ship no restore endpoint, see the module description), and
    // settings carries read/update (a singleton has nothing to create or
    // delete as a separate capability; "reset" travels on update).
    // Issue #29: orders/customers carry only read/update (no create/delete —
    // an order/customer is created only through the anonymous storefront
    // path, and this increment ships no admin route that creates one
    // directly or hard-deletes one, see `commerce-permissions.ts`'s header),
    // reviews carries read/update/delete (moderation + soft delete, created
    // only through the anonymous storefront path).
    // Issue #108: whatsapp carries read only — diagnostics, no admin
    // create/update/delete over the outbox.
    // Issue #111: conversations carries read/update only — no create/delete
    // (a conversation is created only through the shopper's own
    // bearer-secured route, no hard-delete route exists), same reasoning as
    // orders/customers/affiliates above.
    // Issue #114: campaigns carries read/update/send — `send` is split from
    // `update` because it is the one action that actually reaches a real
    // inbox/phone (also gates cancel).
    // Issue #110: webhook_endpoints carries update only — one permission
    // gates list (masked)/create (token shown once)/revoke alike, per
    // contract #106's own OpenAPI note (see `commerce-permissions.ts`'s
    // header for the "nothing distinct to enforce" reasoning).
    // Issue #116: pos carries create only — the ONLY order-creation path
    // gated by a permission at all (every other one is anonymous or
    // provider/system-driven), per `commerce-permissions.ts`'s own header.
    const declared = declaredTriples();
    expect(declared.size).toBe(
      2 * 5 + 5 * 4 + 2 + 2 + 2 + 3 + 2 + 2 + 1 + 2 + 3 + 1 + 1
    );

    for (const activityCode of ["categories", "products"]) {
      for (const action of ["read", "create", "update", "delete", "restore"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(true);
      }
    }

    for (const activityCode of [
      "flash_sales",
      "vouchers",
      "sliders",
      "testimonials",
      "popups"
    ]) {
      for (const action of ["read", "create", "update", "delete"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(true);
      }
      expect(declared.has(`commerce.${activityCode}.restore` as Triple)).toBe(
        false
      );
    }

    for (const action of ["read", "update"]) {
      expect(declared.has(`commerce.settings.${action}` as Triple)).toBe(true);
    }

    for (const activityCode of ["orders", "customers"]) {
      for (const action of ["read", "update"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(true);
      }
      for (const action of ["create", "delete", "restore"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(false);
      }
    }

    for (const action of ["read", "update", "delete"]) {
      expect(declared.has(`commerce.reviews.${action}` as Triple)).toBe(true);
    }
    for (const action of ["create", "restore"]) {
      expect(declared.has(`commerce.reviews.${action}` as Triple)).toBe(false);
    }

    for (const activityCode of ["affiliates", "affiliate_commissions"]) {
      for (const action of ["read", "update"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(true);
      }
      for (const action of ["create", "delete", "restore"]) {
        expect(
          declared.has(`commerce.${activityCode}.${action}` as Triple)
        ).toBe(false);
      }
    }

    expect(declared.has("commerce.webhook_endpoints.update" as Triple)).toBe(
      true
    );
    for (const action of ["read", "create", "delete", "restore"]) {
      expect(
        declared.has(`commerce.webhook_endpoints.${action}` as Triple)
      ).toBe(false);
    }

    expect(declared.has("commerce.pos.create" as Triple)).toBe(true);
    for (const action of ["read", "update", "delete", "restore"]) {
      expect(declared.has(`commerce.pos.${action}` as Triple)).toBe(false);
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

// ---------------------------------------------------------------------------
// Issue #116 — `/admin/commerce-pos` (POS counter sales + history)
// ---------------------------------------------------------------------------

const POS_PAGE = "src/pages/admin/commerce-pos.astro";
const POS_ROUTES = ["src/pages/api/v1/commerce/pos/orders/index.ts"];

describe("/admin/commerce-pos permission gates", () => {
  test("the page gates on exactly commerce.pos.create (sale) and commerce.orders.read (history), both declared and both enforced by the POS route", async () => {
    const page = await readFile(POS_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    const declared = declaredTriples();

    expect([...pageKeys].sort()).toEqual([
      "commerce.orders.read",
      "commerce.pos.create"
    ]);
    expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);

    const enforcedPos = await enforcedTriples(
      POS_ROUTES,
      "COMMERCE_POS_ACTIVITY_CODE",
      "pos"
    );
    expect([...enforcedPos]).toEqual(["commerce.pos.create"]);
    const enforcedOrders = await enforcedTriples(
      POS_ROUTES,
      "COMMERCE_ORDERS_ACTIVITY_CODE",
      "orders"
    );
    expect([...enforcedOrders]).toEqual(["commerce.orders.read"]);
  });

  test("the page never writes raw SQL — the sale posts to the guarded POS endpoint with an Idempotency-Key", async () => {
    const page = await readFile(POS_PAGE, "utf8");

    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).toContain('"/api/v1/commerce/pos/orders"');
    expect(page).toContain('"Idempotency-Key"');
    // Catalog data reaches the DOM through textContent only — never an
    // innerHTML ASSIGNMENT (the docblock may name the property it avoids).
    expect(page).not.toMatch(/\.innerHTML\s*=/);
  });

  test("the page honours the pos feature flag (#118) and reads history through listPosOrders", async () => {
    const page = await readFile(POS_PAGE, "utf8");
    expect(page).toContain("fetchCommerceFeatures(");
    expect(page).toContain("listPosOrders(");
  });

  test("the sidebar entry points at this page, is gated on commerce.pos.create, and requires the pos feature", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find((entry) => entry.path === "/admin/commerce-pos");

    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.pos.create");
    expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(true);
    expect(nav!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "pos"
    });
  });

  test("both POS route handlers are gated by the pos feature flag", async () => {
    const source = await readFile(POS_ROUTES[0]!, "utf8");
    const gates = source.match(
      /requireCommerceFeatureForOwnerRoute\(tx, tenantId, "pos"\)/g
    );
    expect(gates?.length).toBe(2);
  });
});
