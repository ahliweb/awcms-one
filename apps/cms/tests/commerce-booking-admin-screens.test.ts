/**
 * The booking adapter's admin screens (Issue #385, `docs/booking-ux-flows.md`
 * section 11), pinned from the page source alone: each screen claims exactly
 * its permissions, every claimed key is declared by `commerce`, the sidebar
 * entries are gated on both the permission and the `booking` feature, the
 * confirm-dialog helper replaces any raw browser dialog, and every call the
 * page scripts send targets a route and method that exist. No database.
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { extractScreenClaims } from "../scripts/admin-screen-coverage-check";
import { NOT_YET_SCREENED } from "../scripts/admin-screen-coverage-ledger";
import { BOOKING_ADAPTER_NAVIGATION } from "../src/modules/commerce/domain/booking-adapter-navigation";
import { commerceModule } from "../src/modules/commerce/module";

const SCREENS = {
  "/admin/commerce-booking-links": {
    file: "src/pages/admin/commerce-booking-links.astro",
    claims: [
      "commerce.booking_offering_links.read",
      "commerce.booking_offering_links.create",
      "commerce.booking_offering_links.update"
    ],
    routes: [
      "src/pages/api/v1/commerce/booking/offering-links/index.ts",
      "src/pages/api/v1/commerce/booking/offering-links/[id].ts"
    ]
  },
  "/admin/commerce-booking-deposits": {
    file: "src/pages/admin/commerce-booking-deposits.astro",
    claims: [
      "commerce.booking_deposit_policies.read",
      "commerce.booking_deposit_policies.update"
    ],
    routes: ["src/pages/api/v1/commerce/products/[id]/deposit-policy.ts"]
  }
} as const;

const declared = new Set(
  (commerceModule.permissions ?? []).map(
    (p) => `commerce.${p.activityCode}.${p.action}`
  )
);

describe.each(Object.entries(SCREENS))("%s", (path, screen) => {
  const source = readFileSync(screen.file, "utf8");

  test("claims exactly its permissions, all declared by commerce", () => {
    const claimed = [...extractScreenClaims(source)]
      .filter((key) => key.startsWith("commerce.booking_"))
      .sort();
    expect(claimed).toEqual([...screen.claims].sort());
    for (const key of screen.claims) expect(declared.has(key)).toBe(true);
  });

  test("the routes it drives exist and its permissions are off the ledger", () => {
    for (const route of screen.routes) expect(existsSync(route)).toBe(true);
    for (const key of screen.claims) {
      expect(NOT_YET_SCREENED.includes(key)).toBe(false);
    }
  });

  test("no raw browser dialog, no inline style, no own h1", () => {
    expect(source).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\(/);
    expect(source).not.toMatch(/\sstyle=/);
    expect(source).not.toMatch(/<h1[\s>]/);
  });

  test("tables sit in a focusable, named scroll region", () => {
    expect(source).toContain('class="data-table-scroll');
    expect(source).toMatch(/role="region"\s+tabindex="0"\s+aria-label=/);
  });

  test("is reachable from a sidebar entry gated on its permission and the booking feature", () => {
    const entry = BOOKING_ADAPTER_NAVIGATION.find((e) => e.path === path);
    expect(entry).toBeDefined();
    expect(screen.claims).toContain(entry!.requiredPermission as never);
    expect(entry!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "booking"
    });
    expect(commerceModule.navigation).toContain(entry!);
  });
});

test("the link screen unlinks through the confirm dialog helper, with an idempotency key", () => {
  const source = readFileSync(
    SCREENS["/admin/commerce-booking-links"].file,
    "utf8"
  );
  expect(source).toContain("CommerceConfirmDialog");
  expect(source).toContain("confirmFromTrigger");
  expect(source).toContain("Idempotency-Key");
  expect(source).toContain('"PATCH"');
});

test("the deposit screen sends the policy, never a computed amount", () => {
  const source = readFileSync(
    SCREENS["/admin/commerce-booking-deposits"].file,
    "utf8"
  );
  expect(source).toContain('"PUT"');
  expect(source).toContain("buildDepositPolicyBody");
  expect(source).not.toMatch(/dpAmount|depositAmount/);
});

test("the settings screen carries the service-account field", () => {
  const source = readFileSync(
    "src/pages/admin/commerce-settings.astro",
    "utf8"
  );
  expect(source).toContain("settings-bookingServiceTenantUserId");
  expect(source).toContain("bookingServiceTenantUserId");
});
