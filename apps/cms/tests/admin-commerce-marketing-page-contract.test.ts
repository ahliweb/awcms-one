/**
 * The six marketing screens Issue #26 added under the `commerce` sidebar
 * group — `/admin/commerce-flash-sales`, `-vouchers`, `-sliders`,
 * `-testimonials`, `-popup`, `-settings`. Same three properties
 * `admin-commerce-page-contract.test.ts` holds the #23 screens to, applied
 * table-driven so a seventh screen cannot arrive without joining the table:
 *
 *   1. every permission a page gates on is DECLARED by the module, and is one
 *      the page's own routes actually ENFORCE — a page that gates on a key no
 *      route checks is decoration, and one that gates on an undeclared key is
 *      a permanent 403;
 *   2. the page never writes SQL — every mutation posts to a guarded endpoint,
 *      which is the only way the audit trail and the idempotency contract can
 *      hold;
 *   3. the sidebar entry points at the page and is gated on a real permission.
 *
 * Pure — no database, no network. Runs in `quality` on every PR.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { NOT_YET_SCREENED } from "../scripts/admin-screen-coverage-ledger";

type Triple = `${string}.${string}.${string}`;

type Screen = {
  page: string;
  navPath: string;
  activityCode: string;
  activityCodeConstant: string;
  routes: readonly string[];
  /** The actions the PAGE must gate on — `restore` deliberately absent (the marketing tables ship soft delete only). */
  actions: readonly string[];
  /** A literal the page must post to — proof the mutation goes through the API. */
  endpoint: string;
};

const SCREENS: readonly Screen[] = [
  {
    page: "src/pages/admin/commerce-flash-sales.astro",
    navPath: "/admin/commerce-flash-sales",
    activityCode: "flash_sales",
    activityCodeConstant: "COMMERCE_FLASH_SALES_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/flash-sales/index.ts",
      "src/pages/api/v1/commerce/flash-sales/[id].ts",
      "src/pages/api/v1/commerce/flash-sales/[id]/products/index.ts",
      "src/pages/api/v1/commerce/flash-sales/[id]/products/[productRowId].ts",
      "src/pages/api/v1/commerce/flash-sales/active.ts"
    ],
    actions: ["read", "create", "update", "delete"],
    endpoint: '"/api/v1/commerce/flash-sales"'
  },
  {
    page: "src/pages/admin/commerce-vouchers.astro",
    navPath: "/admin/commerce-vouchers",
    activityCode: "vouchers",
    activityCodeConstant: "COMMERCE_VOUCHERS_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/vouchers/index.ts",
      "src/pages/api/v1/commerce/vouchers/[id].ts",
      "src/pages/api/v1/commerce/vouchers/public.ts",
      "src/pages/api/v1/commerce/vouchers/validate.ts"
    ],
    actions: ["read", "create", "update", "delete"],
    endpoint: '"/api/v1/commerce/vouchers"'
  },
  {
    page: "src/pages/admin/commerce-sliders.astro",
    navPath: "/admin/commerce-sliders",
    activityCode: "sliders",
    activityCodeConstant: "COMMERCE_SLIDERS_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/sliders/index.ts",
      "src/pages/api/v1/commerce/sliders/[id].ts",
      "src/pages/api/v1/commerce/sliders/active.ts"
    ],
    actions: ["read", "create", "update", "delete"],
    endpoint: '"/api/v1/commerce/sliders"'
  },
  {
    page: "src/pages/admin/commerce-testimonials.astro",
    navPath: "/admin/commerce-testimonials",
    activityCode: "testimonials",
    activityCodeConstant: "COMMERCE_TESTIMONIALS_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/testimonials/index.ts",
      "src/pages/api/v1/commerce/testimonials/[id].ts",
      "src/pages/api/v1/commerce/testimonials/active.ts"
    ],
    actions: ["read", "create", "update", "delete"],
    endpoint: '"/api/v1/commerce/testimonials"'
  },
  {
    page: "src/pages/admin/commerce-popup.astro",
    navPath: "/admin/commerce-popup",
    activityCode: "popups",
    activityCodeConstant: "COMMERCE_POPUPS_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/popups/index.ts",
      "src/pages/api/v1/commerce/popups/[id].ts",
      "src/pages/api/v1/commerce/popups/active.ts"
    ],
    actions: ["read", "create", "update", "delete"],
    endpoint: '"/api/v1/commerce/popups"'
  },
  {
    page: "src/pages/admin/commerce-settings.astro",
    navPath: "/admin/commerce-settings",
    activityCode: "settings",
    activityCodeConstant: "COMMERCE_SETTINGS_ACTIVITY_CODE",
    routes: [
      "src/pages/api/v1/commerce/store-settings/index.ts",
      "src/pages/api/v1/commerce/store-settings/public.ts"
    ],
    actions: ["read", "update"],
    endpoint: '"/api/v1/commerce/store-settings"'
  }
];

/** Same two spellings `admin-commerce-page-contract.test.ts` scans for. */
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

async function enforcedTriples(screen: Screen): Promise<Set<Triple>> {
  const found = new Set<Triple>();

  for (const route of screen.routes) {
    const source = await readFile(route, "utf8");
    for (const match of source.matchAll(
      new RegExp(
        `activityCode:\\s*${screen.activityCodeConstant},\\s*\\n?\\s*action:\\s*"([a-z_]+)"`,
        "g"
      )
    )) {
      found.add(`commerce.${screen.activityCode}.${match[1]}` as Triple);
    }
  }

  return found;
}

describe("commerce marketing screens (Issue #26)", () => {
  test("none of the marketing activity codes' permissions remain on NOT_YET_SCREENED", () => {
    expect(
      NOT_YET_SCREENED.filter((key) => key.startsWith("commerce."))
    ).toEqual([]);
  });

  for (const screen of SCREENS) {
    describe(screen.navPath, () => {
      test("every key the page gates on is declared, and is one the routes enforce", async () => {
        const page = await readFile(screen.page, "utf8");
        const pageKeys = pageTriplesFrom(page);
        const declared = declaredTriples();
        const prefix = `commerce.${screen.activityCode}.`;

        expect([...pageKeys].filter((key) => !declared.has(key))).toEqual([]);

        const own = [...pageKeys].filter((key) => key.startsWith(prefix));
        expect(own.sort()).toEqual(
          screen.actions.map((action) => `${prefix}${action}` as Triple).sort()
        );

        const enforced = await enforcedTriples(screen);
        expect(enforced.size).toBeGreaterThan(0);
        expect(own.filter((key) => !enforced.has(key))).toEqual([]);
      });

      test("the page never writes raw SQL — every mutation posts to a guarded endpoint", async () => {
        const page = await readFile(screen.page, "utf8");

        expect(page).not.toMatch(
          /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
        );
        expect(page).toContain(screen.endpoint);
      });

      test("the sidebar entry points at this page and is gated on its read permission", () => {
        const nav = listModules()
          .find((module) => module.key === "commerce")
          ?.navigation?.find((entry) => entry.path === screen.navPath);

        expect(nav).toBeDefined();
        expect(nav!.requiredPermission).toBe(
          `commerce.${screen.activityCode}.read`
        );
        expect(declaredTriples().has(nav!.requiredPermission as Triple)).toBe(
          true
        );
      });
    });
  }

  test("the settings page never renders a bank account number into the served HTML unmasked", async () => {
    // The owner GET legitimately returns account numbers to `settings.read`;
    // the SCREEN is where they would leak into a page source, a browser
    // cache, or a screenshot. The page must render them from the fetched
    // JSON in the browser — never interpolate them server-side into the
    // HTML — which this asserts by the absence of any `accountNumber`
    // interpolation in the Astro template half of the file.
    const page = await readFile(
      "src/pages/admin/commerce-settings.astro",
      "utf8"
    );
    const templateHalf = page.slice(page.lastIndexOf("---") + 3);
    expect(templateHalf).not.toMatch(/\{[^}]*accountNumber[^}]*\}/);
  });
});
