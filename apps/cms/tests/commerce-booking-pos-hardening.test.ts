/**
 * Hardening of the POS side of the booking adapter found by the security audit
 * of PR #443 (Issue #383), pinned without a database. The DB-backed evidence is
 * `tests/integration/commerce-booking-pos.integration.test.ts`.
 *
 *   - M1: a change of the check-in policy is audited (`from`, `to`, `warning`
 *     when it is turned OFF) and the route asks for a fresh step-up before it is
 *     turned off;
 *   - L1: the ledger guard of `sql/1046` binds the booking-balance exception to
 *     the named session's OWN open cashier and to a tenant user;
 *   - L2: the balance leg's ledger key names the actor;
 *   - L3: a throttled lookup is audited once per window;
 *   - I3: a till write refused as NOT_SESSION_CASHIER is audited as a warning.
 */
import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

import { auditCheckInPolicyChange } from "../src/modules/commerce/application/booking-adapter-settings";
import { POS_BOOKING_CHECK_IN_POLICY_AUDIT_ACTION } from "../src/modules/commerce/domain/booking-pos";

type AuditRow = {
  action: string;
  severity: string;
  attributes: Record<string, unknown>;
  resource_id: string;
  actor_tenant_user_id: string;
};

/** A tagged-template stand-in for the transaction that keeps the audit rows it was asked to insert. */
function fakeTx() {
  const rows: AuditRow[] = [];
  const tx = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
    for (const value of values) {
      if (Array.isArray(value)) rows.push(...(value as AuditRow[]));
    }
    return Promise.resolve([]);
  }) as unknown as Bun.SQL;
  return { tx, rows };
}

const TENANT = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";

describe("M1: the check-in policy change is audited", () => {
  test("turning it OFF is a warning with from/to and the step-up stamp", async () => {
    const { tx, rows } = fakeTx();
    const stepUpAt = new Date("2026-10-19T10:00:00.000Z");
    expect(
      await auditCheckInPolicyChange(tx, {
        tenantId: TENANT,
        actorTenantUserId: ACTOR,
        from: true,
        to: false,
        stepUpAt
      })
    ).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe(POS_BOOKING_CHECK_IN_POLICY_AUDIT_ACTION);
    expect(rows[0]!.action).toBe(
      "commerce.booking_pos.check_in_policy_changed"
    );
    expect(rows[0]!.severity).toBe("warning");
    expect(rows[0]!.actor_tenant_user_id).toBe(ACTOR);
    expect(rows[0]!.resource_id).toBe(TENANT);
    expect(rows[0]!.attributes).toEqual({
      from: true,
      to: false,
      stepUpAt: stepUpAt.toISOString()
    });
  });

  test("turning it back ON is info, and no change writes nothing", async () => {
    const on = fakeTx();
    expect(
      await auditCheckInPolicyChange(on.tx, {
        tenantId: TENANT,
        actorTenantUserId: ACTOR,
        from: false,
        to: true
      })
    ).toBe(true);
    expect(on.rows[0]!.severity).toBe("info");
    expect(on.rows[0]!.attributes).toEqual({ from: false, to: true });

    for (const value of [true, false]) {
      const same = fakeTx();
      expect(
        await auditCheckInPolicyChange(same.tx, {
          tenantId: TENANT,
          actorTenantUserId: ACTOR,
          from: value,
          to: value
        })
      ).toBe(false);
      expect(same.rows).toEqual([]);
    }
  });

  test("the route takes the policy under the row lock and asks for the platform step-up only when the control is loosened, before any write", () => {
    const source = readFileSync(
      "src/pages/api/v1/commerce/store-settings/index.ts",
      "utf8"
    );
    expect(source).toContain("lockCheckInRequiresSettlement");
    expect(source).toContain("requireStepUp(tx, tenantId, tokenHash, now)");
    expect(source).toMatch(/if \(from && !to\)/);
    expect(source).toContain("auditCheckInPolicyChange");
    // The step-up and the lock come before the first write of the request.
    expect(source.indexOf("requireStepUp(tx")).toBeLessThan(
      source.indexOf("await saveStoreSettings(")
    );
  });

  test("the settings screen sends the save through the step-up dialog", () => {
    const source = readFileSync(
      "src/pages/admin/commerce-settings.astro",
      "utf8"
    );
    expect(source).toContain("CommerceStepUpDialog");
    expect(source).toContain('id="store-settings-stepup"');
    expect(source).toContain("sendWithStepUp");
    expect(source).toContain('promptStepUpCode("store-settings-stepup")');
  });
});

describe("L1: the ledger guard binds the booking-balance exception to the session's own cashier", () => {
  const sql = readFileSync("sql/1046_awcms_commerce_booking_pos.sql", "utf8");
  const guard = sql.slice(
    sql.indexOf(
      "CREATE OR REPLACE FUNCTION awcms_commerce_payment_allocations_register_guard"
    )
  );

  test("tenant user, open session and current cashier are all required", () => {
    expect(guard).toContain("NEW.actor_kind = 'tenant_user'");
    expect(guard).toContain("s.status = 'open'");
    expect(guard).toContain(
      "s.current_cashier_tenant_user_id = NEW.actor_tenant_user_id"
    );
    expect(guard).toContain("s.id = NEW.register_session_id");
  });

  test("search_path stays pinned", () => {
    expect(guard).toContain("SET search_path = pg_catalog, public, pg_temp");
  });
});

describe("the application source", () => {
  const source = readFileSync(
    "src/modules/commerce/application/booking-pos.ts",
    "utf8"
  );

  test("L2: the balance leg's ledger key is derived from the actor and the session as well as the client key", () => {
    expect(source).toMatch(
      /computeRequestHash\(\{\s*key: input\.idempotencyKey,\s*actor: actorTenantUserId,\s*registerSessionId: session\.sessionId\s*\}\)/
    );
  });

  test("L3: a throttle is audited only when the one-attempt bucket of its window is free", () => {
    expect(source).toContain("throttle-audit:");
    expect(source).toMatch(/maxAttempts: 1,/);
    expect(source).toMatch(/if \(first\.allowed\) \{\s*await recordAuditEvent/);
  });

  test("I3: NOT_SESSION_CASHIER writes a warning audit row before the refusal is returned", () => {
    const at = source.indexOf('case "not_session_cashier":');
    const refusal = source.indexOf('refuse({ code: "NOT_SESSION_CASHIER" })');
    expect(at).toBeGreaterThan(0);
    const body = source.slice(at, refusal);
    expect(body).toContain("POS_BOOKING_NOT_SESSION_CASHIER_AUDIT_ACTION");
    expect(body).toContain('severity: "warning"');
  });
});
