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
  "src/pages/api/v1/commerce/products/export.csv.ts",
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
  test("ninety-nine permissions total — five per catalog activity code (incl. restore), four per marketing code, two for settings, two each for orders/customers/affiliates/affiliate_commissions/conversations/entitlements, three for reviews, one for whatsapp, three for campaigns, one for webhook_endpoints, one for pos, one for pos_due, three for payments, ten for registers/cash-up, two for loyalty and one each for loyalty_adjustments/loyalty_redemptions, and (Issue #291) read/manage for attributes plus export/import on products, and seven for stored value", () => {
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
    // Issue #285: pos_due carries create only (a second permission for a
    // sale left with a balance due), payments carries read/create/revoke
    // (record a tender / record a reversal — `revoke` is the platform's
    // existing high-risk verb), each with its own enforcing route.
    // Issue #284: registers carries read/create/update, register_sessions
    // read/create/update/export, register_cash_ups create/approve and
    // register_corrections approve (ten keys, none implied by pos.create).
    // Issue #286: held_sales read/create/update/approve, quotations
    // read/create/update, quotation_conversions create, work_orders
    // Issue #292: barcodes read/update (two keys, resource-split).
    // read/create/update, documents read/create (thirteen keys, resource-split).
    // Issue #288: stored_value_programs read/update, stored_value
    // read/create/update, stored_value_adjustments create and
    // stored_value_reconcile approve (seven keys; redeeming is only ever a
    // tender on a payment, so it is not one of them).
    // Issue #294: expense_categories read/create/update, expenses
    // read/create/update/export, expense_postings create/approve,
    // expense_reversals approve and expense_receipts read/create (twelve keys,
    // none implied by register_sessions.update or pos.create).
    expect(declared.size).toBe(
      2 * 5 +
        5 * 4 +
        2 +
        2 +
        2 +
        3 +
        2 +
        2 +
        1 +
        2 +
        3 +
        1 +
        1 +
        2 +
        1 +
        3 +
        10 +
        13 +
        4 +
        2 +
        2 +
        7 +
        12 +
        // Issue #295: document_deliveries read/create, document_delivery_overrides create.
        3 +
        // Issue #292: barcodes read/update.
        2
    );

    // Issue #291 — typed catalog attributes. `manage` (one high-risk action,
    // not create/update/delete) because a definition is schema; the CSV
    // import/export are products actions with their own audience.
    for (const key of [
      "commerce.attributes.read",
      "commerce.attributes.manage",
      "commerce.products.export",
      "commerce.products.import"
    ] as const) {
      expect(declared.has(key as Triple)).toBe(true);
    }
    for (const action of ["create", "update", "delete", "restore"]) {
      expect(declared.has(`commerce.attributes.${action}` as Triple)).toBe(
        false
      );
    }

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

    // Issue #267 (IRMbyDUS) — read/update only, no create (a grant happens
    // only via the order-paid consumer, never a direct admin route), same
    // "no permission with nothing to enforce it" shape orders/customers use.
    for (const action of ["read", "update"]) {
      expect(declared.has(`commerce.entitlements.${action}` as Triple)).toBe(
        true
      );
    }
    for (const action of ["create", "delete", "restore"]) {
      expect(declared.has(`commerce.entitlements.${action}` as Triple)).toBe(
        false
      );
    }

    // Issue #289 (loyalty) — four permissions on three activity codes. NOT
    // `commerce.loyalty.adjust`/`.redeem`: `AccessAction` has no such member
    // and widening it would diverge an upstream-owned file (sql/952).
    for (const key of [
      "commerce.loyalty.read",
      "commerce.loyalty.manage",
      "commerce.loyalty_adjustments.create",
      "commerce.loyalty_redemptions.create"
    ]) {
      expect(declared.has(key as Triple)).toBe(true);
    }
    for (const key of [
      "commerce.loyalty.create",
      "commerce.loyalty.update",
      "commerce.loyalty.delete",
      "commerce.loyalty.adjust",
      "commerce.loyalty.redeem"
    ]) {
      expect(declared.has(key as Triple)).toBe(false);
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
    // read/create/update/delete/restore — every products.* permission — plus
    // `export` (Issue #291: the page's "Export CSV" link is gated on it).
    // `import` is claimed by `/admin/commerce-catalog-import`, not here.
    expect(
      [...pageKeys].filter((key) => key.startsWith("commerce.products.")).length
    ).toBe(6);

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
      // Issue #292 — the scan field needs the lookup key; also checked by the endpoint.
      "commerce.barcodes.read",
      // Issue #286 — hold and resume a parked cart; also checked by the endpoints.
      "commerce.held_sales.create",
      "commerce.held_sales.update",
      "commerce.orders.read",
      "commerce.pos.create",
      // Issue #285 — the credit-sale checkbox; also checked by the endpoint.
      "commerce.pos_due.create"
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
    // Issue #285 — `allowDue` needs a SECOND permission, enforced in the
    // handler through the same chokepoint (`authorizeInTransaction`).
    const enforcedDue = await enforcedTriples(
      POS_ROUTES,
      "COMMERCE_POS_DUE_ACTIVITY_CODE",
      "pos_due"
    );
    expect([...enforcedDue]).toEqual(["commerce.pos_due.create"]);
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

// ---------------------------------------------------------------------------
// Issue #285 — the payment-allocation ledger's screens and routes
// ---------------------------------------------------------------------------

const ORDER_DETAIL_PAGE = "src/pages/admin/commerce-orders/[id].astro";
const REPORTS_PAGE = "src/pages/admin/commerce-reports.astro";
const PAYMENT_ROUTES = [
  "src/pages/api/v1/commerce/orders/[id]/payments/index.ts",
  "src/pages/api/v1/commerce/orders/[id]/payments/[paymentId]/reversals.ts",
  "src/pages/api/v1/reports/commerce/tender-mix.ts",
  "src/pages/api/v1/reports/commerce/outstanding-balances.ts"
];

describe("payment-allocation ledger permission gates (Issue #285)", () => {
  test("commerce.payments.{read,create,revoke} are declared, each claimed by the order detail screen and each enforced by exactly its route", async () => {
    const declared = declaredTriples();
    const expected: Triple[] = [
      "commerce.payments.create",
      "commerce.payments.read",
      "commerce.payments.revoke"
    ];
    for (const key of expected) {
      expect(declared.has(key)).toBe(true);
    }

    const page = await readFile(ORDER_DETAIL_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    for (const key of expected) {
      expect(pageKeys.has(key)).toBe(true);
    }
    // The page's own subject is still the order: it keeps `orders.read`.
    expect(pageKeys.has("commerce.orders.read" as Triple)).toBe(true);

    const enforced = await enforcedTriples(
      PAYMENT_ROUTES,
      "COMMERCE_PAYMENTS_ACTIVITY_CODE",
      "payments"
    );
    expect([...enforced].sort()).toEqual(expected);
  });

  test("a reversal uses the platform's high-risk `revoke` verb, and both mutations require an Idempotency-Key", async () => {
    const reversal = await readFile(PAYMENT_ROUTES[1]!, "utf8");
    expect(reversal).toContain('action: "revoke"');
    for (const route of [PAYMENT_ROUTES[0]!, PAYMENT_ROUTES[1]!]) {
      const source = await readFile(route, "utf8");
      expect(source).toContain("IDEMPOTENCY_REQUIRED");
    }
  });

  test("the screens never write raw SQL — every mutation posts to a guarded endpoint with an Idempotency-Key", async () => {
    for (const path of [ORDER_DETAIL_PAGE, REPORTS_PAGE]) {
      const page = await readFile(path, "utf8");
      expect(page).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
      );
    }
    const detail = await readFile(ORDER_DETAIL_PAGE, "utf8");
    expect(detail).toContain("/payments`");
    expect(detail).toContain('"Idempotency-Key"');
  });

  test("the reports screen reads the ledger through the directory (never a second projection) behind commerce.payments.read", async () => {
    const page = await readFile(REPORTS_PAGE, "utf8");
    expect(page).toContain("listTenderMix(");
    expect(page).toContain("listOutstandingBalances(");
    expect(page).toContain('activityCode: "payments"');
  });
});

// ---------------------------------------------------------------------------
// Issue #284 — registers, register sessions and cash-up (ADR-0028)
// ---------------------------------------------------------------------------

const REGISTERS_PAGE = "src/pages/admin/commerce-registers.astro";
const REGISTER_SESSION_PAGE = "src/pages/admin/commerce-registers/[id].astro";
const REGISTER_ROUTES = [
  "src/pages/api/v1/commerce/registers/index.ts",
  "src/pages/api/v1/commerce/registers/[id].ts",
  "src/pages/api/v1/commerce/register-sessions/index.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/index.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/movements.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/handover.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/close.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/close-decision.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/corrections.ts",
  "src/pages/api/v1/commerce/register-sessions/[id]/report.csv.ts"
];

describe("register screens' permission gates (Issue #284)", () => {
  test("the list screen claims the register / session / settings permissions it renders controls for, all declared", async () => {
    const page = await readFile(REGISTERS_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    const declared = declaredTriples();

    expect([...pageKeys].sort()).toEqual([
      "commerce.register_sessions.create",
      "commerce.register_sessions.read",
      "commerce.registers.create",
      "commerce.registers.read",
      "commerce.registers.update"
    ]);
    expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);
    // The cash-up threshold is edited through the GENERIC module-settings
    // route behind module_management's own permission, not a commerce one.
    expect(page).toContain("MODULE_SETTINGS_UPDATE_GUARD");
  });

  test("the session screen claims the use / close / approve / correct / export permissions, all declared", async () => {
    const page = await readFile(REGISTER_SESSION_PAGE, "utf8");
    const pageKeys = pageTriplesFrom(page);
    const declared = declaredTriples();

    expect([...pageKeys].sort()).toEqual([
      "commerce.register_cash_ups.approve",
      "commerce.register_cash_ups.create",
      "commerce.register_corrections.approve",
      "commerce.register_sessions.export",
      "commerce.register_sessions.read",
      "commerce.register_sessions.update"
    ]);
    expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);
  });

  test("every permission a register screen claims is enforced by the endpoint behind it", async () => {
    const claimed = new Set<Triple>([
      ...pageTriplesFrom(await readFile(REGISTERS_PAGE, "utf8")),
      ...pageTriplesFrom(await readFile(REGISTER_SESSION_PAGE, "utf8"))
    ]);
    const enforced = new Set<Triple>();
    for (const [constant, code] of [
      ["COMMERCE_REGISTERS_ACTIVITY_CODE", "registers"],
      ["COMMERCE_REGISTER_SESSIONS_ACTIVITY_CODE", "register_sessions"],
      ["COMMERCE_REGISTER_CASH_UPS_ACTIVITY_CODE", "register_cash_ups"],
      ["COMMERCE_REGISTER_CORRECTIONS_ACTIVITY_CODE", "register_corrections"]
    ] as const) {
      for (const key of await enforcedTriples(
        REGISTER_ROUTES,
        constant,
        code
      )) {
        enforced.add(key);
      }
    }
    expect([...claimed].filter((key) => !enforced.has(key))).toEqual([]);
  });

  test("the screens never write raw SQL or innerHTML - every mutation posts to a guarded endpoint with an Idempotency-Key", async () => {
    for (const path of [REGISTERS_PAGE, REGISTER_SESSION_PAGE]) {
      const page = await readFile(path, "utf8");
      expect(page).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
      );
      expect(page).not.toMatch(/\.innerHTML\s*=/);
      expect(page).not.toContain("window.confirm");
    }
    const list = await readFile(REGISTERS_PAGE, "utf8");
    expect(list).toContain('"/api/v1/commerce/register-sessions"');
    expect(list).toContain('"Idempotency-Key"');
    const detail = await readFile(REGISTER_SESSION_PAGE, "utf8");
    for (const suffix of [
      "/movements",
      "/handover",
      "/close",
      "/close-decision",
      "/corrections"
    ]) {
      expect(detail).toContain("`${base}" + suffix + "`");
    }
    expect(detail).toContain('"Idempotency-Key"');
  });

  test("both screens honour the register feature flag and read through the directory", async () => {
    const list = await readFile(REGISTERS_PAGE, "utf8");
    const detail = await readFile(REGISTER_SESSION_PAGE, "utf8");
    expect(list).toContain("fetchCommerceFeatures(");
    expect(list).toContain("listRegisterSessions(");
    expect(detail).toContain("fetchCommerceFeatures(");
    expect(detail).toContain("fetchRegisterCashUpReport(");
  });

  test("the sidebar entry points at the list screen, is gated on session read, and requires the register feature", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find((entry) => entry.path === "/admin/commerce-registers");

    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.register_sessions.read");
    expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(true);
    expect(nav!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "register"
    });
  });

  test("the POS screen shows the register banner only behind the feature and posts the register id", async () => {
    const page = await readFile(POS_PAGE, "utf8");
    expect(page).toContain("registerEnabled");
    expect(page).toContain("listRegisterSessions(");
    expect(page).toContain("registerId");
  });

  test("the POS route maps every register-gate refusal", async () => {
    const source = await readFile(POS_ROUTES[0]!, "utf8");
    for (const code of [
      "REGISTER_SESSION_REQUIRED",
      "REGISTER_SESSION_CLOSING",
      "NOT_SESSION_CASHIER"
    ]) {
      expect(source).toContain(`"${code}"`);
    }
    expect(source).toContain("PosRegisterSessionError");
  });
});

// ---------------------------------------------------------------------------
// Issue #294 — register-linked expenses (ADR-0031)
// ---------------------------------------------------------------------------

const EXPENSES_PAGE = "src/pages/admin/commerce-expenses.astro";
const EXPENSE_ROUTES = [
  "src/pages/api/v1/commerce/expense-categories/index.ts",
  "src/pages/api/v1/commerce/expense-categories/[id].ts",
  "src/pages/api/v1/commerce/expenses/index.ts",
  "src/pages/api/v1/commerce/expenses/[id]/index.ts",
  "src/pages/api/v1/commerce/expenses/[id]/post.ts",
  "src/pages/api/v1/commerce/expenses/[id]/decision.ts",
  "src/pages/api/v1/commerce/expenses/[id]/reverse.ts",
  "src/pages/api/v1/commerce/expenses/[id]/cancel.ts",
  "src/pages/api/v1/commerce/expenses/[id]/receipt.ts",
  "src/pages/api/v1/commerce/expenses/[id]/receipt-url.ts",
  "src/pages/api/v1/commerce/expenses/summary.ts",
  "src/pages/api/v1/commerce/expenses/export.csv.ts"
];
const EXPENSE_ACTIVITY_CODES = [
  ["COMMERCE_EXPENSE_CATEGORIES_ACTIVITY_CODE", "expense_categories"],
  ["COMMERCE_EXPENSES_ACTIVITY_CODE", "expenses"],
  ["COMMERCE_EXPENSE_POSTINGS_ACTIVITY_CODE", "expense_postings"],
  ["COMMERCE_EXPENSE_REVERSALS_ACTIVITY_CODE", "expense_reversals"],
  ["COMMERCE_EXPENSE_RECEIPTS_ACTIVITY_CODE", "expense_receipts"]
] as const;

async function enforcedExpenseTriples(): Promise<Set<Triple>> {
  const enforced = new Set<Triple>();
  for (const [constant, code] of EXPENSE_ACTIVITY_CODES) {
    for (const triple of await enforcedTriples(
      EXPENSE_ROUTES,
      constant,
      code
    )) {
      enforced.add(triple);
    }
  }
  return enforced;
}

describe("expense screen and routes (Issue #294)", () => {
  test("every one of the twelve expense permissions is enforced by a route", async () => {
    const enforced = await enforcedExpenseTriples();
    const declared = [...declaredTriples()].filter((key) =>
      EXPENSE_ACTIVITY_CODES.some(([, code]) =>
        key.startsWith(`commerce.${code}.`)
      )
    );
    expect(declared).toHaveLength(12);
    expect(declared.filter((key) => !enforced.has(key))).toEqual([]);
  });

  test("the screen claims only declared permissions, each enforced by an endpoint behind it", async () => {
    const page = await readFile(EXPENSES_PAGE, "utf8");
    const claimed = pageTriplesFrom(page);
    const declared = declaredTriples();
    expect([...claimed].filter((key) => !declared.has(key))).toEqual([]);

    const enforced = await enforcedExpenseTriples();
    // The register session read is the one key the screen borrows from #284 (the
    // drawer picker); the generic settings guard is module_management's own.
    const borrowed = new Set<Triple>(["commerce.register_sessions.read"]);
    expect(
      [...claimed].filter((key) => !enforced.has(key) && !borrowed.has(key))
    ).toEqual([]);
    expect(page).toContain("MODULE_SETTINGS_UPDATE_GUARD");
    expect(page).toContain("fetchCommerceFeatures(");
    expect(page).toContain("listExpenses(");
  });

  test("the screen never writes raw SQL or innerHTML, never uses window.confirm, and every mutation carries an Idempotency-Key", async () => {
    const page = await readFile(EXPENSES_PAGE, "utf8");
    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).not.toMatch(/\.innerHTML\s*=/);
    expect(page).not.toContain("window.confirm");
    expect(page).toContain('"Idempotency-Key"');
    for (const suffix of [
      "/post",
      "/decision",
      "/reverse",
      "/cancel",
      "/receipt"
    ]) {
      expect(page).toContain("`${base}" + suffix + "`");
    }
    expect(page).toContain('"/api/v1/commerce/expenses"');
    expect(page).toContain("confirmFromTriggerWithNote");
  });

  test("the sidebar entry points at the screen, is gated on expense read, and requires the expenses feature", () => {
    const nav = listModules()
      .find((module) => module.key === "commerce")
      ?.navigation?.find((entry) => entry.path === "/admin/commerce-expenses");
    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.expenses.read");
    expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(true);
    expect(nav!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "expenses"
    });
  });

  test("every expense route is feature-gated, and the receipt is resolved from the expense, never from the request", async () => {
    for (const route of EXPENSE_ROUTES) {
      const source = await readFile(route, "utf8");
      expect(source).toContain("requireExpenseFeature(");
    }
    const receiptUrl = await readFile(
      "src/pages/api/v1/commerce/expenses/[id]/receipt-url.ts",
      "utf8"
    );
    // The object is resolved from THE EXPENSE, never from the request.
    expect(receiptUrl).toContain("fetchExpenseReceiptObjectId(");
    expect(receiptUrl).not.toContain("searchParams");
    expect(receiptUrl).not.toContain("request.json");
    expect(receiptUrl).toContain("recordMediaDownloadIssuance(");
  });

  test("the raw expense movement refusal is wired into the movements route", async () => {
    const source = await readFile(
      "src/pages/api/v1/commerce/register-sessions/[id]/movements.ts",
      "utf8"
    );
    expect(source).toContain("EXPENSE_REQUIRES_EXPENSE_RECORD");
  });
});
