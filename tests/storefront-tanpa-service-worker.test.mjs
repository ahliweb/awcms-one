/**
 * Origin-separation guard for the installable admin and Web Push (issue #427).
 *
 * The CMS serves the admin web app manifest and `/push-sw.js` on ITS origin,
 * and only an operator who enrols a device from `/admin/push-notifications`
 * registers that worker. `apps/storefront` is a separate static origin for
 * shoppers: it must never register a service worker or use the Push API, or a
 * shopper's browser would acquire a worker whose scope and caching nobody
 * reviewed, and a deployment that reverse-proxies both behind one hostname
 * would let the worker's default scope reach shopper pages.
 *
 * Scope: the storefront's own source and public directory. It does not claim
 * anything about the built output of `apps/cms`, which has its own tests
 * (`apps/cms/tests/pwa-installable-admin.test.ts`).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = [
  "apps/storefront/src",
  "apps/storefront/public",
  "apps/storefront/integrations",
];
const TEXT = /\.(astro|ts|tsx|js|mjs|html|webmanifest|json)$/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

describe("apps/storefront registers no service worker", () => {
  const files = ROOTS.filter(existsSync).flatMap((root) => [...walk(root)]);

  test("the scan sees the storefront's files", () => {
    assert.ok(files.length > 20, `only ${files.length} files scanned`);
  });

  test("no service worker file ships in the storefront", () => {
    const offenders = files.filter((f) =>
      /(^|\/)(push-sw|sw|service-worker)\.js$/.test(f),
    );
    assert.deepEqual(offenders, []);
  });

  test("no storefront source registers a worker or touches the Push API", () => {
    const offenders = files
      .filter((f) => TEXT.test(f))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return /serviceWorker\s*\.\s*register|PushManager|pushManager/.test(
          text,
        );
      });
    assert.deepEqual(offenders, []);
  });
});
