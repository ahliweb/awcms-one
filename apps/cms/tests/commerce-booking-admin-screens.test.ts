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
  },
  // Issue #381 (UX 11.4): the cancellation-policy versions screen.
  "/admin/commerce-booking-policies": {
    file: "src/pages/admin/commerce-booking-policies.astro",
    claims: [
      "commerce.booking_cancellation_policies.read",
      "commerce.booking_cancellation_policies.create",
      "commerce.booking_cancellation_policies.approve"
    ],
    routes: [
      "src/pages/api/v1/commerce/booking/cancellation-policies/index.ts",
      "src/pages/api/v1/commerce/booking/cancellation-policies/[id]/approve.ts",
      "src/pages/api/v1/commerce/booking/cancellation-policies/[id]/retire.ts"
    ]
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

test("the link screen takes and shows the resource(s) the link sells (Issue #437)", () => {
  const source = readFileSync(
    SCREENS["/admin/commerce-booking-links"].file,
    "utf8"
  );
  // The optional field, parsed by the shared helper and sent as `resourceIds`.
  expect(source).toContain('name="resourceIds"');
  expect(source).toContain("resourceIds: field(data");
  // The list shows them, with a words-not-colour fallback for a link naming none.
  expect(source).toContain("link.resourceIds");
  expect(source).toContain('t("All active resources")');
  // The new server refusals have their own copy.
  for (const code of [
    "RESOURCE_MODE_MISMATCH",
    "RESOURCE_NOT_ACTIVE",
    "RESOURCE_NOT_FOUND",
    "VALIDATION_ERROR"
  ]) {
    expect(source).toContain(`${code}:`);
  }
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

test("the settings screen carries the check-in policy checkbox (Issue #383, ADR-0045 D19): rendered only with the booking block, sent only when rendered, default ON", () => {
  const source = readFileSync(
    "src/pages/admin/commerce-settings.astro",
    "utf8"
  );
  expect(source).toContain("settings-checkinRequiresSettlement");
  expect(source).toContain("fetchCheckInRequiresSettlement");
  // Absent from the PUT unless the checkbox rendered, so a tenant with the
  // booking feature off never clears or sets it by saving the screen.
  expect(source).toMatch(
    /el\("settings-checkinRequiresSettlement"\)\s*\?\s*\{\s*checkinRequiresSettlement:/
  );
  // The default shown for a tenant without the feature is the fail-closed one.
  expect(source).toMatch(/: true;/);
});

test("the policy screen drafts, approves and retires through the confirm and step-up dialogs", () => {
  const source = readFileSync(
    SCREENS["/admin/commerce-booking-policies"].file,
    "utf8"
  );
  expect(source).toContain("CommerceConfirmDialog");
  expect(source).toContain("CommerceStepUpDialog");
  expect(source).toContain("sendWithStepUp");
  expect(source).toContain("buildPolicyDraftBody");
  expect(source).toContain("Idempotency-Key");
});

// Issue #381 (UX 11.5): the booking panel on the order detail.
describe("the booking panel of the order detail", () => {
  const page = readFileSync(
    "src/pages/admin/commerce-orders/[id].astro",
    "utf8"
  );
  const panel = readFileSync(
    "src/components/CommerceBookingPanel.astro",
    "utf8"
  );

  test("the order screen claims the cancellation keys, all declared and off the ledger", () => {
    const keys = [
      "commerce.booking_reservation_links.read",
      "commerce.booking_reservation_links.cancel",
      "commerce.booking_refund_decisions.read",
      "commerce.booking_refund_decisions.create",
      "commerce.booking_refund_overrides.approve"
    ];
    const claimed = extractScreenClaims(page);
    for (const key of keys) {
      expect(claimed.has(key)).toBe(true);
      expect(declared.has(key)).toBe(true);
      expect(NOT_YET_SCREENED.includes(key)).toBe(false);
    }
  });

  test("cancelling and overriding use native dialogs, never a raw browser one", () => {
    expect(panel).toContain("<dialog");
    expect(panel).toContain("CommerceStepUpDialog");
    expect(panel).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\(/);
    expect(panel).not.toMatch(/\sstyle=/);
    expect(panel).not.toMatch(/<h1[\s>]/);
  });

  test("a cancel is sent with an Idempotency-Key and the override re-sends the same key after step-up", () => {
    expect(panel).toContain("Idempotency-Key");
    expect(panel).toContain("sendWithStepUp");
  });

  test("the panel sends a reason and an amount, never a policy figure the server computes", () => {
    expect(panel).toContain("buildStaffCancelBody");
    expect(panel).not.toMatch(/policyRefund\s*:/);
  });
});

// Issue #382 (UX 11.6): the reschedule dialog and the no-show control on the same panel.
describe("the reschedule and no-show controls of the booking panel", () => {
  const page = readFileSync(
    "src/pages/admin/commerce-orders/[id].astro",
    "utf8"
  );
  const panel = readFileSync(
    "src/components/CommerceBookingPanel.astro",
    "utf8"
  );

  test("the order screen claims the reschedule key, declared and off the ledger; the panel reads it as a capability", () => {
    const key = "commerce.booking_reservation_links.update";
    expect(extractScreenClaims(page).has(key)).toBe(true);
    expect(declared.has(key)).toBe(true);
    expect(NOT_YET_SCREENED.includes(key)).toBe(false);
    expect(page).toContain("canReschedule");
  });

  test("the reschedule is a native modal dialog and the no-show uses the shared confirm dialog, never a raw browser one", () => {
    expect(panel).toContain("booking-reschedule-dialog");
    expect(panel).toContain("showModal()");
    expect(panel).toContain(
      'data-confirm-title={t("Mark this reservation no-show?")}'
    );
    expect(panel).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\(/);
    expect(panel).not.toMatch(/\sstyle=/);
    expect(panel).not.toMatch(/<h1[\s>]/);
  });

  test("a reschedule and a no-show are sent with an Idempotency-Key", () => {
    expect(panel).toContain("/reschedule`");
    expect(panel).toContain("/no-show`");
    expect(panel).toContain("Idempotency-Key");
  });

  test("the browser sends dates and a reason code, never a price, a refund or a retained amount", () => {
    expect(panel).toContain("buildRescheduleBody");
    expect(panel).toContain("buildNoShowBody");
    expect(panel).toContain("fetchRescheduleQuote");
    const script = panel.slice(panel.indexOf("<script>"));
    expect(script).not.toMatch(
      /(?:priceDifference|pricedAmount|refundAmount|retainedAmount)\s*:/
    );
    // The earliest date is the SERVER's clock, never the browser's.
    expect(panel).toContain("earliestDate(panel.serverNow)");
    expect(panel).not.toMatch(/new Date\(\)|Date\.now\(\)/);
  });

  test("the dialog's inputs are labelled and its figures are announced politely", () => {
    for (const id of ["checkin", "checkout", "starts", "reason"]) {
      expect(panel).toContain(`for={\`\${reschedulePrefix}-${id}\`}`);
    }
    expect(panel).toContain('aria-live="polite"');
  });
});

// Issue #385 closing pass (the real-browser findings and #448).
describe("closing pass of the booking admin screens", () => {
  const links = readFileSync(
    SCREENS["/admin/commerce-booking-links"].file,
    "utf8"
  );
  const deposits = readFileSync(
    SCREENS["/admin/commerce-booking-deposits"].file,
    "utf8"
  );
  const policies = readFileSync(
    SCREENS["/admin/commerce-booking-policies"].file,
    "utf8"
  );
  const panel = readFileSync(
    "src/components/CommerceBookingPanel.astro",
    "utf8"
  );

  test("the link filter is the real page-navigation primitive, not a class nobody styles", () => {
    expect(links).toContain('class="admin-segmented booking-links-filter"');
    expect(links).toContain('class="admin-segmented-option"');
    expect(links).not.toContain("pill-row");
  });

  test("a class a booking screen uses has a rule somewhere (no unstyled markup)", () => {
    const css = [
      "src/styles/admin.css",
      "src/styles/admin-screens.css",
      "src/styles/tokens.css"
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const [name, source] of [
      ["links", links],
      ["deposits", deposits],
      ["policies", policies]
    ] as const) {
      const local = source.slice(source.indexOf("<style>"));
      for (const match of source.matchAll(/class="([^"{]+)"/g)) {
        for (const cls of match[1]!.split(/\s+/)) {
          // `admin-fieldset` is a marker class used by many screens, and
          // `fade-in-up` / `cell-code` are motion and token utilities.
          if (cls === "admin-fieldset") continue;
          expect(
            css.includes(`.${cls}`) || local.includes(`.${cls}`),
            `${name}: .${cls} has no CSS rule`
          ).toBe(true);
        }
      }
    }
  });

  test("a status line shown after a reload takes focus (#448), on the links screen and the booking panel", () => {
    expect(links).toContain("showStatusAndFocus");
    expect(links).toContain('aria-live="polite"');
    expect(links).toContain('tabindex="-1"');
    expect(panel).toContain("showStatusAndFocus");
    expect(panel).toContain('aria-live="polite"');
  });

  test("a rejected field is marked invalid and focused (links and deposits)", () => {
    expect(links).toContain("markFieldInvalid");
    expect(deposits).toContain("markFieldInvalid");
  });

  test("the deposits list is keyset-paged and says when more follow (#448)", () => {
    expect(deposits).toContain("listServiceProductDepositPoliciesPage");
    expect(deposits).not.toContain("listServiceProductDepositPolicies(");
    expect(deposits).toContain("decodeDepositListCursor");
    expect(deposits).toContain("booking-deposits-more");
    expect(deposits).toContain('rel="next"');
  });

  test("the deposit kind radios sit in label rows, not as stretched form controls", () => {
    expect(deposits).toContain('class="admin-checkbox"');
    expect(deposits).toContain("booking-deposit-kind");
  });

  test("the policy editor keeps focus when a window is added or removed", () => {
    expect(policies).toContain("?.focus()");
    expect(policies).toContain("booking-policy-add-row");
    expect(policies).toContain("SERVICE_PRODUCT_SELECTOR_LIMIT");
  });
});
