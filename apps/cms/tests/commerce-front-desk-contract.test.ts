/**
 * The cashier / front-desk tab of `/admin/commerce-pos` (Issue #388,
 * `docs/booking-ux-flows.md` section 5), pinned from the sources alone: it
 * claims exactly the permissions of the POS booking API (Issue #383), talks to
 * those four routes and no other, keeps nothing in browser storage, offers no
 * override of the tenant's check-in policy (residual R3), uses no browser
 * dialog, and gives every field a bound label. No database, no browser (the
 * rendered behaviour, axe and 360px/1280px are `tests/e2e/admin-commerce-front-desk.e2e.ts`).
 */
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { extractScreenClaims } from "../scripts/admin-screen-coverage-check";
import { NOT_YET_SCREENED } from "../scripts/admin-screen-coverage-ledger";
import { commerceModule } from "../src/modules/commerce/module";

const read = (path: string): string => readFileSync(path, "utf8");

/** Source with its comments removed, so a docblock that SAYS "never localStorage" is not a use of it. */
const code = (path: string): string =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");

const PAGE = "src/pages/admin/commerce-pos.astro";
const COMPONENT = "src/components/CommerceFrontDesk.astro";
const ISLAND = "src/lib/ui/front-desk-island.ts";
const CLIENT = "src/lib/ui/front-desk-client.ts";

const TILL_KEYS = [
  "commerce.booking_check_ins.create",
  "commerce.booking_check_outs.create",
  "commerce.booking_balance_payments.create"
];

describe("permissions", () => {
  const claimed = extractScreenClaims(read(PAGE));

  test("the POS screen claims the lookup key and the three till keys", () => {
    for (const key of [
      ...TILL_KEYS,
      "commerce.booking_reservation_links.read"
    ]) {
      expect(claimed.has(key)).toBe(true);
    }
  });

  test("every claimed key is one the commerce module declares", () => {
    const declared = new Set(
      (commerceModule.permissions ?? []).map(
        (permission) =>
          `${commerceModule.key}.${permission.activityCode}.${permission.action}`
      )
    );
    for (const key of TILL_KEYS) expect(declared.has(key)).toBe(true);
  });

  test("the till keys left the not-yet-screened ledger", () => {
    for (const key of TILL_KEYS) {
      expect(NOT_YET_SCREENED.includes(key)).toBe(false);
    }
  });

  test("the lookup key opens the page; each write is asked on the front-desk tab only", () => {
    const page = read(PAGE);
    expect(page).toContain(
      "authorize: [SALE_ENTRY, HISTORY_ENTRY, DUE_ENTRY, FRONT_DESK_ENTRY]"
    );
    expect(page).toContain('tab === "front-desk"');
    // The three writes are decided by `can(...)` (UX only), never by the client.
    expect(page).toMatch(/frontDeskOn\s*&&\s*\(await can\(/);
  });
});

describe("what the screen talks to", () => {
  const island = read(ISLAND);

  test("only the four POS booking routes", () => {
    const urls = [...island.matchAll(/`?\$\{BASE\}[^`"]*|"\/api\/[^"]*"/g)].map(
      (m) => m[0]
    );
    expect(island).toContain('const BASE = "/api/v1/commerce/pos/booking"');
    expect(island).toContain("`${BASE}/lookup`");
    for (const verb of ["check-in", "check-out"]) {
      expect(island).toContain(verb);
    }
    expect(island).toContain("balance-payments");
    // No other /api/ literal besides the base.
    const apiLiterals = island.match(/\/api\/[a-z0-9/_-]*/gi) ?? [];
    expect(new Set(apiLiterals)).toEqual(
      new Set(["/api/v1/commerce/pos/booking"])
    );
    expect(urls.length).toBeGreaterThan(0);
  });

  test("every write carries an Idempotency-Key (one stay writer for both verbs, one collector)", () => {
    expect(island.match(/"Idempotency-Key":/g)?.length).toBe(2);
    expect(island).toMatch(/writeStay\("check-in"\)/);
    expect(island).toMatch(/writeStay\("check-out"\)/);
  });

  test("a lookup is a POST, so the identifier never lands in a URL", () => {
    expect(island).toContain('sendJsonRequest("POST", `${BASE}/lookup`');
    expect(island).not.toMatch(/lookup\?/);
  });

  test("the body of a write never names a figure the server owns", () => {
    const client = read(CLIENT);
    const builder = client.slice(
      client.indexOf("export function buildBalanceBody")
    );
    for (const forbidden of [
      "balanceDue",
      "unitPrice",
      "lineTotal",
      "orderId",
      "customerId",
      "registerSessionId"
    ]) {
      expect(builder).not.toContain(forbidden);
    }
    // Check-in and check-out send the register and nothing else.
    expect(island).toMatch(/\{ registerId: register \}/);
  });
});

describe("memory only, no browser dialogs", () => {
  const files = [ISLAND, CLIENT, COMPONENT];

  test("nothing is written to browser storage", () => {
    for (const file of files) {
      const source = code(file);
      expect(source).not.toMatch(/sessionStorage|indexedDB|\.setItem\(/);
      expect(source).not.toMatch(/document\.cookie/);
    }
  });

  test("the only storage touch is the READ of the cashier's own shortcut remap", () => {
    const island = code(ISLAND);
    expect(island.match(/localStorage/g)?.length).toBe(1);
    expect(island).toContain(
      "window.localStorage.getItem(SHORTCUTS_STORAGE_KEY)"
    );
  });

  test("no raw browser dialog, and no markup built from server text", () => {
    for (const file of files) {
      const source = code(file);
      expect(source).not.toMatch(/window\.(confirm|alert|prompt)\s*\(/);
      expect(source).not.toMatch(/(?<![.\w])(confirm|alert|prompt)\s*\(/);
      expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    }
  });

  test("the contact is emptied the moment a card is found", () => {
    expect(read(ISLAND)).toMatch(/contactInput\.value = ""/);
  });
});

describe("residual R3 - the check-in policy is read, never overridden", () => {
  test("the island has no step-up, override or waive path", () => {
    const island = code(ISLAND).toLowerCase();
    expect(island).not.toContain("stepup");
    expect(island).not.toContain("override");
    expect(island).not.toContain("waive");
    // It READS the policy to say what the store does; it never writes it.
    expect(island).not.toContain("store-settings");
    expect(island).not.toMatch(/"(put|patch)"/);
  });

  test("the card's own hint is what blocks, and the reason is shown", () => {
    const client = read(CLIENT);
    expect(client).toContain("checkInBlockedReason");
    expect(read(COMPONENT)).toContain("Collect the remaining balance first.");
  });
});

describe("accessibility contract", () => {
  const component = read(COMPONENT);

  test("every text input and the register select has a label bound to it", () => {
    for (const id of ["fd-code", "fd-contact", "fd-register"]) {
      expect(component).toContain(`for="${id}"`);
      expect(component).toContain(`id="${id}"`);
    }
  });

  test("results are in live regions that exist before their content changes", () => {
    expect(component).toContain('id="fd-announce"');
    expect(component).toMatch(/id="fd-announce"[^>]*aria-live="polite"/);
    expect(component).toMatch(
      /id="fd-result"[\s\S]*?role="status"[\s\S]*?tabindex="-1"/
    );
    expect(component).toMatch(/id="fd-lookup-error"[\s\S]*?role="alert"/);
    expect(component).toMatch(/id="fd-balance-error"[\s\S]*?role="alert"/);
  });

  test("a control that cannot be used is aria-disabled with a described reason", () => {
    for (const id of ["fd-check-in", "fd-check-out", "fd-collect"]) {
      expect(component).toMatch(
        new RegExp(`id="${id}"[\\s\\S]*?aria-describedby="${id}-reason"`)
      );
      expect(component).toContain(`id="${id}-reason"`);
    }
    const island = code(ISLAND);
    expect(island).toContain('setAttribute("aria-disabled", "true")');
  });

  test("refused values are aria-invalid and the first takes focus", () => {
    const island = read(ISLAND);
    expect(island).toContain('setAttribute("aria-invalid", "true")');
    expect(island).toMatch(/\(fields\[0\] \?\? lookupError\)\.focus\(\)/);
  });

  test("the stacked shortcut table translates its cell labels", () => {
    expect(component).not.toMatch(/data-label="[A-Za-z]/);
    expect(component).toContain('data-label={t("Action")}');
  });

  test("the card never relies on colour alone: the status pill carries text", () => {
    expect(component).toContain('id="fd-status-text"');
    expect(component).toContain("admin-status-pill-dot");
  });

  test("the shortcut help is a native dialog", () => {
    expect(component).toMatch(/<dialog[\s\S]*?id="fd-shortcuts-dialog"/);
    expect(read(ISLAND)).toContain("dialog.showModal()");
  });
});

describe("loading and wiring", () => {
  test("the island is a dynamic import: other POS tabs download none of it", () => {
    const page = read(PAGE);
    expect(page).toContain('import("../../lib/ui/front-desk-island")');
    expect(page).not.toMatch(/import \{[^}]*initFrontDesk[^}]*\} from/);
  });

  test("the component lives outside src/pages/admin (it is not a screen)", () => {
    expect(existsSync(COMPONENT)).toBe(true);
    expect(COMPONENT.startsWith("src/components/")).toBe(true);
  });

  test("the tab link and the register link are plain navigation", () => {
    const page = read(PAGE);
    expect(page).toContain('href="/admin/commerce-pos?tab=front-desk"');
    expect(read(COMPONENT)).toContain('href="/admin/commerce-registers"');
  });
});

describe("the island and the markup agree", () => {
  const component = read(COMPONENT);
  const island = code(ISLAND);
  const client = code(CLIENT);

  test("every element id the island looks up is rendered", () => {
    const ids = new Set<string>();
    for (const match of island.matchAll(
      /(?:byId|getElementById)(?:<[^>(]*>)?\(\s*"([a-z0-9-]+)"/g
    )) {
      ids.add(match[1]!);
    }
    for (const match of island.matchAll(/setReason\("([a-z0-9-]+)"/g)) {
      ids.add(match[1]!);
    }
    expect(ids.size).toBeGreaterThan(25);
    for (const id of ids) {
      expect(component).toContain(`id="${id}"`);
    }
  });

  test("every sentence key the island reads is a data attribute of #fd-root", () => {
    const keys = new Set<string>();
    for (const source of [island, client]) {
      for (const match of source.matchAll(
        /"((?:msg|reason|label)[A-Z][A-Za-z]*)"/g
      )) {
        keys.add(match[1]!);
      }
    }
    expect(keys.size).toBeGreaterThan(40);
    const attribute = (key: string): string =>
      "data-" + key.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`);
    for (const key of keys) {
      expect(component).toContain(`${attribute(key)}=`);
    }
  });

  test("every data attribute the island reads from #fd-root is set", () => {
    for (const key of [
      "intlTag",
      "currency",
      "registerMode",
      "canCheckIn",
      "canCheckOut",
      "canCollect",
      "statusLabels",
      "tenantShortcuts"
    ]) {
      const attribute =
        "data-" +
        key.replace(/([A-Z])/g, (letter) => `-${letter.toLowerCase()}`);
      expect(component).toContain(`${attribute}=`);
    }
  });

  test("every sentence the component renders is in both catalogues", () => {
    const en = read("locales/en.po");
    const id = read("locales/id.po");
    const strings = [...component.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (match) => match[1]!
    );
    expect(strings.length).toBeGreaterThan(80);
    for (const text of strings) {
      expect(en).toContain(`msgid "${text}"`);
      const at = id.indexOf(`msgid "${text}"\nmsgstr "`);
      expect(at).toBeGreaterThanOrEqual(0);
      // Not left untranslated.
      expect(id.slice(at).startsWith(`msgid "${text}"\nmsgstr ""\n`)).toBe(
        false
      );
    }
  });
});
