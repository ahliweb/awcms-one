/**
 * A customer-bearer endpoint that takes a mutating method must never again be
 * refused by the staff-only body boundary (awcms-one, 14 November 2026 sync).
 *
 * `refuseUnauthenticatedApiBody` accepts a staff session or a machine
 * credential only, so a `cs_` customer token (ADR-0016) was refused
 * `401 AUTH_REQUIRED` before ~15 storefront account routes ran. Those routes are
 * listed in `CUSTOMER_BEARER_BODY_ENDPOINTS` and authenticated by
 * `refuseUnauthenticatedCustomerBody` instead.
 *
 * This file keeps the list honest in all directions, without a database:
 *   - every OpenAPI operation that declares `customerBearer` and uses a body
 *     method is either in that list or deliberately session-free (guest OR
 *     bearer, so the handler decides), so a new customer route cannot ship
 *     unreachable;
 *   - every listed entry is a real `customerBearer` operation and a real route;
 *   - no route under the storefront account tree that calls the customer
 *     bearer guard is left to the staff check;
 *   - the middleware really dispatches the listed endpoints to the customer
 *     check, and that check authenticates before anything is parsed.
 *
 * What it does NOT prove: the live session lookup against PostgreSQL
 * (`commerce-customer-auth.integration.test.ts`, DATABASE_URL-gated).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";
import { parse } from "yaml";

import {
  CUSTOMER_BEARER_BODY_ENDPOINTS,
  SESSION_FREE_BODY_ENDPOINTS,
  isCustomerBearerBodyEndpoint,
  isSessionFreeBodyEndpoint,
  matchesEndpointPattern,
  requiresAuthenticatedCallerBeforeBody
} from "../src/lib/security/api-body-auth-boundary";

const BODY_METHODS = ["POST", "PUT", "PATCH", "DELETE"];
const API_ROOT = path.resolve(import.meta.dir, "../src/pages/api");

type Operation = { security?: Record<string, unknown>[] };
const doc = parse(
  readFileSync(
    path.resolve(import.meta.dir, "../openapi/awcms-public-api.openapi.yaml"),
    "utf8"
  )
) as { paths: Record<string, Record<string, Operation>> };

/** `{id}` / `:id` / `[id]` all become `:_`. */
function key(method: string, route: string): string {
  return `${method.toUpperCase()} ${route
    .replace(/\{[^}]+\}/g, ":_")
    .replace(/\[[^\]]+\]/g, ":_")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":_")}`;
}

const customerBearerOperations = new Map<string, string>();
for (const [route, operations] of Object.entries(doc.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    if (!BODY_METHODS.includes(method.toUpperCase())) continue;
    const mentionsCustomerBearer = (operation.security ?? []).some(
      (requirement) => Object.hasOwn(requirement, "customerBearer")
    );
    if (mentionsCustomerBearer) {
      customerBearerOperations.set(
        key(method, route),
        `${method.toUpperCase()} ${route}`
      );
    }
  }
}

const registered = new Set(
  CUSTOMER_BEARER_BODY_ENDPOINTS.map((e) => key(e.method, e.pattern))
);

function routesOnDisk(): { method: string; url: string; source: string }[] {
  const found: { method: string; url: string; source: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, `${prefix}/${entry.name}`);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const base = entry.name.slice(0, -".ts".length);
      const url = base === "index" ? prefix : `${prefix}/${base}`;
      const source = readFileSync(full, "utf8");
      for (const method of BODY_METHODS) {
        if (new RegExp(`export const ${method}\\b`).test(source)) {
          found.push({ method, url, source: full });
        }
      }
    }
  };
  walk(API_ROOT, "/api");
  return found;
}

describe("customer-bearer body endpoints", () => {
  test("the contract declares customerBearer body operations (non-vacuous)", () => {
    expect(customerBearerOperations.size).toBeGreaterThanOrEqual(15);
  });

  test("every customerBearer body operation is registered or deliberately session-free", () => {
    for (const [k, label] of customerBearerOperations) {
      const [method, pattern] = k.split(" ") as [string, string];
      const admitted =
        registered.has(k) ||
        SESSION_FREE_BODY_ENDPOINTS.some(
          (endpoint) => key(endpoint.method, endpoint.pattern) === k
        );
      expect(
        admitted,
        `${label} declares customerBearer but is in neither CUSTOMER_BEARER_BODY_ENDPOINTS nor SESSION_FREE_BODY_ENDPOINTS (${method} ${pattern}): the middleware would refuse every shopper with 401 AUTH_REQUIRED before the route runs.`
      ).toBe(true);
    }
  });

  test("every registered endpoint is a customerBearer operation and a real route", () => {
    const onDisk = new Set(routesOnDisk().map((r) => key(r.method, r.url)));
    for (const k of registered) {
      expect(
        customerBearerOperations.has(k),
        `${k} is registered as customer-bearer but no OpenAPI operation there declares customerBearer.`
      ).toBe(true);
      expect(onDisk.has(k), `${k} has no route file.`).toBe(true);
    }
    expect(registered.size).toBe(CUSTOMER_BEARER_BODY_ENDPOINTS.length);
  });

  test("a registered endpoint is never also session-free (it would skip authentication)", () => {
    for (const endpoint of CUSTOMER_BEARER_BODY_ENDPOINTS) {
      expect(
        isSessionFreeBodyEndpoint(endpoint.method, endpoint.pattern),
        `${endpoint.method} ${endpoint.pattern} is both customer-bearer and session-free.`
      ).toBe(false);
    }
  });

  test("no storefront account route calling the customer guard is left to the staff check", () => {
    let checked = 0;
    for (const route of routesOnDisk()) {
      if (!route.url.startsWith("/api/v1/commerce/storefront/account/")) {
        continue;
      }
      const usesGuard =
        /requireCustomerSession|handleCustomerPush[A-Za-z]+\(/.test(
          route.source ? readFileSync(route.source, "utf8") : ""
        );
      if (!usesGuard) continue;
      checked++;
      const url = route.url.replace(/\[[^\]]+\]/g, "x");
      expect(
        isCustomerBearerBodyEndpoint(route.method, url) ||
          isSessionFreeBodyEndpoint(route.method, url),
        `${route.method} ${route.url} authenticates a customer bearer but the boundary would apply the staff check.`
      ).toBe(true);
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  test("they still require a credential before the body (not session-free), with trailing slashes normalised", () => {
    for (const endpoint of CUSTOMER_BEARER_BODY_ENDPOINTS) {
      const url = endpoint.pattern.replace(/:[A-Za-z]+/g, "abc");
      expect(requiresAuthenticatedCallerBeforeBody(endpoint.method, url)).toBe(
        true
      );
      expect(isCustomerBearerBodyEndpoint(endpoint.method, url)).toBe(true);
      expect(isCustomerBearerBodyEndpoint(endpoint.method, `${url}/`)).toBe(
        true
      );
      expect(matchesEndpointPattern(endpoint.pattern, url)).toBe(true);
    }
    // A GET, or a sibling path, is not captured by accident.
    expect(
      isCustomerBearerBodyEndpoint(
        "GET",
        "/api/v1/commerce/storefront/account/me"
      )
    ).toBe(false);
    expect(
      isCustomerBearerBodyEndpoint("PATCH", "/api/v1/auth/preferences/locale")
    ).toBe(false);
  });

  test("the middleware dispatches them to the customer check, and that check reads no body", () => {
    const middleware = readFileSync(
      path.resolve(import.meta.dir, "../src/middleware.ts"),
      "utf8"
    );
    expect(middleware).toMatch(
      /isCustomerBearerBodyEndpoint\([\s\S]{0,120}\)\s*\?\s*await refuseUnauthenticatedCustomerBody/
    );

    const authenticator = readFileSync(
      path.resolve(
        import.meta.dir,
        "../src/lib/auth/customer-bearer-body-authentication.ts"
      ),
      "utf8"
    );
    expect(authenticator).not.toMatch(
      /\.json\(|\.text\(|formData|readJsonBody/
    );
    expect(authenticator).toContain("findLiveCustomerSession");
  });
});
