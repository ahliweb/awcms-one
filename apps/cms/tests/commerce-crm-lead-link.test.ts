/**
 * The CRM lead link - pure domain, directory refusals (over a fake transaction
 * and a fake `CrmLeadPort`), descriptor and migration-text tests (Issue #463,
 * ADR-0056). The database-backed behaviour (the double authorization, replay,
 * source attribution, correction, tenant isolation, RLS, the worker role) is
 * `tests/integration/commerce-crm-lead-link.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  CrmLeadConversionOutcome,
  CrmLeadPort,
  CrmLeadState
} from "../src/modules/_shared/ports/crm-lead-port";
import {
  linkLeadToCustomer,
  reverseCrmLeadLink
} from "../src/modules/commerce/application/crm-lead-link-directory";
import {
  CRM_LEAD_LINK_REVERSAL_CAUSES,
  CRM_LEAD_LINK_STATES,
  customerRef,
  evidenceRefFor,
  isLegalLinkTransition,
  orderEvidenceIsReverted,
  orderEvidenceRef,
  registrationEvidenceRef,
  reversalEvidenceRef,
  validateCreateCrmLeadLinkInput,
  verifyPaidOrderEvidence,
  verifyRegistrationEvidence
} from "../src/modules/commerce/domain/crm-lead-link";
import { COMMERCE_CRM_LEAD_LINK_PERMISSIONS } from "../src/modules/commerce/domain/commerce-permissions";
import {
  CRM_LEAD_LINK_DATA_LIFECYCLE,
  CRM_LEAD_LINK_SUBJECT_DATA
} from "../src/modules/commerce/domain/crm-lead-link-lifecycle";
import { SUBJECT_TABLES } from "../src/modules/commerce/domain/customer-subject-data";
import {
  COMMERCE_CUSTOMER_CONVERTED_EVENT_TYPE,
  COMMERCE_CUSTOMER_REGISTERED_EVENT_TYPE
} from "../src/modules/commerce/domain/commerce-events";
import {
  CRM_LEAD_LINK_CONSUMERS,
  commerceModule
} from "../src/modules/commerce/module";
import { isRegisteredDomainEventType } from "../src/modules/domain-event-runtime/domain/event-type-registry";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";
const REF_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const read = (relative: string) =>
  readFileSync(path.join(import.meta.dir, "..", relative), "utf8");

describe("opaque references", () => {
  test("every reference sent to CrmLeadPort is inside its alphabet and carries no contact value", () => {
    for (const ref of [
      customerRef(UUID_A),
      registrationEvidenceRef(UUID_A),
      orderEvidenceRef(UUID_B),
      reversalEvidenceRef(UUID_C)
    ]) {
      expect(ref).toMatch(REF_PATTERN);
      expect(ref).not.toMatch(/@/);
    }
  });

  test("references are case-folded, distinct per kind and deterministic (they are replay keys)", () => {
    expect(registrationEvidenceRef(UUID_A.toUpperCase())).toBe(
      registrationEvidenceRef(UUID_A)
    );
    expect(
      new Set([
        registrationEvidenceRef(UUID_A),
        orderEvidenceRef(UUID_A),
        reversalEvidenceRef(UUID_A),
        customerRef(UUID_A)
      ]).size
    ).toBe(4);
    expect(evidenceRefFor("customer_registration", UUID_A, null)).toBe(
      registrationEvidenceRef(UUID_A)
    );
    expect(evidenceRefFor("paid_order", UUID_A, UUID_B)).toBe(
      orderEvidenceRef(UUID_B)
    );
    expect(evidenceRefFor("paid_order", UUID_A, null)).toBeNull();
  });
});

describe("verified evidence", () => {
  const order = {
    customerId: UUID_A,
    status: "paid",
    paymentStatus: "paid",
    deleted: false
  };

  test("a paid, active order of THAT customer verifies, whatever its post-payment stage", () => {
    for (const status of ["paid", "processing", "shipped", "completed"]) {
      expect(verifyPaidOrderEvidence({ ...order, status }, UUID_A)).toEqual({
        verified: true
      });
    }
  });

  test("another customer's order, an unpaid, a deposit-only, a refunded, a cancelled and a deleted order do not", () => {
    const reason = (facts: Partial<typeof order>, customer = UUID_A) => {
      const verdict = verifyPaidOrderEvidence({ ...order, ...facts }, customer);
      return verdict.verified ? "verified" : verdict.reason;
    };
    expect(reason({}, UUID_B)).toBe("order_not_of_customer");
    expect(reason({ paymentStatus: "unpaid" })).toBe("order_not_paid");
    expect(reason({ paymentStatus: "dp_paid" })).toBe("order_not_paid");
    expect(reason({ paymentStatus: "refunded" })).toBe("order_not_paid");
    expect(reason({ status: "cancelled" })).toBe("order_not_active");
    expect(reason({ status: "pending_payment" })).toBe("order_not_active");
    expect(reason({ status: "expired" })).toBe("order_not_active");
    expect(reason({ deleted: true })).toBe("order_deleted");
  });

  test("a registration is a live account with a verified e-mail; a guest row, an unverified, blocked or erased one is not", () => {
    const account = {
      status: "active",
      emailVerified: true,
      deleted: false,
      customerErased: false
    };
    const reason = (facts: Partial<typeof account> | null) => {
      const verdict = verifyRegistrationEvidence(
        facts === null ? null : { ...account, ...facts }
      );
      return verdict.verified ? "verified" : verdict.reason;
    };
    expect(reason({})).toBe("verified");
    expect(reason(null)).toBe("no_account");
    expect(reason({ emailVerified: false })).toBe("email_not_verified");
    expect(reason({ status: "blocked" })).toBe("account_not_active");
    expect(reason({ customerErased: true })).toBe("customer_erased");
    expect(reason({ deleted: true })).toBe("customer_erased");
  });

  test("an order is reverted when cancelled or expired, or when EVERY line is fully returned; a partial return is not", () => {
    expect(orderEvidenceIsReverted({ status: "cancelled", lines: [] })).toEqual(
      {
        reverted: true,
        cause: "order_cancelled"
      }
    );
    expect(
      orderEvidenceIsReverted({ status: "expired", lines: [] }).cause
    ).toBe("order_cancelled");
    expect(
      orderEvidenceIsReverted({
        status: "completed",
        lines: [
          { ordered: 2, returned: 2 },
          { ordered: 1, returned: 1 }
        ]
      })
    ).toEqual({ reverted: true, cause: "order_refunded" });
    expect(
      orderEvidenceIsReverted({
        status: "completed",
        lines: [
          { ordered: 2, returned: 2 },
          { ordered: 1, returned: 0 }
        ]
      }).reverted
    ).toBe(false);
    expect(
      orderEvidenceIsReverted({ status: "completed", lines: [] }).reverted
    ).toBe(false);
    expect(
      orderEvidenceIsReverted({
        status: "completed",
        lines: [{ ordered: 3, returned: 2 }]
      }).reverted
    ).toBe(false);
  });
});

describe("the state machine", () => {
  test("linked -> reversal_pending -> reversed, or linked -> reversed; reversed is final; nothing goes back", () => {
    expect(isLegalLinkTransition("linked", "reversal_pending")).toBe(true);
    expect(isLegalLinkTransition("linked", "reversed")).toBe(true);
    expect(isLegalLinkTransition("reversal_pending", "reversed")).toBe(true);
    for (const to of CRM_LEAD_LINK_STATES) {
      expect(isLegalLinkTransition("reversed", to)).toBe(false);
    }
    expect(isLegalLinkTransition("reversal_pending", "linked")).toBe(false);
    expect(isLegalLinkTransition("linked", "linked")).toBe(false);
  });

  test("the migration's guard trigger and CHECKs state the same machine", () => {
    const sql = read("sql/1068_awcms_commerce_crm_lead_links.sql");
    for (const state of CRM_LEAD_LINK_STATES)
      expect(sql).toContain(`'${state}'`);
    for (const cause of CRM_LEAD_LINK_REVERSAL_CAUSES) {
      expect(sql).toContain(`'${cause}'`);
    }
    expect(sql).toContain(
      "OLD.state = 'linked' AND NEW.state IN ('reversal_pending', 'reversed')"
    );
    expect(sql).toContain(
      "OLD.state = 'reversal_pending' AND NEW.state = 'reversed'"
    );
    expect(sql).toContain("a reversed link is final");
  });
});

describe("request validation", () => {
  const ok = {
    leadId: UUID_A,
    customerId: UUID_B,
    evidenceKind: "paid_order",
    orderId: UUID_C,
    expectedVersion: 3
  };

  test("accepts both evidence kinds and lower-cases the ids", () => {
    const paid = validateCreateCrmLeadLinkInput({
      ...ok,
      leadId: UUID_A.toUpperCase()
    });
    expect(paid).toEqual({
      valid: true,
      value: {
        leadId: UUID_A,
        customerId: UUID_B,
        evidenceKind: "paid_order",
        orderId: UUID_C,
        expectedVersion: 3
      }
    });
    const registration = validateCreateCrmLeadLinkInput({
      leadId: UUID_A,
      customerId: UUID_B,
      evidenceKind: "customer_registration",
      expectedVersion: 1
    });
    expect(registration.valid && registration.value.orderId).toBeNull();
  });

  test("refuses unknown fields (no phone, e-mail or handle can be supplied), bad ids, bad kinds and a missing or forbidden orderId", () => {
    for (const body of [
      { ...ok, phone: "0812" },
      { ...ok, email: "a@b.test" },
      { ...ok, handle: "@x" },
      { ...ok, leadId: "nope" },
      { ...ok, customerId: 7 },
      { ...ok, evidenceKind: "message_received" },
      { ...ok, orderId: undefined },
      { ...ok, evidenceKind: "customer_registration" },
      { ...ok, expectedVersion: 0 },
      { ...ok, expectedVersion: 1.5 },
      { ...ok, expectedVersion: "1" },
      null,
      [],
      "x"
    ]) {
      expect(validateCreateCrmLeadLinkInput(body).valid).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The directory's refusals, over a fake transaction
// ---------------------------------------------------------------------------

type FakeQuery = { text: string; values: unknown[] };

function fakeTx(answer: (query: FakeQuery) => unknown[]): {
  tx: Bun.SQL;
  queries: FakeQuery[];
} {
  const queries: FakeQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = { text: strings.join("?").replace(/\s+/g, " "), values };
    queries.push(query);
    return Promise.resolve(answer(query));
  };
  return {
    tx: Object.assign(tag, {
      unsafe: (text: string) => text
    }) as unknown as Bun.SQL,
    queries
  };
}

const LEAD_STATE: CrmLeadState = {
  leadId: UUID_A,
  pipelineId: UUID_D,
  stageKey: "new",
  stageCategory: "new",
  status: "open",
  mergedIntoLeadId: null,
  ownerTenantUserId: null,
  firstSourceKind: "api",
  firstTouchId: UUID_D,
  externalCustomerRef: null,
  version: 1
};

function fakePort(
  state: CrmLeadState | null,
  outcome: CrmLeadConversionOutcome = {
    outcome: "converted",
    conversionId: UUID_D
  }
): { port: CrmLeadPort; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async readLeadState() {
        calls.push("read");
        return state;
      },
      async confirmConversion() {
        calls.push("confirm");
        return outcome;
      },
      async reverseConversion() {
        calls.push("reverse");
        return { outcome: "reversed", conversionId: UUID_D };
      }
    }
  };
}

const INPUT = {
  leadId: UUID_A,
  customerId: UUID_B,
  evidenceKind: "customer_registration" as const,
  orderId: null,
  expectedVersion: 1
};

function standardAnswers(over: {
  moduleEnabled?: boolean;
  customer?: boolean;
  prior?: Record<string, unknown> | null;
  liveLink?: boolean;
  account?: Record<string, unknown> | null;
}) {
  return (query: FakeQuery): unknown[] => {
    if (query.text.includes("FROM awcms_tenant_modules")) {
      return [{ enabled: over.moduleEnabled ?? true }];
    }
    if (query.text.includes("FROM awcms_commerce_customers")) {
      return over.customer === false ? [] : [{ id: UUID_B, erased_at: null }];
    }
    if (query.text.includes("evidence_ref = ")) {
      return over.prior ? [over.prior] : [];
    }
    if (query.text.includes("state <> 'reversed'")) {
      return over.liveLink ? [{ one: 1 }] : [];
    }
    if (query.text.includes("FROM awcms_commerce_customer_accounts")) {
      return over.account === null
        ? []
        : [
            over.account ?? {
              status: "active",
              email_verified_at: new Date(),
              deleted_at: null
            }
          ];
    }
    return [];
  };
}

describe("linkLeadToCustomer refusals write nothing and never reach the CRM port's write", () => {
  const run = (
    answers: ReturnType<typeof standardAnswers>,
    state: CrmLeadState | null = LEAD_STATE,
    outcome?: CrmLeadConversionOutcome
  ) => {
    const { tx, queries } = fakeTx(answers);
    const { port, calls } = fakePort(state, outcome);
    return {
      queries,
      calls,
      result: linkLeadToCustomer(tx, UUID_C, UUID_D, INPUT, port)
    };
  };

  test("CRM off for the tenant, an unknown lead and an unknown customer", async () => {
    const off = run(standardAnswers({ moduleEnabled: false }));
    expect(await off.result).toEqual({ kind: "crm_leads_unavailable" });
    expect(off.calls).toEqual([]);

    const noLead = run(standardAnswers({}), null);
    expect(await noLead.result).toEqual({ kind: "lead_not_found" });
    expect(noLead.calls).toEqual(["read"]);

    const noCustomer = run(standardAnswers({ customer: false }));
    expect(await noCustomer.result).toEqual({ kind: "customer_not_found" });
    expect(noCustomer.calls).toEqual(["read"]);
  });

  test("a guest customer (no account) is evidence_not_verified and the port never confirms", async () => {
    const guest = run(standardAnswers({ account: null }));
    expect(await guest.result).toEqual({
      kind: "evidence_not_verified",
      reason: "no_account"
    });
    expect(guest.calls).not.toContain("confirm");
  });

  test("an unverified e-mail is refused", async () => {
    const unverified = run(
      standardAnswers({
        account: { status: "active", email_verified_at: null, deleted_at: null }
      })
    );
    expect(await unverified.result).toEqual({
      kind: "evidence_not_verified",
      reason: "email_not_verified"
    });
  });

  test("the same evidence for the same lead and customer is a replay; for another lead it is evidence_reused", async () => {
    const row = (leadId: string) => ({
      id: UUID_C,
      lead_id: leadId,
      customer_id: UUID_B,
      order_id: null,
      evidence_kind: "customer_registration",
      evidence_ref: registrationEvidenceRef(UUID_B),
      conversion_id: UUID_D,
      lead_first_source_kind: "api",
      lead_first_touch_id: UUID_D,
      state: "linked",
      linked_at: new Date(),
      reversal_cause: null,
      reversal_requested_at: null,
      reversed_at: null
    });
    const replay = run(standardAnswers({ prior: row(UUID_A) }));
    const replayed = await replay.result;
    expect(replayed.kind).toBe("replayed");
    expect(replay.calls).not.toContain("confirm");

    const reused = run(standardAnswers({ prior: row(UUID_C) }));
    expect(await reused.result).toEqual({ kind: "evidence_reused" });
    expect(reused.calls).not.toContain("confirm");
  });

  test("a lead with a live link is refused before the port is asked to convert it", async () => {
    const live = run(standardAnswers({ liveLink: true }));
    expect(await live.result).toEqual({ kind: "lead_already_linked" });
    expect(live.calls).not.toContain("confirm");
  });

  test("a CRM refusal is passed on as a refusal and nothing is inserted", async () => {
    for (const refusal of [
      "version_conflict",
      "not_open",
      "already_converted",
      "guard_not_met"
    ] as const) {
      const run1 = run(standardAnswers({}), LEAD_STATE, { outcome: refusal });
      expect(await run1.result).toEqual({
        kind: "conversion_refused",
        outcome: refusal
      });
      expect(
        run1.queries.some((query) => query.text.includes("INSERT INTO"))
      ).toBe(false);
    }
    const reused = run(standardAnswers({}), LEAD_STATE, {
      outcome: "evidence_reused"
    });
    expect(await reused.result).toEqual({ kind: "evidence_reused" });
  });

  test("the directory takes a lock per lead and per evidence before it probes", async () => {
    const attempt = run(standardAnswers({ account: null }));
    await attempt.result;
    expect(
      attempt.queries.filter((query) =>
        query.text.includes("pg_advisory_xact_lock")
      )
    ).toHaveLength(2);
  });
});

describe("reverseCrmLeadLink", () => {
  test("an unknown link, a reversed link and CRM-off write nothing", async () => {
    const none = fakeTx(() => []);
    const { port, calls } = fakePort(null);
    expect(
      await reverseCrmLeadLink(none.tx, UUID_C, UUID_D, UUID_A, port)
    ).toEqual({ kind: "not_found" });

    const row = (state: string) => ({
      id: UUID_A,
      lead_id: UUID_B,
      customer_id: UUID_C,
      order_id: null,
      evidence_kind: "customer_registration",
      evidence_ref: "x",
      conversion_id: UUID_D,
      lead_first_source_kind: null,
      lead_first_touch_id: null,
      state,
      linked_at: new Date(),
      reversal_cause: null,
      reversal_requested_at: null,
      reversed_at: null
    });
    const reversed = fakeTx((q) =>
      q.text.includes("FOR UPDATE") ? [row("reversed")] : []
    );
    expect(
      await reverseCrmLeadLink(reversed.tx, UUID_C, UUID_D, UUID_A, port)
    ).toEqual({ kind: "already_reversed" });

    const off = fakeTx((q) =>
      q.text.includes("FOR UPDATE")
        ? [row("linked")]
        : q.text.includes("awcms_tenant_modules")
          ? [{ enabled: false }]
          : []
    );
    expect(
      await reverseCrmLeadLink(off.tx, UUID_C, UUID_D, UUID_A, port)
    ).toEqual({ kind: "crm_leads_unavailable" });
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Descriptors, events, permissions, migrations
// ---------------------------------------------------------------------------

describe("the module descriptor", () => {
  test("declares the CRM lead port as an OPTIONAL capability, not a dependency", () => {
    expect(commerceModule.dependencies).not.toContain("crm_leads");
    expect(commerceModule.capabilities?.consumes).toContainEqual({
      capability: "crm_lead",
      providedBy: "crm_leads",
      optional: true
    });
  });

  test("declares the three permissions, all enforced", () => {
    const declared = new Set(
      (commerceModule.permissions ?? []).map(
        (permission) =>
          `commerce.${permission.activityCode}.${permission.action}`
      )
    );
    for (const key of Object.values(COMMERCE_CRM_LEAD_LINK_PERMISSIONS)) {
      expect(declared.has(key)).toBe(true);
    }
    const sql = read("sql/1069_awcms_commerce_crm_lead_link_permissions.sql");
    for (const action of ["read", "create", "approve"]) {
      expect(sql).toContain(`'crm_lead_links', '${action}'`);
    }
  });

  test("declares two flaggers with the default runtime_effect_once idempotency, on the order and refund events", () => {
    expect(CRM_LEAD_LINK_CONSUMERS.map((entry) => entry.name)).toEqual([
      "commerce.order_cancelled_crm_lead_link_flagger",
      "commerce.refund_settled_crm_lead_link_flagger"
    ]);
    expect(CRM_LEAD_LINK_CONSUMERS.map((entry) => entry.eventTypes)).toEqual([
      ["awcms.commerce.order.cancelled"],
      ["awcms.commerce.refund.settled"]
    ]);
    const registered = (commerceModule.domainEventConsumers ?? []).map(
      (entry) => entry.name
    );
    for (const entry of CRM_LEAD_LINK_CONSUMERS) {
      expect(registered).toContain(entry.name);
      expect(entry.idempotency ?? "runtime_effect_once").toBe(
        "runtime_effect_once"
      );
    }
  });

  test("publishes both customer events, registered with the runtime and the AsyncAPI document", () => {
    for (const type of [
      COMMERCE_CUSTOMER_REGISTERED_EVENT_TYPE,
      COMMERCE_CUSTOMER_CONVERTED_EVENT_TYPE
    ]) {
      expect(commerceModule.events?.publishes).toContain(type);
      expect(isRegisteredDomainEventType(type, "1.0")).toBe(true);
      expect(read("asyncapi/awcms-domain-events.asyncapi.yaml")).toContain(
        `  ${type}:\n    address: ${type}`
      );
    }
    expect(COMMERCE_CUSTOMER_CONVERTED_EVENT_TYPE).toBe(
      "awcms.commerce.customer.converted"
    );
  });

  test("the lifecycle answers on the record with no purge; the subject data is retained and the shopper registry lists the table", () => {
    expect(
      CRM_LEAD_LINK_DATA_LIFECYCLE.map((entry) => entry.tableName)
    ).toEqual(["awcms_commerce_crm_lead_links"]);
    expect(CRM_LEAD_LINK_DATA_LIFECYCLE[0]!.executionMode).toBe("delegated");
    expect(CRM_LEAD_LINK_SUBJECT_DATA[0]!.erasure).toBe(
      "retain_under_obligation"
    );
    expect(
      CRM_LEAD_LINK_SUBJECT_DATA[0]!.subjectColumns.map((c) => c.column)
    ).toEqual([
      "linked_by_tenant_user_id",
      "reversal_actor_tenant_user_id",
      "reversed_by_tenant_user_id"
    ]);
    const entry = SUBJECT_TABLES.find(
      (table) => table.table === "awcms_commerce_crm_lead_links"
    );
    expect(entry).toBeDefined();
    expect(entry!.keySet).toBe("customer");
    expect(entry!.erasure.action).toBe("retain");
    expect(entry!.redactedColumns).toContain("linked_by_tenant_user_id");
  });
});

describe("migration 1068", () => {
  const sql = read("sql/1068_awcms_commerce_crm_lead_links.sql");
  const code = sql
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");

  test("RLS is forced with a tenant policy, the keys are tenant-composite and the lead id is opaque", () => {
    expect(code).toContain(
      "ALTER TABLE awcms_commerce_crm_lead_links FORCE ROW LEVEL SECURITY"
    );
    expect(code).toContain(
      "tenant_id = current_setting('app.current_tenant_id')::uuid"
    );
    expect(code).toContain("FOREIGN KEY (tenant_id, customer_id)");
    expect(code).toContain("FOREIGN KEY (tenant_id, order_id)");
    expect(code).not.toMatch(/REFERENCES\s+awcms_crm_/i);
    expect(code).toContain("UNIQUE (tenant_id, evidence_ref)");
    expect(code).toContain("WHERE state <> 'reversed'");
  });

  test("nothing is deleted by anyone, the function pins its search_path and the worker grant is narrow", () => {
    expect(code).toContain(
      "REVOKE DELETE, TRUNCATE ON awcms_commerce_crm_lead_links FROM awcms_app"
    );
    expect(code).toContain("SET search_path = public, pg_temp");
    expect(code).toContain("BEFORE UPDATE OR DELETE");
    expect(code).toContain(
      "GRANT SELECT ON awcms_commerce_crm_lead_links TO awcms_worker"
    );
    const update = code.match(/GRANT UPDATE \(([^)]*)\)/)![1]!;
    expect(update.split(",").map((column) => column.trim())).toEqual([
      "state",
      "reversal_cause",
      "reversal_requested_at",
      "reversal_actor_tenant_user_id",
      "updated_at"
    ]);
    expect(code).not.toMatch(/GRANT[^;]*awcms_crm_/);
  });

  test("no personal-data column exists", () => {
    const columns =
      code.match(/^\s{2}([a-z_]+) (?:uuid|text|timestamptz)/gm) ?? [];
    for (const column of columns) {
      expect(column).not.toMatch(
        /\b(name|email|phone|handle|note|address|display)\b/
      );
    }
  });
});
