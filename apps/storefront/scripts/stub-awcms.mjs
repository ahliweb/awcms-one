#!/usr/bin/env bun
/**
 * A local stand-in for awcms, used ONLY to prove `bun run build` produces a
 * real `dist/client` without a live CMS (issue #5 acceptance: "builds
 * against a stubbed CMS response"). Serves the two commerce endpoints
 * `src/lib/catalog.ts` calls, reading their response bodies straight from
 * the fixtures committed at `tests/fixtures/awcms/` — the shape this script
 * answers with is exactly the shape a reviewer can already read as plain
 * JSON, not a shape hidden inside this script.
 *
 * Not part of the production build or image: nothing under `scripts/` is
 * imported by `astro.config.mjs`, `src/`, or `server/penyaji.mjs`, and this
 * file is not wired into any `package.json` script — it is a manual,
 * explicit step for local/CI verification against a build that has no live
 * CMS to reach.
 *
 * Usage (two terminals):
 *   bun scripts/stub-awcms.mjs
 *   AWCMS_API_URL=http://localhost:4310 AWCMS_API_TOKEN=stub-token \
 *     SITE_URL=http://localhost:4321 bun run build
 */
import { readFileSync } from "node:fs";

const PORT = Number(process.env.STUB_PORT ?? 4310);
const FIXTURES = new URL("../tests/fixtures/awcms/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

const ROUTES = {
  "/api/v1/commerce/products": () => fixture("products.json"),
  "/api/v1/commerce/categories": () => fixture("categories.json")
};

const server = Bun.serve({
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization") ?? "";

    // Not a security boundary — this is a local fixture server — but a
    // build that sent NO Authorization header at all would be a real bug in
    // `awcmsGet`, and a stub that accepted it silently would hide exactly
    // that bug.
    if (!authorization.startsWith("Bearer ")) {
      return Response.json(
        { success: false, error: { code: "UNAUTHENTICATED", message: "Missing bearer token." } },
        { status: 401 }
      );
    }

    const handler = ROUTES[url.pathname];
    if (!handler) {
      return Response.json(
        { success: false, error: { code: "NOT_FOUND", message: `No stub route for ${url.pathname}` } },
        { status: 404 }
      );
    }

    return Response.json({ success: true, data: handler() });
  }
});

console.log(`[stub-awcms] serving fixtures on http://localhost:${server.port}`);
