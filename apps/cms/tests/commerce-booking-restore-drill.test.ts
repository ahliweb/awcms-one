/**
 * The booking adapter's post-restore drill (Issue #396, epic #280 item 35,
 * adapter half; threat controls C-09 and C-38) - no database. What only a
 * database can prove (the SQL against real drift) is in
 * `tests/integration/commerce-booking-restore-drill.integration.test.ts`.
 *
 * Pinned here:
 *
 *   - the verdict: zero drift passes, any drift fails, an acknowledged C-09
 *     finding (an open attention flag) is reported and never fails, an empty
 *     database fails only under `--require-links`, a transient decision with no
 *     return yet never fails;
 *   - the evidence line carries counts and kinds only - no id, no amount;
 *   - the CLI arguments: unknown flags and malformed values are refused;
 *   - read-only: every statement the drill issues is a SELECT (or the one
 *     `SET LOCAL transaction_read_only`), each is tenant-scoped, and the
 *     structure check reads only the catalog;
 *   - the structure check names exactly what a restore lost;
 *   - the module boundary: the table list matches the lifecycle descriptors,
 *     the extension point exists and is empty, the script is registered, and
 *     the only file that names a Booking table is still the designated reader.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  BOOKING_ADAPTER_RESTORE_INDEXES,
  BOOKING_ADAPTER_RESTORE_TABLES,
  BOOKING_RESTORE_EXTENSION_CHECKS,
  checkBookingAdapterStructure,
  reconcileBookingRestoreForTenant
} from "../src/modules/commerce/application/booking-restore-reconciliation";
import { BOOKING_ADAPTER_DATA_LIFECYCLE } from "../src/modules/commerce/domain/booking-adapter-lifecycle";
import {
  buildDrillEvidenceLine,
  drillExitCode,
  evaluateBookingRestoreReport,
  formatDrillText,
  parseReconcileArgs,
  type BookingRestoreReport,
  type ReferenceDriftItem,
  type TenantRestoreReport
} from "../src/modules/commerce/domain/booking-restore-drill";

const TENANT = "39600000-0396-4000-8000-00000000000a";
const OTHER = "39600000-0396-4000-8000-00000000000b";
const UUID = (n: number) =>
  `39600000-0396-4000-8000-${String(n).padStart(12, "0")}`;

const ref = (kind: ReferenceDriftItem["kind"]): ReferenceDriftItem => ({
  kind,
  linkId: null,
  orderId: null,
  reservationId: null,
  reservationNo: null,
  reservationStatus: null,
  externalRefType: null,
  externalRef: null,
  orderExists: null,
  liveReferences: null,
  activeLinks: null
});

function tenantReport(
  overrides: Partial<TenantRestoreReport> = {}
): TenantRestoreReport {
  return {
    tenantId: TENANT,
    counts: {
      offeringLinks: 1,
      reservationLinks: 3,
      activeReservationLinks: 2,
      openAttention: 0,
      refundDecisions: 0,
      decisionsAwaitingLegs: 0
    },
    references: { items: [], truncated: false },
    ledger: { items: [], truncated: false },
    ledgerAcknowledged: 0,
    decisions: { items: [], truncated: false },
    extensions: [],
    ...overrides
  };
}

const report = (
  tenants: TenantRestoreReport[],
  structure: BookingRestoreReport["structure"] = []
): BookingRestoreReport => ({ structure, tenants });

describe("the verdict", () => {
  test("zero drift passes and exits 0", () => {
    const verdict = evaluateBookingRestoreReport(report([tenantReport()]));
    expect(verdict.status).toBe("pass");
    expect(verdict.driftTotal).toBe(0);
    expect(verdict.totals.reservationLinks).toBe(3);
    expect(drillExitCode(verdict.status)).toBe(0);
  });

  test("a C-38 reference finding fails the drill and is counted by kind", () => {
    const verdict = evaluateBookingRestoreReport(
      report([
        tenantReport({
          references: {
            items: [
              ref("back_reference_missing"),
              ref("back_reference_missing"),
              ref("order_multiple_references")
            ],
            truncated: false
          }
        })
      ])
    );
    expect(verdict.status).toBe("drift");
    expect(verdict.driftByKind).toEqual({
      "reference:back_reference_missing": 2,
      "reference:order_multiple_references": 1
    });
    expect(drillExitCode(verdict.status)).toBe(1);
  });

  test("a structure finding, a decision finding and an extension finding each fail it", () => {
    const structure = evaluateBookingRestoreReport(
      report([tenantReport()], [{ kind: "rls_not_forced", object: "t" }])
    );
    expect(structure.status).toBe("drift");
    expect(structure.driftByKind).toEqual({ "structure:rls_not_forced": 1 });

    const decision = evaluateBookingRestoreReport(
      report([
        tenantReport({
          decisions: {
            items: [
              {
                kind: "legs_exceed_decision",
                decisionId: UUID(1),
                reservationLinkId: UUID(2),
                orderId: UUID(3),
                returnId: UUID(4),
                finalRefund: "0.00",
                plannedLegs: "10.00",
                settledLegs: "0.00"
              }
            ],
            truncated: false
          }
        })
      ])
    );
    expect(decision.driftByKind).toEqual({
      "decision:legs_exceed_decision": 1
    });

    const extension = evaluateBookingRestoreReport(
      report([
        tenantReport({
          extensions: [{ check: "x", detail: "d", ids: [UUID(1), UUID(2)] }]
        })
      ])
    );
    expect(extension.status).toBe("drift");
    expect(extension.driftTotal).toBe(2);
  });

  test("a C-09 finding with an open attention flag is acknowledged, never drift", () => {
    const verdict = evaluateBookingRestoreReport(
      report([tenantReport({ ledgerAcknowledged: 2 })])
    );
    expect(verdict.status).toBe("pass");
    expect(verdict.acknowledgedLedger).toBe(2);

    const unflagged = evaluateBookingRestoreReport(
      report([
        tenantReport({
          ledger: {
            items: [
              {
                kind: "paid_without_confirm",
                linkId: UUID(1),
                orderId: UUID(2),
                reservationId: UUID(3),
                reservationStatus: "held",
                attentionOpen: false
              }
            ],
            truncated: false
          }
        })
      ])
    );
    expect(unflagged.status).toBe("drift");
    expect(unflagged.driftByKind).toEqual({ "ledger:paid_without_confirm": 1 });
  });

  test("a decision awaiting its return is a count, not drift", () => {
    const verdict = evaluateBookingRestoreReport(
      report([
        tenantReport({
          counts: {
            ...tenantReport().counts,
            refundDecisions: 1,
            decisionsAwaitingLegs: 1
          }
        })
      ])
    );
    expect(verdict.status).toBe("pass");
    expect(verdict.totals.decisionsAwaitingLegs).toBe(1);
    expect(formatDrillText(report([]), verdict).join("\n")).toContain(
      "not counted as drift"
    );
  });

  test("an empty database passes by default and fails under --require-links", () => {
    const empty = report([
      tenantReport({
        counts: {
          offeringLinks: 0,
          reservationLinks: 0,
          activeReservationLinks: 0,
          openAttention: 0,
          refundDecisions: 0,
          decisionsAwaitingLegs: 0
        }
      })
    ]);
    expect(evaluateBookingRestoreReport(empty).status).toBe("pass");
    const strict = evaluateBookingRestoreReport(empty, { requireLinks: true });
    expect(strict.status).toBe("empty");
    expect(drillExitCode(strict.status)).toBe(1);
  });

  test("a truncated list is surfaced", () => {
    const verdict = evaluateBookingRestoreReport(
      report([
        tenantReport({
          references: {
            items: [ref("orphan_back_reference")],
            truncated: true
          }
        })
      ])
    );
    expect(verdict.truncated).toBe(true);
    expect(formatDrillText(report([]), verdict).join("\n")).toContain("bound");
  });

  test("totals add up across tenants", () => {
    const verdict = evaluateBookingRestoreReport(
      report([tenantReport(), tenantReport({ tenantId: OTHER })])
    );
    expect(verdict.tenantsChecked).toBe(2);
    expect(verdict.totals.reservationLinks).toBe(6);
    expect(verdict.totals.activeReservationLinks).toBe(4);
  });
});

describe("the evidence line", () => {
  test("is one JSON object with counts and kinds and no identifier", () => {
    const rep = report([
      tenantReport({
        references: {
          items: [ref("back_reference_mismatch")],
          truncated: false
        }
      })
    ]);
    const verdict = evaluateBookingRestoreReport(rep);
    const line = buildDrillEvidenceLine({
      startedAt: new Date("2026-10-19T01:02:03.000Z"),
      durationMs: 42,
      verdict
    });
    expect(line).not.toContain("\n");
    expect(line).not.toContain(TENANT);
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      startedAt: "2026-10-19T01:02:03.000Z",
      check: "commerce:booking:reconcile",
      status: "fail",
      outcome: "drift",
      durationMs: 42,
      tenantsChecked: 1,
      drift: { "reference:back_reference_mismatch": 1 }
    });
  });

  test("a clean run is status pass", () => {
    const verdict = evaluateBookingRestoreReport(report([tenantReport()]));
    const parsed = JSON.parse(
      buildDrillEvidenceLine({ startedAt: new Date(0), durationMs: 1, verdict })
    );
    expect(parsed.status).toBe("pass");
    expect(parsed.drift).toEqual({});
  });
});

describe("the arguments", () => {
  test("defaults", () => {
    expect(parseReconcileArgs([])).toEqual({
      tenantId: null,
      json: false,
      requireLinks: false,
      evidenceLog: null
    });
  });

  test("every flag", () => {
    expect(
      parseReconcileArgs([
        "--tenant",
        TENANT.toUpperCase(),
        "--json",
        "--require-links",
        "--evidence-log",
        "/backup/restore-drill-evidence.jsonl"
      ])
    ).toEqual({
      tenantId: TENANT,
      json: true,
      requireLinks: true,
      evidenceLog: "/backup/restore-drill-evidence.jsonl"
    });
  });

  test("an unknown flag, a missing value and a non-uuid tenant are refused", () => {
    expect(() => parseReconcileArgs(["--commit"])).toThrow(/Unknown argument/);
    expect(() => parseReconcileArgs(["--tenant"])).toThrow(/needs a value/);
    expect(() => parseReconcileArgs(["--tenant", "--json"])).toThrow(
      /needs a value/
    );
    expect(() => parseReconcileArgs(["--tenant", "nope"])).toThrow(/UUID/);
    expect(() => parseReconcileArgs(["--evidence-log"])).toThrow(
      /needs a value/
    );
  });
});

// ---------------------------------------------------------------------------
// A fake client: answers by the statement's text and records every statement.
// ---------------------------------------------------------------------------

type Answer = { match: RegExp; rows: unknown[] };

function fakeClient(answers: Answer[]) {
  const statements: string[] = [];
  const client = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce(
      (acc, part, index) =>
        acc + part + (index < values.length ? `$${index + 1}` : ""),
      ""
    );
    statements.push(text);
    const answer = answers.find((candidate) => candidate.match.test(text));
    return Promise.resolve(answer ? answer.rows : []);
  }) as unknown as Bun.SQL & { array: (...args: unknown[]) => unknown };
  (client as unknown as { array: unknown }).array = (values: unknown[]) =>
    values;
  return { client, statements };
}

describe("one tenant's pass", () => {
  const counts = {
    offering_links: 1,
    reservation_links: 4,
    active_reservation_links: 3,
    open_attention: 1,
    refund_decisions: 2,
    decisions_awaiting_legs: 1
  };

  test("is read-only: SET LOCAL read only, then SELECTs scoped to the tenant", async () => {
    const { client, statements } = fakeClient([
      { match: /AS offering_links/, rows: [counts] }
    ]);
    const result = await reconcileBookingRestoreForTenant(client, TENANT);

    expect(statements[0]).toMatch(/SET LOCAL transaction_read_only = on/);
    const rest = statements.slice(1);
    expect(rest.length).toBeGreaterThanOrEqual(5);
    for (const statement of rest) {
      expect(statement.trimStart(), statement).toMatch(/^(WITH|SELECT)\b/);
      expect(statement, statement).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/
      );
      expect(statement, statement).toContain("tenant_id = $");
    }
    expect(result.counts).toEqual({
      offeringLinks: 1,
      reservationLinks: 4,
      activeReservationLinks: 3,
      openAttention: 1,
      refundDecisions: 2,
      decisionsAwaitingLegs: 1
    });
    expect(result.references.items).toEqual([]);
  });

  test("maps the three C-38 statements to items, with the evidence of each", async () => {
    const { client } = fakeClient([
      { match: /AS offering_links/, rows: [counts] },
      {
        match: /WHEN r\.status = 'rescheduled'/,
        rows: [
          {
            kind: "back_reference_missing",
            link_id: UUID(1),
            order_id: UUID(2),
            reservation_id: UUID(3),
            reservation_no: "BK-1",
            reservation_status: "held",
            external_ref_type: null,
            external_ref: null
          },
          {
            kind: "back_reference_mismatch",
            link_id: UUID(4),
            order_id: UUID(5),
            reservation_id: UUID(6),
            reservation_no: "BK-2",
            reservation_status: "confirmed",
            external_ref_type: "commerce_order",
            external_ref: UUID(9)
          }
        ]
      },
      {
        match: /order_exists/,
        rows: [
          {
            reservation_id: UUID(7),
            reservation_no: "BK-3",
            reservation_status: "held",
            external_ref_type: "commerce_order",
            external_ref: UUID(8),
            order_exists: false
          }
        ]
      },
      {
        match: /live_references/,
        rows: [{ order_ref: UUID(10), live_references: "2", active_links: 0 }]
      }
    ]);
    const result = await reconcileBookingRestoreForTenant(client, TENANT);
    const items = result.references.items as {
      kind: string;
      linkId: string | null;
      orderExists: boolean | null;
      liveReferences: number | null;
      orderId: string | null;
    }[];
    expect(items.map((item) => item.kind)).toEqual([
      "back_reference_missing",
      "back_reference_mismatch",
      "orphan_back_reference",
      "order_multiple_references"
    ]);
    expect(items[2]).toMatchObject({
      orderExists: false,
      orderId: UUID(8),
      linkId: null
    });
    expect(items[3]).toMatchObject({ liveReferences: 2, orderId: UUID(10) });
    expect(result.references.truncated).toBe(false);
  });

  test("splits the C-09 items into unflagged drift and acknowledged ones", async () => {
    const row = (n: number, attention: boolean) => ({
      link_id: UUID(n),
      order_id: UUID(n + 10),
      order_code: `C${n}`,
      order_status: "paid",
      total: "100.00",
      threshold: "100.00",
      settled: "100.00",
      reservation_id: UUID(n + 20),
      reservation_no: `BK-${n}`,
      reservation_status: "held",
      attention_reason: attention ? "confirm_failed" : null,
      attention_resolved_at: null
    });
    const { client } = fakeClient([
      { match: /AS offering_links/, rows: [counts] },
      {
        match: /WITH active AS/,
        rows: [row(1, false), row(2, true), row(3, true)]
      }
    ]);
    const result = await reconcileBookingRestoreForTenant(client, TENANT);
    expect(result.ledgerAcknowledged).toBe(2);
    expect(result.ledger.items).toEqual([
      {
        kind: "paid_without_confirm",
        linkId: UUID(1),
        orderId: UUID(11),
        reservationId: UUID(21),
        reservationStatus: "held",
        attentionOpen: false
      }
    ]);
  });

  test("normalises decision money and flags a truncated list", async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      kind: "legs_exceed_decision",
      decision_id: UUID(index + 1),
      reservation_link_id: UUID(1000),
      order_id: UUID(2000),
      return_id: UUID(3000),
      final_refund: "0",
      planned: "10.5",
      settled: "0"
    }));
    const { client } = fakeClient([
      { match: /AS offering_links/, rows: [counts] },
      { match: /WITH legs AS/, rows }
    ]);
    const result = await reconcileBookingRestoreForTenant(client, TENANT);
    expect(result.decisions.truncated).toBe(true);
    expect(result.decisions.items).toHaveLength(200);
    expect(result.decisions.items[0]).toMatchObject({
      finalRefund: "0.00",
      plannedLegs: "10.50",
      settledLegs: "0.00"
    });
  });

  test("runs the registered extension checks and carries their findings", async () => {
    const { client } = fakeClient([
      { match: /AS offering_links/, rows: [counts] }
    ]);
    const ran: string[] = [];
    const result = await reconcileBookingRestoreForTenant(client, TENANT, {
      extensions: [
        {
          key: "demo",
          run: async (_tx, tenantId) => {
            ran.push(tenantId);
            return [{ check: "demo", detail: "x", ids: [UUID(1)] }];
          }
        }
      ]
    });
    expect(ran).toEqual([TENANT]);
    expect(result.extensions).toEqual([
      { check: "demo", detail: "x", ids: [UUID(1)] }
    ]);
  });
});

describe("the structure check", () => {
  const healthyTables = BOOKING_ADAPTER_RESTORE_TABLES.map((relname) => ({
    relname,
    relrowsecurity: true,
    relforcerowsecurity: true
  }));
  const healthyPolicies = BOOKING_ADAPTER_RESTORE_TABLES.map((table) => ({
    policyname: `${table}_tenant_isolation`
  }));
  const healthyTriggers = BOOKING_ADAPTER_RESTORE_TABLES.map((table) => ({
    tgname: `${table}_guard`,
    tgenabled: "O"
  }));
  const healthyIndexes = BOOKING_ADAPTER_RESTORE_INDEXES.map((relname) => ({
    relname
  }));

  const answers = (overrides: Partial<Record<string, unknown[]>> = {}) => [
    { match: /FROM pg_class c/, rows: overrides.tables ?? healthyTables },
    { match: /FROM pg_policies/, rows: overrides.policies ?? healthyPolicies },
    { match: /FROM pg_trigger/, rows: overrides.triggers ?? healthyTriggers },
    { match: /FROM pg_index/, rows: overrides.indexes ?? healthyIndexes }
  ];

  test("a healthy restore has no findings and reads only the catalog", async () => {
    const { client, statements } = fakeClient(answers());
    expect(await checkBookingAdapterStructure(client)).toEqual([]);
    expect(statements).toHaveLength(4);
    for (const statement of statements) {
      expect(statement).toMatch(/pg_(class|policies|trigger|index)/);
      expect(statement).not.toMatch(/awcms_commerce_|awcms_booking_/);
    }
  });

  test("names exactly what the restore lost", async () => {
    const tables = BOOKING_ADAPTER_RESTORE_TABLES;
    const { client } = fakeClient(
      answers({
        // tables[0] lost FORCE RLS; tables[2] is gone altogether.
        tables: healthyTables
          .filter((row) => row.relname !== tables[2])
          .map((row) =>
            row.relname === tables[0]
              ? { ...row, relforcerowsecurity: false }
              : row
          ),
        // tables[0]'s policy is gone.
        policies: healthyPolicies.filter(
          (row) => row.policyname !== `${tables[0]}_tenant_isolation`
        ),
        // tables[1]'s guard is disabled, tables[3]'s is gone.
        triggers: healthyTriggers
          .filter((row) => row.tgname !== `${tables[3]}_guard`)
          .map((row) =>
            row.tgname === `${tables[1]}_guard`
              ? { ...row, tgenabled: "D" }
              : row
          ),
        indexes: healthyIndexes.slice(1)
      })
    );
    const findings = await checkBookingAdapterStructure(client);
    expect(findings.map((f) => `${f.kind}:${f.object}`).sort()).toEqual(
      [
        `rls_not_forced:${tables[0]}`,
        `policy_missing:${tables[0]}_tenant_isolation`,
        `trigger_disabled:${tables[1]}_guard`,
        `table_missing:${tables[2]}`,
        `trigger_missing:${tables[3]}_guard`,
        `index_missing:${BOOKING_ADAPTER_RESTORE_INDEXES[0]}`
      ].sort()
    );
  });
});

describe("the wiring", () => {
  test("the restore table list is the lifecycle descriptors' table list", () => {
    const described: string[] = BOOKING_ADAPTER_DATA_LIFECYCLE.map(
      (descriptor) => descriptor.tableName
    ).sort();
    const restored: string[] = [...BOOKING_ADAPTER_RESTORE_TABLES].sort();
    expect(restored).toEqual(described);
  });

  test("the extension point exists and is empty until #381 registers into it", () => {
    expect(BOOKING_RESTORE_EXTENSION_CHECKS).toEqual([]);
  });

  test("the script is a package.json target and names the helper it runs", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["commerce:booking:reconcile"]).toBe(
      "bun scripts/commerce-booking-reconcile.ts"
    );
    const script = await readFile(
      "scripts/commerce-booking-reconcile.ts",
      "utf8"
    );
    expect(script).toContain("runBookingRestoreReconciliation");
    expect(script).toContain("getDatabaseClient");
    // Read-only by construction: the script writes only the optional evidence file.
    expect(script).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE\s+awcms|DELETE\s+FROM)\b/i
    );
  });

  test("the new application file names no Booking table and writes nothing", async () => {
    const source = await readFile(
      "src/modules/commerce/application/booking-restore-reconciliation.ts",
      "utf8"
    );
    expect(source).not.toMatch(/\b(?:FROM|JOIN)\s+awcms_booking_/i);
    expect(source).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(source).not.toMatch(/\.unsafe\(/);
  });

  test("the C-38 statements live in the designated Booking reader and only select", async () => {
    const source = await readFile(
      "src/modules/commerce/application/booking-reservation-reads.ts",
      "utf8"
    );
    expect(source).toContain(
      "export async function reconcileBookingReferences"
    );
    expect(source).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
  });
});
