/**
 * The booking adapter's admin screens in a real browser, with real data, by
 * KEYBOARD (Issue #385, `docs/booking-ux-flows.md` section 11): the offering
 * links, deposit policies and cancellation policy versions screens, and the
 * refund-override dialog on the order detail.
 *
 * ## What this proves that the static contract tests cannot
 *
 * `tests/commerce-booking-admin-screens.test.ts` reads page SOURCE; the
 * a11y and 360px sweeps (`a11y-axe.e2e.ts`, `responsive-360.e2e.ts`) load these
 * routes with the `booking` feature OFF (its default), so they see one sentence
 * - "Booking is turned off for this store." - and none of the tables, forms or
 * dialogs. This spec turns the feature on, seeds the rows the screens exist for
 * and then checks, per state:
 *   - axe `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` finds no critical or serious
 *     violation, in the light AND the dark theme, at 360px and on the desktop;
 *   - the page never scrolls sideways at 360px;
 *   - every action works with the keyboard alone: focus the control, press Enter
 *     or Space; the confirm step is the shared native `<dialog>`, never a
 *     browser `confirm()`;
 *   - the sidebar entries exist only while the feature is on (`requiredFeature`);
 *   - the override dialog cannot be submitted above the amount paid (the field
 *     is marked invalid and the button stays disabled), Escape closes it and
 *     focus returns to the button that opened it;
 *   - the two follow-ups of #448: the deposits list pages past its first page
 *     and says so, and the no-cancellation-policy notice takes focus after the
 *     reload.
 *
 * ## What it deliberately does not do
 *
 * The approve, retire and override SUBMIT paths need a step-up (a second factor
 * the seeded owner does not have): they are proven by the route integration
 * suites (`tests/integration/commerce-booking-cancellation-routes.integration.test.ts`,
 * including the server refusing an amount above what was paid with
 * `409 REFUND_EXCEEDS_PAID`). Here the policy versions are seeded through the
 * module's own `createPolicyDraft` / `approvePolicy` as two different people.
 *
 * Needs `DATABASE_URL` (the migration owner, as `e2e-restricted-user.ts` does) to
 * seed the rows Booking itself owns; skipped without it. WRITE wave: it turns a
 * commerce feature on and off and writes booking rows. It restores the feature
 * flag and removes its bulk products afterwards.
 */
import AxeBuilder from "@axe-core/playwright";

import { test, expect, type Page } from "@playwright/test";

import { THEME_STORAGE_KEY } from "../../src/lib/security/theme-init-script";
import {
  approvePolicy,
  createPolicyDraft
} from "../../src/modules/commerce/application/booking-cancellation-policies";

const tenantId = process.env.E2E_TENANT_ID;
const loginIdentifier = process.env.E2E_LOGIN_IDENTIFIER;
const password = process.env.E2E_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
const seeded = Boolean(tenantId && loginIdentifier && password && databaseUrl);
const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:4321";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["critical", "serious"]);
const stamp = Date.now().toString(36);
const BULK = 55;

type Fixture = {
  ownerTenantUserId: string;
  authorTenantUserId: string;
  productA: string;
  productB: string;
  offeringA: string;
  offeringB: string;
  resourceB: string;
  orderB: string;
  linkB: string;
};
const fx = {} as Fixture;

/** One line per blocking axe node; soft so one screen does not hide the next. */
async function expectAxeClean(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const lines = results.violations
    .filter((v) => v.impact && BLOCKING.has(v.impact))
    .flatMap((v) =>
      v.nodes.map(
        (node) =>
          `${v.id} [${v.impact}] ${JSON.stringify(node.target)} - ${v.help}`
      )
    );
  expect.soft(lines, `${label}: critical/serious axe violations`).toEqual([]);
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme
  ] as const);
  await page.reload();
}

async function expectNoSidewaysScroll(page: Page, label: string) {
  const { overflow, offenders } = await page.evaluate(() => {
    const width = window.innerWidth;
    const found: string[] = [];
    for (const el of document.querySelectorAll("body *")) {
      const box = el.getBoundingClientRect();
      // The visually hidden table header is clipped, never visible.
      if (box.right > width + 1 && box.width > 1 && el.tagName !== "TH") {
        found.push(
          `${el.tagName.toLowerCase()}.${(el as HTMLElement).className} right=${Math.round(box.right)}`
        );
      }
    }
    return {
      overflow: document.documentElement.scrollWidth - width,
      offenders: found.slice(0, 8)
    };
  });
  expect(
    overflow,
    `${label}: horizontal overflow at ${page.viewportSize()?.width}px by ${overflow}px; wider than the viewport: ${offenders.join(" | ")}`
  ).toBeLessThanOrEqual(0);
}

/**
 * The state a screen is in, checked four ways: light and dark, at 360px and on
 * the desktop. `prepare` re-establishes any state a reload drops.
 */
async function sweep(
  page: Page,
  path: string,
  label: string,
  prepare: (page: Page) => Promise<void> = async () => {}
): Promise<void> {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await setTheme(page, theme);
      await prepare(page);
      await expectAxeClean(page, `${label} (${theme}, ${width}px)`);
      if (width === 360) await expectNoSidewaysScroll(page, label);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
  await setTheme(page, "light");
}

/** Focus a control and press a key: the keyboard path, no pointer. */
async function press(page: Page, selector: string, key = "Enter") {
  const target = page.locator(selector);
  await expect(target).toBeVisible();
  await target.focus();
  await page.keyboard.press(key);
}

async function typeInto(page: Page, selector: string, text: string) {
  const target = page.locator(selector);
  await target.focus();
  await target.fill(text);
}

async function activeId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? "");
}

/** Authenticated JSON call from the page, so the session cookie is the one the app issued. */
async function api<T = unknown>(
  page: Page,
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; json: { data?: T; error?: { code: string } } }> {
  return page.evaluate(
    async ({ method, url, body }) => {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID()
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, json: await response.json() };
    },
    { method, url, body }
  );
}

async function setBookingFeature(page: Page, on: boolean): Promise<void> {
  await page.goto("/admin");
  const current = await api<{
    effective: { features: Record<string, boolean> };
  }>(page, "GET", "/api/v1/tenant/modules/commerce/settings");
  const features = { ...current.json.data!.effective.features, booking: on };
  const patched = await api(
    page,
    "PATCH",
    "/api/v1/tenant/modules/commerce/settings",
    {
      features
    }
  );
  expect(patched.status).toBe(200);
}

const day = (offset: number): string =>
  new Date(Date.now() + (60 + offset) * 86_400_000).toISOString().slice(0, 10);

async function withTenantTx<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(databaseUrl!, { max: 1 });
  try {
    return await sql.begin(async (tx: Bun.SQL) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return fn(tx);
    });
  } finally {
    await sql.close();
  }
}

async function seedService(
  tx: Bun.SQL,
  code: string,
  name: string,
  mode: "stay" | "slot" = "stay"
) {
  const product = (await tx`
    INSERT INTO awcms_commerce_products
      (tenant_id, type, sku, name, slug, price, stock, status)
    VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${name}, ${`slug-${code}`}, '500000.00', 0, 'active')
    RETURNING id`) as { id: string }[];
  const resource = (await tx`
    INSERT INTO awcms_booking_resources
      (tenant_id, code, name, kind, capacity, timezone, booking_mode,
       stay_check_in_time, stay_check_out_time)
    VALUES (${tenantId}, ${`res-${code}`}, ${`Room ${code}`}, 'room', 1,
            'Asia/Pontianak', ${mode}, '14:00'::time, '12:00'::time)
    RETURNING id`) as { id: string }[];
  await tx`
    INSERT INTO awcms_booking_resource_units (tenant_id, resource_id, ordinal)
    VALUES (${tenantId}, ${resource[0]!.id}, 1)`;
  const offering = (await tx`
    INSERT INTO awcms_booking_service_offerings
      (tenant_id, code, name, granularity, min_nights, max_nights, max_party, confirmation_mode)
    VALUES (${tenantId}, ${`night-${code}`}, ${`Night ${code}`}, 'stay', 1, 30, 4, 'hold_then_confirm')
    RETURNING id`) as { id: string }[];
  return {
    productId: product[0]!.id,
    resourceId: resource[0]!.id,
    offeringId: offering[0]!.id
  };
}

test.use({ reducedMotion: "reduce" });

test.describe("booking adapter admin screens (keyboard, real data)", () => {
  test.skip(
    !seeded,
    "requires a seeded tenant and DATABASE_URL - CI e2e-smoke provides both"
  );
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: "awcms_locale", value: "en", url: baseUrl }
    ]);
  });

  test.beforeAll(async ({ browser }) => {
    // The author of the policy versions is a DIFFERENT person from the approver
    // (separation of duties), so a second tenant user is written. It never logs
    // in and holds no role: only its id is needed, so this does NOT use
    // `seedRestrictedUser`, whose role code another spec's seed would collide with.
    fx.authorTenantUserId = await withTenantTx(async (tx) => {
      const existing = (await tx`
        SELECT tu.id FROM awcms_tenant_users tu
        JOIN awcms_identities i ON i.id = tu.identity_id
        WHERE tu.tenant_id = ${tenantId}
          AND i.login_identifier = 'e2e-booking-author@example.com'
        LIMIT 1`) as { id: string }[];
      if (existing[0]) return existing[0].id;
      const profile = (await tx`
        INSERT INTO awcms_profiles (tenant_id, profile_type, display_name)
        VALUES (${tenantId}, 'person', 'E2E Booking Author')
        RETURNING id`) as { id: string }[];
      const identity = (await tx`
        INSERT INTO awcms_identities (tenant_id, profile_id, login_identifier, password_hash)
        VALUES (${tenantId}, ${profile[0]!.id}, 'e2e-booking-author@example.com', 'x')
        RETURNING id`) as { id: string }[];
      const user = (await tx`
        INSERT INTO awcms_tenant_users (tenant_id, identity_id)
        VALUES (${tenantId}, ${identity[0]!.id})
        RETURNING id`) as { id: string }[];
      return user[0]!.id;
    });

    await withTenantTx(async (tx) => {
      const owner = (await tx`
        SELECT tu.id FROM awcms_tenant_users tu
        JOIN awcms_identities i ON i.id = tu.identity_id
        WHERE tu.tenant_id = ${tenantId} AND i.login_identifier = ${loginIdentifier}
        LIMIT 1`) as { id: string }[];
      fx.ownerTenantUserId = owner[0]!.id;

      const a = await seedService(tx, `a${stamp}`, `Aaa Villa ${stamp}`);
      const b = await seedService(tx, `b${stamp}`, `Aab Cottage ${stamp}`);
      fx.productA = a.productId;
      fx.offeringA = a.offeringId;
      fx.productB = b.productId;
      fx.offeringB = b.offeringId;
      fx.resourceB = b.resourceId;

      // Enough extra service products that the deposits list needs a second page.
      for (let n = 0; n < BULK; n += 1) {
        const code = `z${stamp}${String(n).padStart(2, "0")}`;
        await tx`
          INSERT INTO awcms_commerce_products
            (tenant_id, type, sku, name, slug, price, stock, status)
          VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Zzz bulk ${stamp} ${String(n).padStart(2, "0")}`},
                  ${`slug-${code}`}, '100000.00', 0, 'active')`;
      }

      // Product A: two policy versions, so Active and History both have rows.
      for (const percent of ["100.00", "50.00"]) {
        const draft = await createPolicyDraft(
          tx,
          tenantId!,
          fx.authorTenantUserId,
          {
            productId: fx.productA,
            refundBasis: "whole_stay",
            noShowRetention: "retain_deposit",
            windows: [{ minHoursBeforeStart: 168, refundablePercent: percent }]
          },
          crypto.randomUUID()
        );
        if (draft.kind === "refused") throw new Error("draft refused");
        const activated = await approvePolicy(
          tx,
          tenantId!,
          fx.ownerTenantUserId,
          draft.policy.id,
          crypto.randomUUID()
        );
        if (activated.kind !== "activated") {
          throw new Error(`approve returned ${activated.kind}`);
        }
      }
      // Product B: the policy the override dialog's quote is judged by.
      const draftB = await createPolicyDraft(
        tx,
        tenantId!,
        fx.authorTenantUserId,
        {
          productId: fx.productB,
          refundBasis: "whole_stay",
          noShowRetention: "retain_deposit",
          windows: [{ minHoursBeforeStart: 168, refundablePercent: "100.00" }]
        },
        crypto.randomUUID()
      );
      if (draftB.kind === "refused") throw new Error("draft B refused");
      const activatedB = await approvePolicy(
        tx,
        tenantId!,
        fx.ownerTenantUserId,
        draftB.policy.id,
        crypto.randomUUID()
      );
      if (activatedB.kind !== "activated") throw new Error("approve B");
    });

    const context = await browser.newContext({
      storageState: "playwright/.auth/owner.json",
      baseURL: baseUrl
    });
    const page = await context.newPage();
    try {
      await setBookingFeature(page, true);
      const settings = await api(
        page,
        "PUT",
        "/api/v1/commerce/store-settings",
        {
          storeName: "E2E Villa",
          shipping: { selfPickup: true },
          payment: { manualQris: { active: true, mediaObjectId: null } },
          bookingServiceTenantUserId: fx.ownerTenantUserId
        }
      );
      expect(settings.status).toBe(200);

      // Product B is linked by API and booked and paid, so the order detail has
      // a quote and the override dialog has something to override. Product A is
      // linked through the SCREEN, by keyboard, in the first test below.
      const link = await api<{ id: string }>(
        page,
        "POST",
        "/api/v1/commerce/booking/offering-links",
        {
          offeringId: fx.offeringB,
          productId: fx.productB,
          quantityBasis: "nights",
          resourceIds: []
        }
      );
      expect(link.status).toBe(201);
      fx.linkB = link.json.data!.id;
      const reservation = await api<{ orderId: string }>(
        page,
        "POST",
        "/api/v1/commerce/booking/reservations",
        {
          offeringId: fx.offeringB,
          resourceId: fx.resourceB,
          stay: { checkInDate: day(10), checkOutDate: day(12) },
          partySize: 2,
          guest: { name: "Budi", phone: "081311112222" },
          payment: { method: "manual_qris" }
        }
      );
      expect(reservation.status).toBe(201);
      fx.orderB = reservation.json.data!.orderId;
      const paid = await api(
        page,
        "POST",
        `/api/v1/commerce/orders/${fx.orderB}/payments`,
        { tenderType: "manual_qris", amount: "1000000.00" }
      );
      expect(paid.status).toBe(201);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: "playwright/.auth/owner.json",
      baseURL: baseUrl
    });
    const page = await context.newPage();
    try {
      await setBookingFeature(page, false);
    } finally {
      await context.close();
    }
    if (databaseUrl && tenantId) {
      await withTenantTx(async (tx) => {
        await tx`
          DELETE FROM awcms_commerce_products
          WHERE tenant_id = ${tenantId} AND sku LIKE ${`SKU-z${stamp}%`}`;
      });
    }
  });

  test("the sidebar entries follow the booking feature flag", async ({
    page
  }) => {
    const entries = [
      "/admin/commerce-booking-links",
      "/admin/commerce-booking-deposits",
      "/admin/commerce-booking-policies"
    ];
    await setBookingFeature(page, false);
    await page.goto("/admin");
    for (const href of entries) {
      await expect(
        page.locator(`#admin-sidebar a[href="${href}"]`)
      ).toHaveCount(0);
    }
    // The screen itself says why, in words.
    await page.goto("/admin/commerce-booking-links");
    await expect(page.locator("#booking-links-disabled")).toBeVisible();

    await setBookingFeature(page, true);
    await page.goto("/admin");
    for (const href of entries) {
      await expect(
        page.locator(`#admin-sidebar a[href="${href}"]`)
      ).toHaveCount(1);
    }
  });

  test("links: link an offering by keyboard, the notice takes focus after the reload, then unlink through the confirm dialog", async ({
    page
  }) => {
    await page.goto("/admin/commerce-booking-links");
    await expectAxeClean(page, "links (empty-ish form state)");

    // A bad id is refused in words, the field is marked and focused.
    await typeInto(page, "#booking-link-offering", "not-a-uuid");
    await typeInto(page, "#booking-link-product", fx.productA);
    await press(page, "#booking-link-product");
    await expect(page.locator("#booking-link-create-error")).toBeVisible();
    await expect(page.locator("#booking-link-offering")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(await activeId(page)).toBe("booking-link-offering");

    await typeInto(page, "#booking-link-offering", fx.offeringA);
    const reloaded = page.waitForEvent(
      "framenavigated",
      (frame) => frame === page.mainFrame()
    );
    await press(page, "#booking-link-product");
    await reloaded;
    await page.waitForLoadState("load");

    // Product A has an active cancellation policy, so there is no warning; the
    // row is there and the page is still usable by keyboard.
    await expect(
      page.locator(`tr[data-link-row]:has-text("${fx.offeringA}")`)
    ).toBeVisible();
    await expect(page.locator("#booking-link-create-status")).toBeHidden();

    await sweep(page, "/admin/commerce-booking-links", "links with a row");

    // The segmented filter is real navigation and marks the current page.
    await press(page, 'a.admin-segmented-option[href$="status=unlinked"]');
    await expect(page).toHaveURL(/status=unlinked/);
    await expect(
      page.locator('a.admin-segmented-option[aria-current="page"]')
    ).toHaveText("Unlinked");
    await page.goto("/admin/commerce-booking-links?status=active");

    // Unlink: the native confirm dialog, operated by Enter, never window.confirm.
    let rawDialog = false;
    page.on("dialog", () => {
      rawDialog = true;
    });
    const row = page.locator(`tr[data-link-row]:has-text("${fx.offeringA}")`);
    const unlink = row.locator(".booking-link-unlink-btn");
    await unlink.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#commerce-confirm-dialog[open]")).toBeVisible();
    await expectAxeClean(page, "links confirm dialog open");
    // Escape cancels and focus goes back to the button that opened it.
    await page.keyboard.press("Escape");
    await expect(page.locator("#commerce-confirm-dialog[open]")).toHaveCount(0);
    await expect(unlink).toBeFocused();

    const reloadedAfterUnlink = page.waitForEvent(
      "framenavigated",
      (frame) => frame === page.mainFrame()
    );
    await press(
      page,
      `tr[data-link-row]:has-text("${fx.offeringA}") .booking-link-unlink-btn`
    );
    await expect(page.locator("#commerce-confirm-dialog[open]")).toBeVisible();
    await press(page, "#commerce-confirm-dialog-confirm");
    await reloadedAfterUnlink;
    await page.waitForLoadState("load");
    expect(rawDialog).toBe(false);
    await page.goto("/admin/commerce-booking-links?status=unlinked");
    await expect(
      page.locator(`tr[data-link-row]:has-text("${fx.offeringA}")`)
    ).toContainText("Unlinked");
  });

  test("links: a link whose product has no cancellation policy shows the notice and moves focus to it (#448)", async ({
    page
  }) => {
    // A third product with no policy at all.
    const third = await withTenantTx((tx) =>
      seedService(tx, `c${stamp}`, `Aac Bungalow ${stamp}`)
    );
    await page.goto("/admin/commerce-booking-links");
    await typeInto(page, "#booking-link-offering", third.offeringId);
    await typeInto(page, "#booking-link-product", third.productId);
    const reloaded = page.waitForEvent(
      "framenavigated",
      (frame) => frame === page.mainFrame()
    );
    await press(page, "#booking-link-product");
    await reloaded;
    await page.waitForLoadState("load");

    const status = page.locator("#booking-link-create-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("no cancellation policy");
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toBeFocused();
    await expectAxeClean(page, "links with the no-policy notice focused");
  });

  test("deposits: the list pages past its first page and says so (#448)", async ({
    page
  }) => {
    await page.goto("/admin/commerce-booking-deposits");
    await expect(page.locator("tr[data-product-row]")).toHaveCount(50);
    await expect(page.locator("#booking-deposits-more")).toBeVisible();
    await expect(page.locator('a[rel="next"]')).toBeVisible();
    await expect(page.getByRole("link", { name: "First page" })).toHaveCount(0);

    // Follow Next page by keyboard until the last bulk product turns up.
    const lastBulk = `Zzz bulk ${stamp} ${String(BULK - 1).padStart(2, "0")}`;
    let hops = 0;
    while (
      (await page
        .locator(`tr[data-product-row]:has-text("${lastBulk}")`)
        .count()) === 0
    ) {
      hops += 1;
      expect(hops).toBeLessThan(10);
      const before = page.url();
      await press(page, 'a[rel="next"]');
      await page.waitForURL((url) => url.toString() !== before);
      await page.waitForLoadState("load");
    }
    await expect(page.getByRole("link", { name: "First page" })).toBeVisible();
    await expect(page.locator("#booking-deposits-more")).toHaveCount(0);
    await expectAxeClean(page, "deposits last page");
    // An unreadable cursor is the first page, not an error.
    await page.goto("/admin/commerce-booking-deposits?after=garbage");
    await expect(page.locator("tr[data-product-row]")).toHaveCount(50);
  });

  test("deposits: set a percent by keyboard, refuse a bad one in words, and keep the cap of the policy", async ({
    page
  }) => {
    // Product A sorts first ("Aaa"), so it is on the first page.
    await page.goto("/admin/commerce-booking-deposits");
    const row = page.locator(`tr[data-product-row="${fx.productA}"]`);
    await expect(row).toContainText("Full payment");
    const edit = row.locator("xpath=following-sibling::tr[1]//details/summary");
    await edit.focus();
    await page.keyboard.press("Enter");
    const form = page.locator(
      `.deposit-policy-form[data-product-id="${fx.productA}"]`
    );
    await expect(form).toBeVisible();

    // Only the field of the chosen kind is in the tab order.
    await expect(form.locator('[data-deposit-for="percent"]')).toBeHidden();
    await form.locator('input[name="kind"][value="percent"]').focus();
    await page.keyboard.press("Space");
    await expect(form.locator('[data-deposit-for="percent"]')).toBeVisible();
    await expect(form.locator('[data-deposit-for="fixed"]')).toBeHidden();
    await expect(form.locator('input[name="fixedAmount"]')).toBeDisabled();

    await expectAxeClean(page, "deposits form open");
    await page.setViewportSize({ width: 360, height: 900 });
    await expectNoSidewaysScroll(page, "deposits form open");
    await page.setViewportSize({ width: 1280, height: 900 });

    const percent = form.locator('input[name="percent"]');
    await percent.fill("abc");
    await press(
      page,
      `.deposit-policy-form[data-product-id="${fx.productA}"] input[name="percent"]`
    );
    await expect(page.locator(`#deposit-error-${fx.productA}`)).toBeVisible();
    await expect(percent).toHaveAttribute("aria-invalid", "true");
    await expect(percent).toBeFocused();

    await percent.fill("30");
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes(`/products/${fx.productA}/deposit-policy`) &&
        response.request().method() === "PUT"
    );
    await press(
      page,
      `.deposit-policy-form[data-product-id="${fx.productA}"] input[name="percent"]`
    );
    expect((await saved).status()).toBe(200);
    await page.waitForLoadState("load");
    await expect(
      page.locator(`tr[data-product-row="${fx.productA}"]`)
    ).toContainText("30.00% of the total");

    await sweep(
      page,
      "/admin/commerce-booking-deposits",
      "deposits with a policy"
    );
  });

  test("policies: active version, draft and read-only history; windows are added and removed with the keyboard", async ({
    page
  }) => {
    await page.goto(`/admin/commerce-booking-policies?scope=${fx.productA}`);
    await expect(page.locator("#policy-active-table")).toContainText("50");
    // History is read-only: it has rows and no control at all.
    await expect(page.locator("#policy-history-table tbody tr")).toHaveCount(1);
    await expect(
      page.locator("#policy-history-table").locator("button, a, input, select")
    ).toHaveCount(0);
    // The scope selector names the product, and the cut notice is absent below the cap.
    await expect(page.locator("#booking-policies-scope")).toContainText(
      `Aaa Villa ${stamp}`
    );
    await expect(page.locator("#booking-policies-scope-cut")).toHaveCount(0);

    await sweep(
      page,
      `/admin/commerce-booking-policies?scope=${fx.productA}`,
      "policies (active + history)"
    );

    // Add a window: focus moves into the new row.
    await press(page, "#booking-policy-add-row");
    await expect(page.locator("[data-policy-row-editor]")).toHaveCount(2);
    await expect(
      page.locator("[data-policy-row-editor]:last-child [name='notice']")
    ).toBeFocused();
    // Remove it: focus stays inside the form, not on the page top.
    await press(
      page,
      "[data-policy-row-editor]:last-child .booking-policy-remove-btn"
    );
    await expect(page.locator("[data-policy-row-editor]")).toHaveCount(1);
    await expect(
      page.locator("[data-policy-row-editor]:first-child [name='notice']")
    ).toBeFocused();

    // Save a draft by keyboard; it lands in the drafts table.
    const reloaded = page.waitForEvent(
      "framenavigated",
      (frame) => frame === page.mainFrame()
    );
    await press(page, "#booking-policy-submit");
    await reloaded;
    await page.waitForLoadState("load");
    await expect(page.locator("#policy-drafts-table")).toBeVisible();
    await expect(
      page.locator("#policy-drafts-table .booking-policy-approve-btn")
    ).toHaveCount(1);
    await sweep(
      page,
      `/admin/commerce-booking-policies?scope=${fx.productA}`,
      "policies (draft row)"
    );
  });

  test("override dialog: cannot be submitted above the amount paid, closes with Escape and returns focus", async ({
    page
  }) => {
    for (const theme of ["light", "dark"] as const) {
      await page.goto(`/admin/commerce-orders/${fx.orderB}`);
      await setTheme(page, theme);
      await expect(page.locator("#order-booking-panel")).toBeVisible();
      await expectAxeClean(page, `order detail booking panel (${theme})`);

      const opener = page.locator("#order-booking-override");
      await opener.focus();
      await page.keyboard.press("Enter");
      const dialog = page.locator("#booking-override-dialog");
      await expect(dialog).toBeVisible();
      // The safe choice has the focus.
      expect(await activeId(page)).toBe("booking-override-keep");
      await expect(page.locator("#booking-override-submit")).toBeDisabled();

      // Above what was paid: refused in words, field marked, button disabled.
      await typeInto(page, "#booking-override-amount", "1000000.01");
      await expect(page.locator("#booking-override-amount")).toHaveAttribute(
        "aria-invalid",
        "true"
      );
      await expect(
        page.locator("#booking-override-amount-error")
      ).toContainText("cannot be more than the amount paid");
      await typeInto(
        page,
        "#booking-override-reason",
        "Goodwill after a pipe burst."
      );
      await expect(page.locator("#booking-override-submit")).toBeDisabled();

      // At or below the cap, with a reason: the button is available.
      await typeInto(page, "#booking-override-amount", "500000.00");
      await expect(page.locator("#booking-override-amount")).toHaveAttribute(
        "aria-invalid",
        "false"
      );
      await expect(page.locator("#booking-override-submit")).toBeEnabled();
      await expectAxeClean(page, `override dialog (${theme})`);

      await page.setViewportSize({ width: 360, height: 640 });
      await expectNoSidewaysScroll(page, "override dialog open");
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
    }
    await setTheme(page, "light");
    // 360px with no dialog open: the panel and the page do not overflow.
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`/admin/commerce-orders/${fx.orderB}`);
    await expectNoSidewaysScroll(page, "order detail with the booking panel");
  });
});
