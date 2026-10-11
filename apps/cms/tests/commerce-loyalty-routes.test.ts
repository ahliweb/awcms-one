/**
 * Structural guards over the loyalty routes (Issue #289) — pure unit tests that
 * read the route sources. They pin the properties a reviewer would otherwise
 * have to re-derive by eye on every future edit:
 *
 *   - the customer-facing route takes the customer id ONLY from the verified
 *     bearer session (BOLA by construction: there is no input to vary);
 *   - every owner route is behind the loyalty feature gate and one of the four
 *     declared permissions, and the high-risk ones are `manage`;
 *   - the ledger has exactly one writer.
 *
 * (The behaviour behind them — owner scoping, the lock, idempotency — is proved
 * against a real database in
 * `tests/integration/commerce-loyalty.integration.test.ts`.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const ROOT = path.resolve(import.meta.dir, "..");
const LOYALTY_API = path.join(ROOT, "src/pages/api/v1/commerce/loyalty");
const STOREFRONT_ROUTE = path.join(
  ROOT,
  "src/pages/api/v1/commerce/storefront/account/loyalty/index.ts"
);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? routeFiles(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe("storefront account/loyalty route — owner scoping", () => {
  const source = read(STOREFRONT_ROUTE);

  test("authenticates with the customer bearer session and reads the customer id from it", () => {
    expect(source).toContain("requireCustomerSession");
    expect(source).toContain("authOutcome.account.customerId");
  });

  test("never accepts a customer, account or ledger identifier from the request", () => {
    for (const forbidden of [
      'searchParams.get("customerId")',
      'searchParams.get("accountId")',
      'searchParams.get("customer")',
      "params.customerId",
      "params.accountId",
      "request.json()",
      "readJsonBody"
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("is bearer-secured only: no Set-Cookie and no credentialed CORS (ADR-0016 D3)", () => {
    expect(source.toLowerCase()).not.toContain("set-cookie");
    expect(source.toLowerCase()).not.toContain(
      "access-control-allow-credentials"
    );
  });

  test("answers the neutral 404 when the tenant has not enabled loyalty", () => {
    expect(source).toContain("isLoyaltyEnabled");
    expect(source).toContain('kind: "not_found"');
  });
});

describe("owner loyalty routes", () => {
  const files = routeFiles(LOYALTY_API);

  test("there is a route for every documented operation", () => {
    const relative = files
      .map((f) => path.relative(LOYALTY_API, f).replaceAll("\\", "/"))
      .sort();
    expect(relative).toEqual([
      "accounts/[customerId]/adjust.ts",
      "accounts/[customerId]/index.ts",
      "accounts/[customerId]/ledger.ts",
      "accounts/[customerId]/redeem.ts",
      "accounts/index.ts",
      "programs/[id]/activate.ts",
      "programs/[id]/index.ts",
      "programs/[id]/retire.ts",
      "programs/index.ts",
      "reconcile.ts",
      "redemption-settings.ts",
      "summary.ts"
    ]);
  });

  test("every one is a defineTenantRoute with an explicit workClass, an authorize guard and the feature gate", () => {
    for (const file of files) {
      const source = read(file);
      expect(source).toContain("defineTenantRoute");
      expect(source).toContain('workClass: "interactive"');
      expect(source).toContain("authorize:");
      expect(source).toContain("requireCommerceFeatureForOwnerRoute");
      expect(source).toContain('"loyalty"');
    }
  });

  test("redeem and adjust require an Idempotency-Key and never accept one in the body", () => {
    for (const name of ["redeem.ts", "adjust.ts"]) {
      const source = read(
        path.join(LOYALTY_API, "accounts/[customerId]", name)
      );
      expect(source).toContain("validateIdempotencyKeyHeader");
      expect(source).toContain('request.headers.get("idempotency-key")');
      expect(source).not.toContain("body.idempotencyKey");
    }
  });

  test("redeem, adjust and the program/reconcile mutations use the three distinct permission shapes", () => {
    const redeem = read(
      path.join(LOYALTY_API, "accounts/[customerId]/redeem.ts")
    );
    const adjust = read(
      path.join(LOYALTY_API, "accounts/[customerId]/adjust.ts")
    );
    expect(redeem).toContain("COMMERCE_LOYALTY_REDEMPTIONS_ACTIVITY_CODE");
    expect(adjust).toContain("COMMERCE_LOYALTY_ADJUSTMENTS_ACTIVITY_CODE");
    for (const rel of [
      "programs/[id]/activate.ts",
      "programs/[id]/retire.ts",
      "reconcile.ts"
    ]) {
      const source = read(path.join(LOYALTY_API, rel));
      expect(source).toContain('action: "manage"');
    }
  });
});

describe("the ledger has exactly one writer", () => {
  const INSERT = /INSERT\s+INTO\s+awcms_commerce_loyalty_ledger/i;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|astro)$/.test(name) ? [full] : [];
    });
  }

  test("only application/loyalty-ledger.ts inserts into awcms_commerce_loyalty_ledger", () => {
    const offenders = walk(path.join(ROOT, "src"))
      .filter((file) => INSERT.test(read(file)))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"));
    expect(offenders).toEqual([
      "src/modules/commerce/application/loyalty-ledger.ts"
    ]);
  });

  test("and nothing in src ever UPDATEs or DELETEs a ledger row", () => {
    const mutate =
      /(UPDATE\s+awcms_commerce_loyalty_ledger|DELETE\s+FROM\s+awcms_commerce_loyalty_ledger)/i;
    const offenders = walk(path.join(ROOT, "src"))
      .filter((file) => mutate.test(read(file)))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });
});
