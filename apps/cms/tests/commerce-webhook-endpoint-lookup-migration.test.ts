/**
 * Issue #110 — static-text contract tests for
 * `sql/926_awcms_commerce_payment_gateway_schema.sql`'s
 * `awcms_resolve_commerce_webhook_endpoint` SECURITY DEFINER bootstrap
 * function, mirroring `db-role-separation-migration.test.ts`'s own shape:
 * this locks down the ways the migration can silently rot or be regressed
 * by an edit that "looks fine" — role creation before use, no superuser/
 * BYPASSRLS creep, EXECUTE locked to `awcms_app`, and a fixed, non-sensitive
 * return column list that never includes `token_hash`. The BEHAVIOURAL
 * properties (the function actually resolves a live token and refuses a
 * revoked one) are integration-tested against a real Postgres instead — see
 * `tests/integration/commerce-payment-gateway.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const MIGRATION_PATH = "sql/926_awcms_commerce_payment_gateway_schema.sql";
const migrationSql = readRepoFile(MIGRATION_PATH);

function statementsOnly(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const statements = statementsOnly(migrationSql);

describe("sql/926 — awcms_resolve_commerce_webhook_endpoint bootstrap function", () => {
  test("creates the bootstrap-owner role idempotently, NOLOGIN and non-superuser/non-BYPASSRLS", () => {
    expect(statements).toMatch(
      /CREATE ROLE awcms_webhook_endpoint_bootstrap NOLOGIN NOSUPERUSER NOBYPASSRLS/
    );
    expect(statements).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'awcms_webhook_endpoint_bootstrap'\)/
    );
  });

  test("creates the bootstrap role BEFORE granting to it or creating its policy", () => {
    const createIndex = statements.indexOf(
      "CREATE ROLE awcms_webhook_endpoint_bootstrap"
    );
    const grantIndex = statements.indexOf(
      "GRANT SELECT ON awcms_commerce_webhook_endpoints TO awcms_webhook_endpoint_bootstrap"
    );
    const policyIndex = statements.indexOf(
      "CREATE POLICY awcms_commerce_webhook_endpoints_bootstrap_read"
    );

    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(grantIndex).toBeGreaterThan(createIndex);
    expect(policyIndex).toBeGreaterThan(createIndex);
  });

  test("the bootstrap read policy is scoped to the bootstrap role only, not to awcms_app or PUBLIC", () => {
    const policyMatch =
      /CREATE POLICY awcms_commerce_webhook_endpoints_bootstrap_read[\s\S]*?USING \(true\);/.exec(
        statements
      );
    expect(policyMatch).not.toBeNull();
    expect(policyMatch![0]).toMatch(/TO awcms_webhook_endpoint_bootstrap/);
    expect(policyMatch![0]).not.toMatch(/TO awcms_app/);
    expect(policyMatch![0]).not.toMatch(/TO PUBLIC/);
  });

  test("FORCE ROW LEVEL SECURITY stays on for the underlying table", () => {
    expect(statements).toMatch(
      /ALTER TABLE awcms_commerce_webhook_endpoints FORCE ROW LEVEL SECURITY/
    );
  });

  test("the function is SECURITY DEFINER, STABLE, and pins search_path", () => {
    const fnMatch =
      /CREATE OR REPLACE FUNCTION awcms_resolve_commerce_webhook_endpoint[\s\S]*?\$function\$;/.exec(
        statements
      );
    expect(fnMatch).not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/STABLE/);
    expect(body).toMatch(/SET search_path = public, pg_temp/);
  });

  test("the function returns only tenant_id and provider — never token_hash, label, or created_by", () => {
    const fnMatch =
      /CREATE OR REPLACE FUNCTION awcms_resolve_commerce_webhook_endpoint[\s\S]*?\$function\$;/.exec(
        statements
      );
    const body = fnMatch![0];
    expect(body).toMatch(
      /RETURNS TABLE \(\s*tenant_id uuid,\s*provider text\s*\)/
    );

    // `token_hash` legitimately appears in the WHERE clause (matching the
    // parameter) — the property under test is that it is never SELECTed
    // back out, i.e. never appears as a returned column.
    const selectMatch = /SELECT\s+([\s\S]*?)\s+FROM/.exec(body);
    const selectedColumns = selectMatch![1]!;
    expect(selectedColumns).not.toMatch(/token_hash/);
    expect(selectedColumns).not.toMatch(/\blabel\b/);
    expect(selectedColumns).not.toMatch(/created_by/);
  });

  test("the function only resolves a NON-revoked token", () => {
    const fnMatch =
      /CREATE OR REPLACE FUNCTION awcms_resolve_commerce_webhook_endpoint[\s\S]*?\$function\$;/.exec(
        statements
      );
    expect(fnMatch![0]).toMatch(/revoked_at IS NULL/);
  });

  test("EXECUTE is revoked from PUBLIC before being granted to awcms_app", () => {
    const revokeIndex = statements.indexOf(
      "REVOKE ALL ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) FROM PUBLIC"
    );
    const grantExecuteIndex = statements.indexOf(
      "GRANT EXECUTE ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) TO awcms_app"
    );

    expect(revokeIndex).toBeGreaterThanOrEqual(0);
    expect(grantExecuteIndex).toBeGreaterThan(revokeIndex);
  });

  test("ownership is reassigned to the bootstrap role AFTER the EXECUTE grants are locked down", () => {
    const grantExecuteIndex = statements.indexOf(
      "GRANT EXECUTE ON FUNCTION awcms_resolve_commerce_webhook_endpoint(text) TO awcms_app"
    );
    const ownerIndex = statements.indexOf(
      "ALTER FUNCTION awcms_resolve_commerce_webhook_endpoint(text) OWNER TO awcms_webhook_endpoint_bootstrap"
    );

    expect(ownerIndex).toBeGreaterThan(grantExecuteIndex);
  });

  test("never grants the bootstrap role's membership to anyone (it must stay memberless)", () => {
    expect(statements).not.toMatch(/GRANT awcms_webhook_endpoint_bootstrap TO/);
  });
});

describe("sql/926 — payment-gateway-sessions/-events/webhook-endpoints RLS", () => {
  for (const table of [
    "awcms_commerce_payment_gateway_sessions",
    "awcms_commerce_payment_events",
    "awcms_commerce_webhook_endpoints"
  ]) {
    test(`${table} has FORCE ROW LEVEL SECURITY and a tenant-isolation policy`, () => {
      expect(statements).toMatch(
        new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      );
      expect(statements).toMatch(
        new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      );
      expect(statements).toMatch(
        new RegExp(`CREATE POLICY ${table}_tenant_isolation`)
      );
    });
  }

  test("payment_gateway_sessions has a UNIQUE (provider, provider_ref) index", () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_payment_gateway_sessions_provider_ref_key\s*\n\s*ON awcms_commerce_payment_gateway_sessions \(provider, provider_ref\)/
    );
  });

  test("payment_events has a UNIQUE (tenant_id, provider, event_key) index", () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_payment_events_tenant_provider_event_key\s*\n\s*ON awcms_commerce_payment_events \(tenant_id, provider, event_key\)/
    );
  });

  test("webhook_endpoints has a UNIQUE token_hash index and never stores the plaintext token", () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS awcms_commerce_webhook_endpoints_token_hash_key/
    );
    expect(statements).not.toMatch(/\btoken text\b/);
  });

  test("orders gains gateway_provider/gateway_ref additively (ADD COLUMN IF NOT EXISTS)", () => {
    expect(statements).toMatch(
      /ALTER TABLE awcms_commerce_orders ADD COLUMN IF NOT EXISTS gateway_provider text/
    );
    expect(statements).toMatch(
      /ALTER TABLE awcms_commerce_orders ADD COLUMN IF NOT EXISTS gateway_ref text/
    );
  });
});
