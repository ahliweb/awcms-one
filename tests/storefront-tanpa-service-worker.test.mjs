/**
 * Origin-separation and service-worker guard for the storefront (issues #427,
 * #431; ADR-0048 section 6.3/7, ADR-0049 D2).
 *
 * ## What this file used to say, and what it says now
 *
 * Until issue #431 it forbade ANY service worker or Push API use in
 * `apps/storefront`, because a shopper's browser must never acquire a worker
 * whose scope and caching nobody reviewed. ADR-0048 (Accepted, 24 October 2026)
 * then decided that customer Web Push needs a service worker on the STOREFRONT
 * origin - the CMS origin's `/push-sw.js` cannot serve it, a worker is never
 * registered cross-origin, and iOS delivers a closed-app push only to a
 * registered worker of an installed web app. The rule is therefore no longer
 * "no worker"; it is "exactly ONE worker, and it can do nothing else":
 *
 *   1. one file, `apps/storefront/src/push/pekerja/sw-notifikasi.js`, served at
 *      the fixed URL `/sw-notifikasi.js` (never in `public/`, never under a
 *      hashed name);
 *   2. it is PUSH AND CLICK ONLY: no `fetch` handler, no Cache Storage, no
 *      network call, no `importScripts`, no storage, no token and no API origin
 *      (so it intercepts and caches nothing, and the `/` scope costs nothing);
 *   3. it exists in a build only behind the opt-in `PUBLIC_CUSTOMER_PUSH` flag
 *      and only in a profile with customer accounts - the default build ships no
 *      worker, no settings page and no link, as before;
 *   4. the Push API and the permission prompt are used in ONE browser module
 *      (`src/lib/push-alur.ts`), and its only caller that can start an enrolment
 *      is the settings page's submit handler (a user gesture) - never a page
 *      load, a login or a timer.
 *
 * Anything else - a second worker, a worker in `public/`, a `fetch` handler
 * added "for offline", `serviceWorker.register` from another module, a
 * permission prompt from a layout - fails the root suite. Widening any of this
 * is an ADR change, not an edit of this test.
 *
 * Scope: the storefront's own source, public directory and integrations. It
 * claims nothing about the built output of `apps/cms`, which has its own tests
 * (`apps/cms/tests/pwa-installable-admin.test.ts`). The behaviour of the worker
 * itself (both payload formats, the click-target walls) is exercised by
 * `apps/storefront/tests/push-pekerja.test.ts`; the build-time gating by
 * `apps/storefront/tests/push-build-smoke.test.ts`.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "apps/storefront/src",
  "apps/storefront/public",
  "apps/storefront/integrations",
  "apps/storefront/server",
];
const TEXT = /\.(astro|ts|tsx|js|mjs|html|webmanifest|json)$/;

/** The one service worker, the one module that registers it, and the one that starts an enrolment. */
const WORKER_FILE = "apps/storefront/src/push/pekerja/sw-notifikasi.js";
const WORKER_ROUTE_FILE = "apps/storefront/src/push/sw-notifikasi.js.ts";
const PUSH_MODULE = "apps/storefront/src/lib/push-alur.ts";
const SETTINGS_SCRIPT = "apps/storefront/src/scripts/akun-notifikasi.ts";
const INTEGRATION = "apps/storefront/integrations/profil.mjs";
const WORKER_URL = "/sw-notifikasi.js";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Drops block and line comments so a docblock that EXPLAINS a rule is not mistaken for a violation of it. A `//` inside a URL string is kept (it is not preceded by whitespace). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/.*$/gm, "$1");
}

const files = ROOTS.filter(existsSync).flatMap((root) => [...walk(root)]);
const sources = new Map(files.filter((f) => TEXT.test(f)).map((f) => [f, readFileSync(f, "utf8")]));

function filesMatching(pattern) {
  return [...sources].filter(([, text]) => pattern.test(code(text))).map(([file]) => file);
}

describe("apps/storefront has exactly one service worker, and it is push-only", () => {
  test("the scan sees the storefront's files", () => {
    assert.ok(files.length > 20, `only ${files.length} files scanned`);
  });

  test("the only worker file is the push worker, and it is not under public/", () => {
    const offenders = files.filter((f) => /(^|\/)(push-sw|sw|sw-[a-z-]+|service-worker)\.js$/.test(f));
    assert.deepEqual(offenders, [WORKER_FILE]);
    assert.deepEqual(
      files.filter((f) => f.startsWith("apps/storefront/public/") && /\.js$/.test(f)),
      [],
      "a script in public/ is served verbatim and unreviewed; the worker is routed from src/push/",
    );
  });

  test("the worker is served at its fixed URL by one route file, which only inlines the worker text", () => {
    assert.ok(existsSync(WORKER_ROUTE_FILE));
    const route = code(readFileSync(WORKER_ROUTE_FILE, "utf8"));
    assert.match(route, /from "\.\/pekerja\/sw-notifikasi\.js\?raw"/);
    assert.doesNotMatch(route, /process\.env|import\.meta\.env|\$\{/, "no build data is interpolated into the worker");
  });

  test("only src/lib/push-alur.ts registers a worker, and only the fixed URL constant", () => {
    assert.deepEqual(filesMatching(/serviceWorker\s*\.\s*register\s*\(/), [PUSH_MODULE]);
    const module = code(sources.get(PUSH_MODULE));
    assert.equal((module.match(/serviceWorker\s*\.\s*register\s*\(/g) ?? []).length, 1);
    assert.match(module, /register\(\s*PUSH_WORKER_PATH\s*,\s*\{\s*scope:\s*PUSH_WORKER_SCOPE/);
    // No other module names the worker URL as a literal.
    assert.deepEqual(
      filesMatching(/["'`]\/sw-notifikasi\.js["'`]/).sort(),
      ["apps/storefront/src/lib/push-konfig.ts"],
    );
  });

  test("only src/lib/push-alur.ts uses the Push API or asks for the notification permission", () => {
    assert.deepEqual(filesMatching(/\.pushManager\b|PushManager\s*\./), [PUSH_MODULE]);
    assert.deepEqual(filesMatching(/Notification\s*\.\s*requestPermission/), [PUSH_MODULE]);
    assert.deepEqual(filesMatching(/\.pushManager\b[\s\S]{0,40}\.subscribe\s*\(/), [PUSH_MODULE]);
  });

  test("the permission prompt can only be reached from the settings page's submit handler (TS-E2)", () => {
    // `aktifkanPerangkat` is the only function that asks; it has one caller in scripts...
    const callers = [...sources]
      .filter(([f]) => f.startsWith("apps/storefront/src/") && f !== PUSH_MODULE)
      .filter(([, text]) => /\baktifkanPerangkat\s*\(/.test(code(text)))
      .map(([f]) => f);
    assert.deepEqual(callers, [SETTINGS_SCRIPT]);

    // ...inside `jalankanAktifkan`, which has exactly one call site: the form's submit listener.
    const settings = code(sources.get(SETTINGS_SCRIPT));
    const sites = [...settings.matchAll(/\bjalankanAktifkan\s*\(/g)];
    assert.equal(sites.length, 2, "one definition and one call");
    const submit = settings.slice(settings.indexOf('form?.addEventListener("submit"'));
    assert.match(submit.slice(0, submit.indexOf("async function jalankanAktifkan")), /void jalankanAktifkan\(/);
    // Never on load: no top-level call of the enrolment, and the three load hooks only call `muat`.
    assert.doesNotMatch(settings, /DOMContentLoaded[\s\S]{0,80}aktifkan/);
    assert.doesNotMatch(settings, /setTimeout|setInterval/);
  });

  test("the worker is routed only behind PUBLIC_CUSTOMER_PUSH and only for a profile with customer accounts", () => {
    const integration = code(readFileSync(INTEGRATION, "utf8"));
    const gate = integration.indexOf("if (isCustomerPushEnabled())");
    assert.ok(gate > 0, "the push routes sit behind the build flag");
    const routes = [...integration.matchAll(/injectRoute\(\s*\{\s*pattern:\s*PUSH_WORKER_PATH/g)];
    assert.equal(routes.length, 1);
    assert.ok(routes[0].index > gate);
    assert.match(integration.slice(gate, routes[0].index), /ACTIVE_GROUPS\.includes\("toko"\)/);

    const konfig = code(readFileSync("apps/storefront/src/lib/push-konfig.ts", "utf8"));
    assert.match(konfig, /\["1", "true", "on", "yes"\]/);
    assert.match(konfig, /raw !== undefined/, "unset means off");
  });

  test("the layouts, the footers and the other pages never reference the worker or the Push API", () => {
    const allowed = new Set([
      PUSH_MODULE,
      WORKER_FILE,
      WORKER_ROUTE_FILE,
      INTEGRATION,
      "apps/storefront/src/lib/push-konfig.ts",
      "apps/storefront/src/lib/push-kunci.ts",
      "apps/storefront/src/lib/push-jaga.ts",
      "apps/storefront/src/lib/push-pelanggan.ts",
      "apps/storefront/src/lib/push-deps.ts",
      "apps/storefront/src/lib/push-sesi.ts",
      SETTINGS_SCRIPT,
      "apps/storefront/src/scripts/akun-notifikasi-kartu.ts",
      "apps/storefront/src/scripts/akun.ts",
      "apps/storefront/src/scripts/akun-header.ts",
      "apps/storefront/src/scripts/masuk.ts",
      "apps/storefront/src/scripts/daftar.ts",
      "apps/storefront/src/push/akun-notifikasi.astro",
      "apps/storefront/src/profil/toko/pages/akun/index.astro",
    ]);
    const mentioning = filesMatching(/sw-notifikasi|push-alur|push-sesi|push-jaga|push-deps|push-pelanggan|push-konfig|push-kunci/);
    const unexpected = mentioning.filter((f) => !allowed.has(f));
    assert.deepEqual(unexpected, []);
    for (const layout of ["BaseLayout.astro", "BeritaLayout.astro"]) {
      assert.doesNotMatch(code(sources.get(`apps/storefront/src/layouts/${layout}`)), /push|serviceWorker|Notification/i);
    }
  });
});

describe("the push worker file cannot do anything but push and click", () => {
  const worker = code(readFileSync(WORKER_FILE, "utf8"));

  test("it listens to install, push and notificationclick only", () => {
    const events = [...worker.matchAll(/addEventListener\(\s*"([a-z]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(events, ["install", "notificationclick", "push"]);
  });

  test("no fetch handler, no network, no offline cache", () => {
    assert.doesNotMatch(worker, /["']fetch["']/);
    assert.doesNotMatch(worker, /\bfetch\s*\(/);
    assert.doesNotMatch(worker, /XMLHttpRequest|WebSocket|EventSource|sendBeacon/);
    assert.doesNotMatch(worker, /\bcaches\b|CacheStorage|importScripts|indexedDB|BackgroundSync|periodicSync/);
  });

  test("no token, no storage, no API origin, no subscription change handler", () => {
    assert.doesNotMatch(worker, /Authorization|Bearer|\bcs_|localStorage|sessionStorage|PUBLIC_|AWCMS|api\/v1/i);
    assert.doesNotMatch(worker, /pushsubscriptionchange/);
  });

  test("it resolves a click target against its own origin and a closed path list", () => {
    assert.match(worker, /new URL\(raw, self\.location\.origin\)/);
    assert.match(worker, /url\.origin !== self\.location\.origin/);
    assert.match(worker, /var ALLOWED_PATHS = \["\/akun", "\/akun\/pesanan", "\/akun\/pesan"\]/);
  });

  test("a click reuses only a window already under /akun, never any same-origin tab", () => {
    assert.match(worker, /function isAccountWindow\(href\)/);
    assert.match(worker, /url\.pathname\.indexOf\(FALLBACK_PATH \+ "\/"\) === 0/);
    assert.match(worker, /isAccountWindow\(client\.url\)/);
    assert.doesNotMatch(worker, /sameOrigin\s*\(/);
  });

  test("it takes no icon or image from the payload", () => {
    assert.doesNotMatch(worker, /source\.icon|source\.image|source\.badge|raw\.icon|raw\.image/);
  });
});

describe("the sibling origin rules still hold", () => {
  test("no admin worker or CMS push path is referenced from the storefront", () => {
    assert.deepEqual(filesMatching(/["'`]\/push-sw\.js["'`]/), []);
    assert.deepEqual(filesMatching(/\/admin\/push-notifications/), []);
  });

  test("the storefront links no admin manifest", () => {
    assert.deepEqual(filesMatching(/\/admin\/manifest|admin\.webmanifest/), []);
  });
});
