/**
 * Employee-commission sale attribution - pure domain, descriptor and structural
 * tests (Issue #391, ADR-0046). The database-backed behaviour (exactly-once
 * replay, the beneficiary derivation, tenant isolation, RLS, the worker role) is
 * `tests/integration/commerce-commission-attribution.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { CommissionAccrualOutcome } from "../src/modules/_shared/ports/commission-accrual-port";
import { commerceModule } from "../src/modules/commerce/module";
import {
  COMMERCE_COMMISSION_SETTINGS_PERMISSIONS,
  COMMERCE_COMMISSION_STAFF_LINK_PERMISSIONS
} from "../src/modules/commerce/domain/commerce-permissions";
import {
  allocateLineBases,
  classifyAccrualOutcome,
  COMMISSION_DEFAULT_SOURCE_TYPE,
  commissionOccurredOn,
  commissionSourceIdentity,
  decideAttributableLogin,
  decideBeneficiary,
  decideSettingsChange,
  emptyTally,
  isOrderWideRefusal,
  tallyOutcome,
  validateCommissionSettingsInput,
  validateCreateStaffLinkInput
} from "../src/modules/commerce/domain/commission-attribution";
import { COMMISSION_DATA_LIFECYCLE } from "../src/modules/commerce/domain/commission-lifecycle";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const POS_ORDER = {
  status: "paid",
  paymentStatus: "paid",
  channel: "pos",
  posCashierTenantUserId: UUID_A
};

describe("decideBeneficiary - who earns is derived, never supplied", () => {
  test("a paid counter sale rung up by a linked login is attributed to the linked employment", () => {
    expect(decideBeneficiary(POS_ORDER, UUID_B)).toEqual({
      kind: "attribute",
      employmentId: UUID_B
    });
  });

  test("a storefront order is never attributed, even if it somehow carried a cashier stamp", () => {
    expect(
      decideBeneficiary({ ...POS_ORDER, channel: "storefront" }, UUID_B)
    ).toEqual({ kind: "skip", reason: "not_a_counter_sale" });
    expect(
      decideBeneficiary(
        {
          status: "paid",
          paymentStatus: "paid",
          channel: "storefront",
          posCashierTenantUserId: null
        },
        UUID_B
      )
    ).toEqual({ kind: "skip", reason: "not_a_counter_sale" });
  });

  test("a counter sale with no cashier stamp has no fallback beneficiary", () => {
    expect(
      decideBeneficiary({ ...POS_ORDER, posCashierTenantUserId: null }, UUID_B)
    ).toEqual({ kind: "skip", reason: "no_cashier_stamp" });
  });

  test("a login with no LIVE staff link is not attributed", () => {
    expect(decideBeneficiary(POS_ORDER, null)).toEqual({
      kind: "skip",
      reason: "no_staff_link"
    });
  });

  test("only orders past payment and not cancelled are commissionable", () => {
    for (const status of ["paid", "processing", "shipped", "completed"]) {
      expect(decideAttributableLogin({ ...POS_ORDER, status }).kind).toBe(
        "attribute"
      );
    }
    for (const status of ["pending_payment", "cancelled", "expired"]) {
      expect(decideAttributableLogin({ ...POS_ORDER, status })).toEqual({
        kind: "skip",
        reason: "order_not_commissionable"
      });
    }
  });

  test("an order not settled in full (deposit only, refunded) is not commissionable even when its status is past payment", () => {
    for (const paymentStatus of ["unpaid", "dp_paid", "refunded"]) {
      expect(decideAttributableLogin({ ...POS_ORDER, paymentStatus })).toEqual({
        kind: "skip",
        reason: "order_not_commissionable"
      });
    }
  });

  test("the status check comes before the channel check (a cancelled counter sale reports the status)", () => {
    expect(
      decideAttributableLogin({
        status: "cancelled",
        paymentStatus: "paid",
        channel: "storefront",
        posCashierTenantUserId: null
      })
    ).toEqual({ kind: "skip", reason: "order_not_commissionable" });
  });
});

describe("commissionSourceIdentity - the ledger's exactly-once key", () => {
  test("is (source type, order id, order-line id), lower-cased, in the port's alphabet", () => {
    const identity = commissionSourceIdentity(
      COMMISSION_DEFAULT_SOURCE_TYPE,
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"
    );
    expect(identity).toEqual({
      type: "commerce_order_line",
      ref: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      line: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    });
    expect(identity.ref).toMatch(/^[A-Za-z0-9_.:-]{1,200}$/);
    expect(identity.line).toMatch(/^[A-Za-z0-9_.:-]{0,64}$/);
  });

  test("is stable: the same inputs always give the same identity, different lines differ", () => {
    const a = commissionSourceIdentity("t", UUID_A, UUID_B);
    expect(commissionSourceIdentity("t", UUID_A, UUID_B)).toEqual(a);
    expect(commissionSourceIdentity("t", UUID_A, UUID_A)).not.toEqual(a);
  });
});

describe("allocateLineBases - what the customer actually paid for each line", () => {
  test("with no discount the base is the line total", () => {
    expect(
      allocateLineBases(
        [
          { id: "a", lineTotal: "10000.00" },
          { id: "b", lineTotal: "2500.50" }
        ],
        "0.00"
      )
    ).toEqual([
      { id: "a", baseAmount: "10000.00" },
      { id: "b", baseAmount: "2500.50" }
    ]);
  });

  test("order discount is shared pro rata and the shares add up to the discount exactly", () => {
    const lines = [
      { id: "a", lineTotal: "100.00" },
      { id: "b", lineTotal: "100.00" },
      { id: "c", lineTotal: "100.00" }
    ];
    // 1.00 over three equal lines = 33.33... cents each: 34 + 33 + 33 cents.
    const bases = allocateLineBases(lines, "1.00");
    const cents = bases.map((line) => BigInt(line.baseAmount.replace(".", "")));
    expect(cents.reduce((sum, value) => sum + value, 0n)).toBe(29_900n);
    expect(bases.map((line) => line.baseAmount)).toEqual([
      "99.66",
      "99.67",
      "99.67"
    ]);
  });

  test("is deterministic: the same order always yields the same bases (a redelivery must reproduce the request)", () => {
    const lines = [
      { id: "a", lineTotal: "33.33" },
      { id: "b", lineTotal: "66.67" },
      { id: "c", lineTotal: "1.00" }
    ];
    expect(allocateLineBases(lines, "7.77")).toEqual(
      allocateLineBases(lines, "7.77")
    );
  });

  test("a discount larger than the goods clamps to zero, never negative", () => {
    expect(
      allocateLineBases([{ id: "a", lineTotal: "50.00" }], "999.00")
    ).toEqual([{ id: "a", baseAmount: "0.00" }]);
  });

  test("a negative discount allocates nothing", () => {
    expect(
      allocateLineBases([{ id: "a", lineTotal: "50.00" }], "-5.00")
    ).toEqual([{ id: "a", baseAmount: "50.00" }]);
  });

  test("no lines is no bases", () => {
    expect(allocateLineBases([], "10.00")).toEqual([]);
  });
});

describe("commissionOccurredOn - the sale's civil date in the TENANT's time", () => {
  // 2026-10-13T20:00:00Z is 14 October 03:00 in Jakarta (+07:00) and 13 October in UTC.
  const instant = new Date("2026-10-13T20:00:00Z");

  test("uses the tenant's zone, not the server's or UTC", () => {
    expect(commissionOccurredOn(instant, "Asia/Jakarta")).toBe("2026-10-14");
    expect(commissionOccurredOn(instant, "UTC")).toBe("2026-10-13");
    expect(commissionOccurredOn(instant, "America/Los_Angeles")).toBe(
      "2026-10-13"
    );
  });

  test("a far-east zone is within one day of the UTC date, as the port requires", () => {
    const date = commissionOccurredOn(instant, "Pacific/Kiritimati");
    expect(date).toBe("2026-10-14");
  });

  test("an unusable zone falls back to commerce's reporting zone instead of failing the delivery", () => {
    expect(commissionOccurredOn(instant, "Not/AZone")).toBe("2026-10-14");
  });
});

describe("classifying what the ledger answered", () => {
  const accrual = {
    id: UUID_A,
    employmentId: UUID_B,
    ruleKey: "k",
    ruleVersion: 1,
    status: "pending",
    amount: "1.00",
    currencyCode: "IDR"
  } as const;
  const outcomes: Record<string, CommissionAccrualOutcome> = {
    accrued: { outcome: "accrued", accrual },
    replayed: { outcome: "replayed", accrual },
    conflict: { outcome: "source_conflict", accrualId: UUID_A },
    invalid: { outcome: "input_invalid", message: "x" },
    no_effective_rule: { outcome: "no_effective_rule" },
    rule_ambiguous: { outcome: "rule_ambiguous" },
    source_type_mismatch: {
      outcome: "source_type_mismatch",
      expectedSourceType: "x"
    },
    currency_mismatch: {
      outcome: "currency_mismatch",
      expectedCurrencyCode: "USD"
    },
    employment_not_found: { outcome: "employment_not_found" },
    employment_not_eligible: { outcome: "employment_not_eligible" }
  };

  test("every port outcome has a class; refusals are returned outcomes, never exceptions", () => {
    expect(classifyAccrualOutcome(outcomes.accrued!)).toBe("accrued");
    expect(classifyAccrualOutcome(outcomes.replayed!)).toBe("replayed");
    expect(classifyAccrualOutcome(outcomes.conflict!)).toBe("conflict");
    expect(classifyAccrualOutcome(outcomes.invalid!)).toBe("invalid");
    for (const key of [
      "no_effective_rule",
      "rule_ambiguous",
      "source_type_mismatch",
      "currency_mismatch",
      "employment_not_found",
      "employment_not_eligible"
    ]) {
      expect(classifyAccrualOutcome(outcomes[key]!)).toBe("refused");
    }
  });

  test("order-wide refusals stop the loop; a per-line conflict or invalid request does not", () => {
    for (const key of [
      "no_effective_rule",
      "rule_ambiguous",
      "source_type_mismatch",
      "currency_mismatch",
      "employment_not_found",
      "employment_not_eligible"
    ]) {
      expect(isOrderWideRefusal(outcomes[key]!)).toBe(true);
    }
    for (const key of ["accrued", "replayed", "conflict", "invalid"]) {
      expect(isOrderWideRefusal(outcomes[key]!)).toBe(false);
    }
  });

  test("the tally counts by class and by refusal code, and carries no amount", () => {
    const tally = emptyTally();
    for (const key of [
      "accrued",
      "accrued",
      "replayed",
      "conflict",
      "invalid",
      "no_effective_rule",
      "no_effective_rule",
      "employment_not_eligible"
    ]) {
      tallyOutcome(tally, outcomes[key]!);
    }
    expect(tally).toEqual({
      accrued: 2,
      replayed: 1,
      conflicts: 1,
      invalid: 1,
      refused: { no_effective_rule: 2, employment_not_eligible: 1 }
    });
    expect(JSON.stringify(tally)).not.toContain("1.00");
  });
});

describe("decideSettingsChange - the source identity is frozen once an attribution exists (#413 review)", () => {
  const stored = { ruleKey: "pos_sales", sourceType: "commerce_order_line" };

  test("with no attribution recorded, anything may change", () => {
    expect(
      decideSettingsChange({
        stored,
        requested: { ruleKey: "other", sourceType: "other_type" },
        attributionsExist: false
      })
    ).toEqual({ kind: "allowed" });
  });

  test("with an attribution, re-saving the same values is accepted", () => {
    expect(
      decideSettingsChange({
        stored,
        requested: { ...stored },
        attributionsExist: true
      })
    ).toEqual({ kind: "allowed" });
  });

  test("with an attribution, a changed source type, rule key or both is refused and names the fields", () => {
    expect(
      decideSettingsChange({
        stored,
        requested: { ...stored, sourceType: "other_type" },
        attributionsExist: true
      })
    ).toEqual({ kind: "source_locked", fields: ["sourceType"] });
    expect(
      decideSettingsChange({
        stored,
        requested: { ...stored, ruleKey: "other" },
        attributionsExist: true
      })
    ).toEqual({ kind: "source_locked", fields: ["ruleKey"] });
    expect(
      decideSettingsChange({
        stored,
        requested: { ruleKey: null, sourceType: "x" },
        attributionsExist: true
      })
    ).toEqual({ kind: "source_locked", fields: ["sourceType", "ruleKey"] });
  });
});

describe("request validation", () => {
  test("settings: enabled is required, the adapter cannot be switched on without a rule key, unknown fields are refused", () => {
    expect(validateCommissionSettingsInput({ enabled: false })).toEqual({
      valid: true,
      value: {
        enabled: false,
        ruleKey: null,
        sourceType: "commerce_order_line"
      }
    });
    expect(
      validateCommissionSettingsInput({ enabled: true, ruleKey: "pos-sales" })
    ).toEqual({
      valid: true,
      value: {
        enabled: true,
        ruleKey: "pos-sales",
        sourceType: "commerce_order_line"
      }
    });
    for (const body of [
      {},
      { enabled: "yes" },
      { enabled: true },
      { enabled: true, ruleKey: "Bad Key" },
      { enabled: false, ruleKey: 5 },
      { enabled: false, sourceType: "Has Caps" },
      { enabled: false, extra: 1 },
      null,
      [],
      "x"
    ]) {
      expect(validateCommissionSettingsInput(body).valid).toBe(false);
    }
  });

  test("staff link: two UUIDs only; no field can name the commission amount, rate or an employee by anything else", () => {
    expect(
      validateCreateStaffLinkInput({
        tenantUserId: UUID_A.toUpperCase(),
        employmentId: UUID_B
      })
    ).toEqual({
      valid: true,
      value: { tenantUserId: UUID_A, employmentId: UUID_B }
    });
    for (const body of [
      {},
      { tenantUserId: UUID_A },
      { tenantUserId: "x", employmentId: UUID_B },
      { tenantUserId: UUID_A, employmentId: UUID_B, amount: "1.00" },
      { tenantUserId: UUID_A, employmentId: UUID_B, name: "Someone" },
      null
    ]) {
      expect(validateCreateStaffLinkInput(body).valid).toBe(false);
    }
  });
});

describe("the module descriptor", () => {
  test("declares the attributor as a descriptor consumer of the order-paid event with the DEFAULT runtime_effect_once idempotency", () => {
    const consumer = commerceModule.domainEventConsumers?.find(
      (entry) => entry.name === "commerce.order_paid_commission_attributor"
    );
    expect(consumer).toBeDefined();
    expect(consumer!.eventTypes).toEqual(["awcms.commerce.order.paid"]);
    expect(consumer!.idempotency ?? "runtime_effect_once").toBe(
      "runtime_effect_once"
    );
    expect(consumer!.idempotencyRationale).toBeUndefined();
  });

  test("consumes hr_commission as an OPTIONAL capability, not a lifecycle dependency", () => {
    expect(commerceModule.dependencies).not.toContain("hr_commission");
    expect(commerceModule.dependencies).not.toContain("hr_workforce");
    expect(commerceModule.capabilities?.consumes).toEqual([
      {
        capability: "commission_accrual",
        providedBy: "hr_commission",
        optional: true
      }
    ]);
  });

  test("declares the four permissions, all enforced, none implying a commission amount", () => {
    const declared = new Set(
      (commerceModule.permissions ?? []).map(
        (permission) =>
          `commerce.${permission.activityCode}.${permission.action}`
      )
    );
    for (const key of [
      ...Object.values(COMMERCE_COMMISSION_SETTINGS_PERMISSIONS),
      ...Object.values(COMMERCE_COMMISSION_STAFF_LINK_PERMISSIONS)
    ]) {
      expect(declared.has(key)).toBe(true);
    }
    expect(COMMERCE_COMMISSION_SETTINGS_PERMISSIONS.manage).toBe(
      "commerce.commission_settings.manage"
    );
  });

  test("both tables answer the retention question on the record, with no purge", () => {
    expect(COMMISSION_DATA_LIFECYCLE.map((entry) => entry.tableName)).toEqual([
      "awcms_commerce_commission_settings",
      "awcms_commerce_commission_staff_links",
      "awcms_commerce_commission_attributed_sources"
    ]);
    for (const entry of COMMISSION_DATA_LIFECYCLE) {
      expect(entry.executionMode).toBe("delegated");
    }
  });
});

describe("migrations 1030 and 1031", () => {
  const read = (name: string) =>
    readFileSync(path.join(import.meta.dir, "..", "sql", name), "utf8");
  const schema = read("1030_awcms_commerce_commission_attribution_schema.sql");
  const grants = read(
    "1031_awcms_commerce_commission_attribution_permissions_grants.sql"
  );

  test("both tables are tenant-isolated with RLS ENABLED and FORCED", () => {
    for (const table of [
      "awcms_commerce_commission_settings",
      "awcms_commerce_commission_staff_links"
    ]) {
      expect(schema).toContain(
        `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`
      );
      expect(schema).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      expect(schema).toContain(`${table}_tenant_isolation`);
    }
  });

  test("the employment id is opaque: no foreign key into any hr_ table, and no column that holds an amount or a rate", () => {
    expect(schema).not.toMatch(/REFERENCES\s+awcms_hr_/i);
    expect(schema).not.toMatch(
      /\b(amount|rate|base_amount|commission)\s+numeric/i
    );
  });

  test("the adapter is OFF by default and cannot be on without a rule key", () => {
    expect(schema).toContain("enabled boolean NOT NULL DEFAULT false");
    expect(schema).toContain("CHECK (NOT enabled OR rule_key IS NOT NULL)");
  });

  test("a login and an employment each have at most one LIVE link; a link is never deleted", () => {
    expect(schema).toContain(
      "(tenant_id, tenant_user_id)\n  WHERE retired_at IS NULL"
    );
    expect(schema).toContain(
      "(tenant_id, employment_id)\n  WHERE retired_at IS NULL"
    );
    expect(schema).toContain(
      "REVOKE DELETE, TRUNCATE ON awcms_commerce_commission_staff_links FROM awcms_app"
    );
    expect(schema).toContain("TG_OP = 'DELETE'");
  });

  test("the worker is never granted UPDATE or DELETE on an accrual, a rule or an employment beyond the single-column row-lock grant", () => {
    const statements = grants
      .split("\n")
      .filter((line) => /^GRANT /.test(line));
    for (const line of statements) {
      if (
        /awcms_hr_commission_accruals|awcms_hr_commission_transitions/.test(
          line
        )
      ) {
        expect(line).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE)\b/);
      }
      if (/awcms_hr_commission_rules|awcms_hr_employments/.test(line)) {
        expect(line).not.toMatch(/\b(INSERT|DELETE|TRUNCATE)\b/);
        if (/UPDATE/.test(line)) expect(line).toMatch(/UPDATE \(id\)/);
      }
    }
  });
});

describe("migration 1052 - the attributed-source marker", () => {
  const sql = readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "sql",
      "1052_awcms_commerce_commission_attributed_sources.sql"
    ),
    "utf8"
  );

  test("tenant-isolated, FORCE RLS, unique per pair, insert-only for the worker, immutable for everyone", () => {
    const table = "awcms_commerce_commission_attributed_sources";
    expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    expect(sql).toContain(`${table}_tenant_isolation`);
    expect(sql).toContain("UNIQUE (tenant_id, source_type, rule_key)");
    expect(sql).toContain(`GRANT SELECT, INSERT ON ${table} TO awcms_worker`);
    expect(sql).not.toMatch(/GRANT[^;]*(UPDATE|DELETE)[^;]*awcms_worker/);
    expect(sql).toContain("BEFORE UPDATE OR DELETE");
  });
});
