/**
 * The cashier / front-desk tab of `/admin/commerce-pos` in a real browser, with
 * real data, by KEYBOARD (Issue #388, `docs/booking-ux-flows.md` section 5,
 * Surface D): find a reservation by its code and the customer's contact, take
 * the balance, check the guest in and out.
 *
 * ## What this proves that the static contract tests cannot
 *
 * `tests/commerce-front-desk-contract.test.ts` reads sources and
 * `tests/front-desk-client.test.ts` asserts the pure rules. Here a real page is
 * driven by the keyboard against the real POS booking routes (Issue #383):
 *   - axe `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa` finds no critical or serious
 *     violation (this includes Label in Name, `label-content-name-mismatch`) in
 *     the light AND the dark theme, at 360px and at 1280px, in the empty state
 *     and with a reservation card on screen;
 *   - the page never scrolls sideways at 360px;
 *   - the whole flow works with the keyboard alone: Enter in the code field moves
 *     to the contact (what a scanner sends), Enter in the contact looks up, a
 *     disabled control stays reachable and says why, Enter in an amount submits
 *     the payment, the sale screen's shortcuts (F2, Alt+Shift+K) work here;
 *   - focus is moved on purpose after every outcome: the first refused field on a
 *     refused lookup, the card heading on a found card, the result line after a
 *     payment, a check-in and a check-out;
 *   - a refused value is `aria-invalid` and tied to its message;
 *   - the tenant's check-in policy is followed: with the default (block) the
 *     check-in is unavailable while a balance is owed, and the reason is visible
 *     (residual R3 of PR #443 - the owner has not confirmed the default);
 *   - nothing about the lookup is left in `localStorage` or `sessionStorage`, and
 *     the contact field is empty once the card is shown;
 *   - no raw browser dialog opens.
 *
 * ## What it deliberately does not do
 *
 * Turning the check-in policy OFF is a loosening of a money control and needs a
 * second factor (`STEP_UP_REQUIRED`), which the seeded owner does not have, so
 * the allow-variant is proven by `tests/front-desk-client.test.ts` (the card's
 * hint is what enables the control) and by the route integration suite
 * (`tests/integration/commerce-booking-pos.integration.test.ts`). The "no open
 * register session" state is proven by the unit test of `actionStates`.
 *
 * Needs `DATABASE_URL` (the migration owner) to seed the Booking rows and to
 * dispatch the domain events that confirm the reservation; skipped without it.
 * WRITE wave: it turns commerce features on and restores them afterwards, and it
 * writes booking, order, payment and register rows.
 *
 * NOTE: the Playwright browsers are not available in the sandbox this was written
 * in; this spec runs on the trusted host's e2e legs.
 */
import AxeBuilder from "@axe-core/playwright";

import { test, expect, type Page } from "@playwright/test";

import { THEME_STORAGE_KEY } from "../../src/lib/security/theme-init-script";
import { dispatchDomainEventsForTenant } from "../../src/modules/domain-event-runtime/application/dispatch-domain-events";

const tenantId = process.env.E2E_TENANT_ID;
const loginIdentifier = process.env.E2E_LOGIN_IDENTIFIER;
const password = process.env.E2E_PASSWORD;
const databaseUrl = process.env.DATABASE_URL;
const seeded = Boolean(tenantId && loginIdentifier && password && databaseUrl);
const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:4321";

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["critical", "serious"]);
const stamp = Date.now().toString(36);
const PATH = "/admin/commerce-pos?tab=front-desk";
const PHONE = "081311112222";

type Fixture = {
  ownerTenantUserId: string;
  reservationNo: string;
  reservationId: string;
  orderId: string;
  registerId: string;
  featuresBefore: Record<string, boolean>;
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

/** Light and dark, 360px and the desktop; `prepare` re-establishes any state a reload drops. */
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

async function activeId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? "");
}

/** Typing as a keyboard user does: focus the field, then type. */
async function typeInto(page: Page, selector: string, text: string) {
  const target = page.locator(selector);
  await target.focus();
  await target.fill(text);
}

/** The lookup, by keyboard: the code, Enter (a scanner's Enter), the contact, Enter. */
async function lookUp(page: Page, code: string, contact: string) {
  await typeInto(page, "#fd-code", code);
  await page.keyboard.press("Enter");
  expect(await activeId(page)).toBe("fd-contact");
  await page.keyboard.type(contact);
  await page.keyboard.press("Enter");
}

async function lookUpFixture(page: Page) {
  await lookUp(page, fx.reservationNo, PHONE);
  await expect(page.locator("#fd-card")).toBeVisible();
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

async function withDb<T>(fn: (sql: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new Bun.SQL(databaseUrl!, { max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

async function withTenantTx<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  return withDb((sql) =>
    sql.begin(async (tx: Bun.SQL) => {
      await tx.unsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return fn(tx);
    })
  );
}

const day = (offset: number): string =>
  new Date(Date.now() + (200 + offset) * 86_400_000).toISOString().slice(0, 10);

test.use({ reducedMotion: "reduce" });

test.describe("cashier / front-desk tab (keyboard, real data)", () => {
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
    const context = await browser.newContext({
      storageState: "playwright/.auth/owner.json",
      baseURL: baseUrl
    });
    const page = await context.newPage();
    try {
      await page.goto("/admin");
      // The three features the screen needs, remembered so they are restored.
      const settings = await api<{
        effective: { features: Record<string, boolean> };
      }>(page, "GET", "/api/v1/tenant/modules/commerce/settings");
      fx.featuresBefore = settings.json.data!.effective.features;
      const patched = await api(
        page,
        "PATCH",
        "/api/v1/tenant/modules/commerce/settings",
        {
          features: {
            ...fx.featuresBefore,
            pos: true,
            booking: true,
            register: true
          }
        }
      );
      expect(patched.status).toBe(200);

      fx.ownerTenantUserId = await withTenantTx(async (tx) => {
        const owner = (await tx`
          SELECT tu.id FROM awcms_tenant_users tu
          JOIN awcms_identities i ON i.id = tu.identity_id
          WHERE tu.tenant_id = ${tenantId} AND i.login_identifier = ${loginIdentifier}
          LIMIT 1`) as { id: string }[];
        return owner[0]!.id;
      });
      const store = await api(page, "PUT", "/api/v1/commerce/store-settings", {
        storeName: "E2E Villa",
        shipping: { selfPickup: true },
        payment: { manualQris: { active: true, mediaObjectId: null } },
        bookingServiceTenantUserId: fx.ownerTenantUserId
      });
      expect(store.status).toBe(200);

      // A bookable room: product, resource with one unit, offering.
      const seededRows = await withTenantTx(async (tx) => {
        const code = `fd${stamp}`;
        const product = (await tx`
          INSERT INTO awcms_commerce_products
            (tenant_id, type, sku, name, slug, price, stock, status)
          VALUES (${tenantId}, 'service', ${`SKU-${code}`}, ${`Front desk villa ${stamp}`}, ${`slug-${code}`}, '500000.00', 0, 'active')
          RETURNING id`) as { id: string }[];
        const resource = (await tx`
          INSERT INTO awcms_booking_resources
            (tenant_id, code, name, kind, capacity, timezone, booking_mode,
             stay_check_in_time, stay_check_out_time)
          VALUES (${tenantId}, ${`res-${code}`}, ${`Room ${code}`}, 'room', 1,
                  'Asia/Pontianak', 'stay', '14:00'::time, '12:00'::time)
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
      });

      const link = await api(
        page,
        "POST",
        "/api/v1/commerce/booking/offering-links",
        {
          offeringId: seededRows.offeringId,
          productId: seededRows.productId,
          quantityBasis: "nights",
          resourceIds: []
        }
      );
      expect(link.status).toBe(201);
      // A 30% deposit: 2 nights x 500,000 = 1,000,000; 300,000 now, 700,000 at the desk.
      const deposit = await api(
        page,
        "PUT",
        `/api/v1/commerce/products/${seededRows.productId}/deposit-policy`,
        { kind: "percent", percent: "30.00" }
      );
      expect(deposit.status).toBe(200);

      const reservation = await api<{
        orderId: string;
        reservation: { id: string; reservationNo: string };
      }>(page, "POST", "/api/v1/commerce/booking/reservations", {
        offeringId: seededRows.offeringId,
        resourceId: seededRows.resourceId,
        stay: { checkInDate: day(0), checkOutDate: day(2) },
        partySize: 2,
        guest: {
          name: "Budi Santoso",
          phone: PHONE,
          email: "budi@tamu.example"
        },
        payment: { method: "dp" }
      });
      expect(reservation.status).toBe(201);
      fx.orderId = reservation.json.data!.orderId;
      fx.reservationId = reservation.json.data!.reservation.id;
      fx.reservationNo = reservation.json.data!.reservation.reservationNo;
      const paid = await api(
        page,
        "POST",
        `/api/v1/commerce/orders/${fx.orderId}/payments`,
        { tenderType: "manual_qris", amount: "300000.00" }
      );
      expect(paid.status).toBe(201);

      // The deposit confirms the reservation through the domain event consumer.
      await withDb(async (sql) => {
        for (let pass = 0; pass < 4; pass += 1) {
          await dispatchDomainEventsForTenant(sql, tenantId!, { limit: 200 });
        }
      });
      // Arrival today in the room's zone: no application path moves a stay's
      // dates (the items table is append-only), so the fixture does, exactly as
      // the integration suite does.
      await withDb(async (sql) => {
        await sql.unsafe(
          "ALTER TABLE awcms_booking_reservation_items DISABLE TRIGGER awcms_booking_reservation_items_append_only"
        );
        try {
          await sql.unsafe(
            `UPDATE awcms_booking_reservation_items
             SET check_in_date = (now() AT TIME ZONE timezone)::date,
                 check_out_date = (now() AT TIME ZONE timezone)::date + nights
             WHERE reservation_id = '${fx.reservationId}'`
          );
        } finally {
          await sql.unsafe(
            "ALTER TABLE awcms_booking_reservation_items ENABLE TRIGGER awcms_booking_reservation_items_append_only"
          );
        }
      });

      // The cashier's shift: a register and an open session on it.
      const register = await api<{ id: string }>(
        page,
        "POST",
        "/api/v1/commerce/registers",
        {
          code: `FD-${stamp}`.slice(0, 20).toUpperCase(),
          name: `Front desk ${stamp}`,
          locationLabel: "Front"
        }
      );
      expect(register.status).toBe(201);
      fx.registerId = register.json.data!.id;
      const session = await api(
        page,
        "POST",
        "/api/v1/commerce/register-sessions",
        { registerId: fx.registerId, openingFloat: "100000.00" }
      );
      expect(session.status).toBe(201);
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
      await page.goto("/admin");
      if (fx.featuresBefore) {
        await api(page, "PATCH", "/api/v1/tenant/modules/commerce/settings", {
          features: fx.featuresBefore
        });
      }
    } finally {
      await context.close();
    }
  });

  test("the empty state: tabs, the lookup form, no arrivals list, accessible in both themes at both widths", async ({
    page
  }) => {
    await page.goto(PATH);
    await expect(page.locator("#fd-heading")).toHaveText("Front desk");
    await expect(
      page.locator('nav[aria-label="POS sections"] a[aria-current="page"]')
    ).toHaveText("Front desk");
    // Both fields are required and labelled; there is no search by name or date.
    await expect(page.locator('label[for="fd-code"]')).toContainText(
      "Reservation code"
    );
    await expect(page.locator('label[for="fd-contact"]')).toContainText(
      "Customer phone or e-mail"
    );
    await expect(page.locator("#fd-empty")).toContainText(
      "There is no list of arrivals"
    );
    await expect(page.locator("#fd-card")).toBeHidden();
    await expect(page.locator("#fd-register-open")).toContainText(
      "Session open"
    );
    // The page opens on the code field, so a scanner can be used at once.
    expect(await activeId(page)).toBe("fd-code");

    await sweep(page, PATH, "front desk, empty");
  });

  test("a lookup that cannot be sent, or finds nothing, is refused in words and marks the field", async ({
    page
  }) => {
    let rawDialog = false;
    page.on("dialog", () => {
      rawDialog = true;
    });
    await page.goto(PATH);

    // Nothing typed: the code is the first refused field and takes focus.
    await page.locator("#fd-find").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-lookup-error")).toHaveText(
      "Enter the reservation code."
    );
    await expect(page.locator("#fd-code")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(await activeId(page)).toBe("fd-code");

    // A code and no contact: the contact is refused, not the code.
    await typeInto(page, "#fd-code", fx.reservationNo);
    await page.locator("#fd-find").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-lookup-error")).toHaveText(
      "Enter the customer's phone number or e-mail address."
    );
    await expect(page.locator("#fd-contact")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await expect(page.locator("#fd-code")).not.toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(await activeId(page)).toBe("fd-contact");

    // The right code with the wrong customer: ONE neutral answer, both fields
    // refused together (C-34), focus on the first.
    await typeInto(page, "#fd-contact", "081200000000");
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-lookup-error")).toHaveText(
      "Reservation not found."
    );
    await expect(page.locator("#fd-code")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    await expect(page.locator("#fd-contact")).toHaveAttribute(
      "aria-invalid",
      "true"
    );
    expect(await activeId(page)).toBe("fd-code");
    await expect(page.locator("#fd-card")).toBeHidden();
    await expectAxeClean(page, "front desk, refused lookup");

    expect(rawDialog).toBe(false);
  });

  test("a found card: the reservation, three money rows, the policy and a check-in that says why it is unavailable", async ({
    page
  }) => {
    await page.goto(PATH);
    await lookUpFixture(page);

    // Focus is on the card heading, which names the reservation.
    expect(await activeId(page)).toBe("fd-card-heading");
    await expect(page.locator("#fd-card-heading")).toHaveText(fx.reservationNo);
    await expect(page.locator("#fd-status-text")).toHaveText("Confirmed");
    await expect(page.locator("#fd-guest")).toHaveText("Budi Santoso");
    // The contact is masked, and the field the cashier typed it into is empty.
    await expect(page.locator("#fd-contact-masked")).toContainText("2222");
    await expect(page.locator("#fd-contact-masked")).not.toContainText(PHONE);
    await expect(page.locator("#fd-contact")).toHaveValue("");

    // The server's three figures, in text: total, paid so far, balance due.
    await expect(page.locator("#fd-total")).toContainText("1,000,000");
    await expect(page.locator("#fd-paid")).toContainText("300,000");
    await expect(page.locator("#fd-due")).toContainText("700,000");

    // R3: with the default (block) a balance owed makes the check-in
    // unavailable, and the reason is text beside it. The control stays
    // reachable by keyboard (aria-disabled), and pressing it says the reason.
    await expect(page.locator("#fd-policy")).toContainText(
      "requires the balance to be paid before check-in"
    );
    const checkIn = page.locator("#fd-check-in");
    await expect(checkIn).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator("#fd-check-in-reason")).toHaveText(
      "Collect the remaining balance first."
    );
    await checkIn.focus();
    await expect(checkIn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-result")).toContainText(
      "Collect the remaining balance first."
    );
    expect(await activeId(page)).toBe("fd-result");

    // Check-out is unavailable too, for its own reason.
    await expect(page.locator("#fd-check-out")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    await expect(page.locator("#fd-check-out-reason")).toHaveText(
      "Only a checked-in guest can be checked out."
    );

    await sweep(page, PATH, "front desk, reservation card", lookUpFixture);
  });

  test("the keyboard shortcuts of the sale screen work here, and the help is a native dialog", async ({
    page
  }) => {
    let rawDialog = false;
    page.on("dialog", () => {
      rawDialog = true;
    });
    await page.goto(PATH);
    await lookUpFixture(page);

    await page.keyboard.press("F2");
    expect(await activeId(page)).toBe("fd-code");
    await page.keyboard.press("Alt+Shift+C");
    expect(await activeId(page)).toBe("fd-contact");
    await page.keyboard.press("Alt+Shift+P");
    await expect(
      page.locator("#fd-tenders [data-field='amount']").first()
    ).toBeFocused();

    await page.keyboard.press("Alt+Shift+K");
    await expect(page.locator("#fd-shortcuts-dialog[open]")).toBeVisible();
    await expectAxeClean(page, "front desk, shortcut help open");
    await page.keyboard.press("Escape");
    await expect(page.locator("#fd-shortcuts-dialog[open]")).toHaveCount(0);

    // Look up another: clears the card and returns to the code field.
    await page.keyboard.press("Alt+Shift+N");
    await expect(page.locator("#fd-card")).toBeHidden();
    expect(await activeId(page)).toBe("fd-code");
    await expect(page.locator("#fd-code")).toHaveValue("");
    expect(rawDialog).toBe(false);
  });

  test("collect the balance, check in and check out, by keyboard; nothing is kept in the browser", async ({
    page
  }) => {
    let rawDialog = false;
    page.on("dialog", () => {
      rawDialog = true;
    });
    await page.goto(PATH);
    await lookUpFixture(page);

    // A refused amount is marked and focused, and nothing is sent.
    const amount = page.locator("#fd-tenders [data-field='amount']").first();
    await typeInto(page, "#fd-tenders [data-field='amount']", "abc");
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-balance-error")).toContainText(
      "greater than zero"
    );
    await expect(amount).toHaveAttribute("aria-invalid", "true");
    await expect(amount).toBeFocused();

    // Non-cash above the balance is refused as an overpayment.
    await page
      .locator("#fd-tenders [data-field='type']")
      .first()
      .selectOption("manual_qris");
    await amount.fill("800000");
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-balance-error")).toContainText(
      "more than the balance"
    );
    await expect(amount).toHaveAttribute("aria-invalid", "true");

    // Cash: 1,000,000 handed over for 700,000 is 300,000 in change, previewed.
    await page
      .locator("#fd-tenders [data-field='type']")
      .first()
      .selectOption("cash");
    await amount.fill("1000000");
    await expect(page.locator("#fd-sum-change")).toContainText("300,000");
    await expect(page.locator("#fd-sum-remaining")).toContainText("0");
    await page.keyboard.press("Enter");

    // The result line takes focus; it names the amount, the change and that the
    // order is paid in full, and the card shows the new balance.
    await expect(page.locator("#fd-result")).toContainText(
      "Balance of IDR 700,000.00 received"
    );
    await expect(page.locator("#fd-result")).toContainText("paid in full");
    await expect(page.locator("#fd-result")).toContainText(
      "Change to hand back"
    );
    expect(await activeId(page)).toBe("fd-result");
    await expect(page.locator("#fd-due")).toContainText("0");
    await expect(page.locator("#fd-balance-form")).toBeHidden();

    // Check-in is now available and works by Enter.
    const checkIn = page.locator("#fd-check-in");
    await expect(checkIn).not.toHaveAttribute("aria-disabled", "true");
    await checkIn.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-result")).toContainText("Check-in complete");
    expect(await activeId(page)).toBe("fd-result");
    await expect(page.locator("#fd-status-text")).toHaveText("Checked in");
    await expect(page.locator("#fd-check-in")).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    // Check-out.
    const checkOut = page.locator("#fd-check-out");
    await expect(checkOut).not.toHaveAttribute("aria-disabled", "true");
    await checkOut.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#fd-result")).toContainText(
      "Check-out complete"
    );
    expect(await activeId(page)).toBe("fd-result");
    await expect(page.locator("#fd-status-text")).toHaveText("Completed");
    await expectAxeClean(page, "front desk, after check-out");

    // Every write is attributed to the cashier and the register session.
    const audit = await withTenantTx(
      (tx) =>
        tx`SELECT action, actor_tenant_user_id FROM awcms_audit_events
           WHERE tenant_id = ${tenantId}
             AND action LIKE 'commerce.booking_pos.%'
             AND attributes->>'reservationNo' = ${fx.reservationNo}
           ORDER BY created_at` as Promise<
          { action: string; actor_tenant_user_id: string }[]
        >
    );
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "commerce.booking_pos.lookup",
        "commerce.booking_pos.balance_collected",
        "commerce.booking_pos.check_in",
        "commerce.booking_pos.check_out"
      ])
    );
    expect(new Set(audit.map((row) => row.actor_tenant_user_id))).toEqual(
      new Set([fx.ownerTenantUserId])
    );

    // Nothing about the lookup is left in the browser.
    const stored = await page.evaluate(() =>
      JSON.stringify([
        Object.entries(localStorage),
        Object.entries(sessionStorage)
      ])
    );
    expect(stored).not.toContain(fx.reservationNo);
    expect(stored).not.toContain(PHONE);
    expect(rawDialog).toBe(false);
  });
});
