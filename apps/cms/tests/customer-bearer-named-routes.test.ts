/**
 * Pins, by name, the three storefront account POSTs the customer-bearer
 * regression of the `f0182930`/`f476fdbb` syncs broke, next to the property that
 * must not move with them: a body POST that needs a STAFF session still gets the
 * staff check, and a customer token does not open it.
 *
 * Without a database: it proves which check the middleware's boundary selects,
 * not the session lookup itself (`commerce-customer-auth.integration.test.ts`,
 * DATABASE_URL-gated). The general registry-versus-contract guard is
 * `customer-bearer-body-boundary.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  isCustomerBearerBodyEndpoint,
  isSessionFreeBodyEndpoint,
  requiresAuthenticatedCallerBeforeBody
} from "../src/lib/security/api-body-auth-boundary";

const BASE = "/api/v1/commerce/storefront/account";

describe("customer-bearer body POSTs and the staff boundary", () => {
  for (const url of [
    `${BASE}/logout`,
    `${BASE}/addresses`,
    `${BASE}/push/subscriptions`
  ]) {
    test(`POST ${url} is authenticated by the customer check, not the staff check`, () => {
      expect(requiresAuthenticatedCallerBeforeBody("POST", url)).toBe(true);
      expect(isCustomerBearerBodyEndpoint("POST", url)).toBe(true);
      expect(isSessionFreeBodyEndpoint("POST", url)).toBe(false);
    });
  }

  test("a body POST that needs a staff session is still refused without one and never takes the customer check", () => {
    for (const url of [
      "/api/v1/commerce/products",
      "/api/v1/commerce/orders/abc/status",
      "/api/v1/identity-access/users"
    ]) {
      expect(requiresAuthenticatedCallerBeforeBody("POST", url)).toBe(true);
      expect(isCustomerBearerBodyEndpoint("POST", url)).toBe(false);
      expect(isSessionFreeBodyEndpoint("POST", url)).toBe(false);
    }
  });

  test("a GET never reaches either body check", () => {
    expect(
      requiresAuthenticatedCallerBeforeBody("GET", `${BASE}/addresses`)
    ).toBe(false);
  });
});
