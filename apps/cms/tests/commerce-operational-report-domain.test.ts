/**
 * POS operational-report delta rules, CSV serialisation and projection
 * registry (Issue #296, ADR-0035). Pure - no database. The database half (live
 * delta vs rebuild parity, reconcile drift, RLS) is
 * `tests/integration/commerce-operational-reports.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import {
  cashUpVarianceCents,
  classifyLoyaltyBucket,
  classifyStoredValueBucket,
  computeCashUpCorrectionDelta,
  computeCashUpLineDelta,
  computeExpensePostedDelta,
  computeExpenseReversedDelta,
  computeLoyaltyDailyDelta,
  computeRefundLegDelta,
  computeReturnDelta,
  computeReturnLineDelta,
  computeStoredValueDailyDelta,
  computeTenderDailyDelta,
  formatSignedCents,
  OPERATIONAL_NO_REGISTER_ID,
  summariseDispositionUnits
} from "../src/modules/commerce/domain/operational-report-deltas";
import {
  OPERATIONAL_REPORT_FAMILIES,
  OPERATIONAL_REPORT_PROJECTION_KEYS
} from "../src/modules/commerce/domain/operational-report-keys";
import {
  serializeCashUpVarianceCsv,
  serializeExpenseReportCsv,
  serializeLoyaltyReportCsv,
  serializeReturnsReportCsv,
  serializeStoredValueReportCsv,
  serializeTenderCsv
} from "../src/modules/commerce/domain/operational-report-csv";
import type {
  CashUpReport,
  ExpenseReport,
  LoyaltyReport,
  ReturnsReport,
  StoredValueReport,
  TenderReport
} from "../src/modules/commerce/application/operational-report-directory";
import { summariseReturns } from "../src/modules/commerce/application/operational-report-directory";
import { validateProjectionRegistry } from "../src/modules/reporting/domain/projection-registry";

const REGISTER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = {
  sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  registerId: REGISTER,
  cashierTenantUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  closedAt: new Date("2026-09-10T11:00:00.000Z")
};

describe("tender delta", () => {
  const base = {
    kind: "payment",
    tenderType: "cash",
    amount: "50000.00",
    status: "succeeded",
    settledAt: new Date("2026-09-10T03:00:00.000Z"),
    registerId: REGISTER
  };

  test("a succeeded payment adds to the payment columns on the register", () => {
    expect(computeTenderDailyDelta(base)).toEqual({
      day: "2026-09-10",
      registerId: REGISTER,
      tenderType: "cash",
      paymentCount: 1,
      paymentCents: 5_000_000n,
      reversalCount: 0,
      reversalCents: 0n
    });
  });

  test("a reversal adds to the reversal columns, never subtracts from the payments", () => {
    const delta = computeTenderDailyDelta({ ...base, kind: "reversal" })!;
    expect(delta.paymentCents).toBe(0n);
    expect(delta.reversalCount).toBe(1);
    expect(delta.reversalCents).toBe(5_000_000n);
  });

  test("a failed leg, a pending leg and a leg with no settlement time contribute nothing", () => {
    expect(computeTenderDailyDelta({ ...base, status: "failed" })).toBeNull();
    expect(computeTenderDailyDelta({ ...base, status: "pending" })).toBeNull();
    expect(computeTenderDailyDelta({ ...base, settledAt: null })).toBeNull();
  });

  test("an unstamped leg lands on the no-register sentinel", () => {
    expect(
      computeTenderDailyDelta({ ...base, registerId: null })!.registerId
    ).toBe(OPERATIONAL_NO_REGISTER_ID);
  });

  test("day bucketing follows Asia/Jakarta: one second either side of local midnight", () => {
    // 16:59:59Z is 23:59:59 in WIB (UTC+7) - still the 10th.
    expect(
      computeTenderDailyDelta({
        ...base,
        settledAt: new Date("2026-09-10T16:59:59.000Z")
      })!.day
    ).toBe("2026-09-10");
    // 17:00:01Z is 00:00:01 WIB on the 11th, while it is still the 10th in UTC.
    expect(
      computeTenderDailyDelta({
        ...base,
        settledAt: new Date("2026-09-10T17:00:01.000Z")
      })!.day
    ).toBe("2026-09-11");
    // And the other end: 16:59:59.999Z of the previous UTC day is the 10th.
    expect(
      computeTenderDailyDelta({
        ...base,
        settledAt: new Date("2026-09-09T17:00:00.000Z")
      })!.day
    ).toBe("2026-09-10");
  });
});

describe("cash-up deltas", () => {
  const decidedAt = new Date("2026-09-10T11:00:00.000Z");

  test("the close line carries expected and counted on the close day; corrections add only an adjustment", () => {
    const line = computeCashUpLineDelta(SESSION, decidedAt, {
      tenderType: "cash",
      expected: "40000.00",
      counted: "39000.00"
    });
    expect(line).toMatchObject({
      sessionId: SESSION.sessionId,
      registerId: REGISTER,
      day: "2026-09-10",
      lines: 1,
      expectedCents: 4_000_000n,
      countedCents: 3_900_000n,
      adjustmentCents: 0n
    });

    const correction = computeCashUpCorrectionDelta(SESSION, new Date(), {
      tenderType: "cash",
      adjustment: "-250.50"
    });
    expect(correction).toMatchObject({
      // The correction lands on the day the session CLOSED, not the day it was made.
      day: "2026-09-10",
      lines: 0,
      expectedCents: 0n,
      countedCents: 0n,
      adjustmentCents: -25_050n
    });
  });

  test("a session without a close stamp falls back to the decision time", () => {
    const delta = computeCashUpLineDelta(
      { ...SESSION, closedAt: null },
      new Date("2026-09-10T17:30:00.000Z"),
      { tenderType: "cash", expected: "1.00", counted: "1.00" }
    );
    expect(delta.day).toBe("2026-09-11");
  });

  test("variance is counted with corrections minus expected; negative is short", () => {
    expect(
      cashUpVarianceCents({
        expectedCents: 4_000_000n,
        countedCents: 3_900_000n,
        adjustmentCents: 0n
      })
    ).toBe(-100_000n);
    expect(
      cashUpVarianceCents({
        expectedCents: 4_000_000n,
        countedCents: 3_900_000n,
        adjustmentCents: 50_000n
      })
    ).toBe(-50_000n);
    expect(
      cashUpVarianceCents({
        expectedCents: 0n,
        countedCents: 100n,
        adjustmentCents: 0n
      })
    ).toBe(100n);
  });
});

describe("expense deltas", () => {
  const fact = {
    occurredOn: "2026-09-10",
    categoryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    categoryName: "Utilities",
    tenderType: "cash",
    amount: "75000.00"
  };

  test("a posting and its reversal land on the SAME key, in different columns", () => {
    const posted = computeExpensePostedDelta(fact);
    const reversed = computeExpenseReversedDelta(fact);
    expect(posted.day).toBe(reversed.day);
    expect(posted.categoryId).toBe(reversed.categoryId);
    expect(posted).toMatchObject({ postedCount: 1, postedCents: 7_500_000n });
    expect(posted.reversedCents).toBe(0n);
    expect(reversed).toMatchObject({
      reversedCount: 1,
      reversedCents: 7_500_000n
    });
    expect(reversed.postedCents).toBe(0n);
  });

  test("the day is the typed occurred-on date, untouched by any time-zone conversion", () => {
    expect(
      computeExpensePostedDelta({ ...fact, occurredOn: "2026-12-31" }).day
    ).toBe("2026-12-31");
  });
});

describe("ledger buckets", () => {
  test("loyalty kinds map to buckets, adjustments and reversals split by sign", () => {
    expect(classifyLoyaltyBucket("earn", 10n)).toBe("earn");
    expect(classifyLoyaltyBucket("redeem", -10n)).toBe("redeem");
    expect(classifyLoyaltyBucket("expire", -3n)).toBe("expire");
    expect(classifyLoyaltyBucket("adjustment", 5n)).toBe("adjustment_up");
    expect(classifyLoyaltyBucket("adjustment", -5n)).toBe("adjustment_down");
    expect(classifyLoyaltyBucket("reversal", -50n)).toBe("reversal_down");
    expect(classifyLoyaltyBucket("reversal", 30n)).toBe("reversal_up");
    expect(classifyLoyaltyBucket("expire", 0n)).toBeNull();
    expect(classifyLoyaltyBucket("mystery", 1n)).toBeNull();
  });

  test("a loyalty entry lands on its local day with its signed points intact", () => {
    expect(
      computeLoyaltyDailyDelta({
        kind: "earn",
        points: 100n,
        createdAt: new Date("2026-09-10T17:00:01.000Z")
      })
    ).toEqual({ day: "2026-09-11", bucket: "earn", entries: 1, points: 100n });
  });

  test("stored-value kinds map to buckets; disable/enable move no money", () => {
    for (const kind of ["issue", "load", "refund"] as const) {
      expect(classifyStoredValueBucket(kind, 100n)).toBe(kind);
    }
    expect(classifyStoredValueBucket("redeem", -100n)).toBe("redeem");
    expect(classifyStoredValueBucket("expire", -100n)).toBe("expire");
    expect(classifyStoredValueBucket("adjust", 100n)).toBe("adjust_up");
    expect(classifyStoredValueBucket("adjust", -100n)).toBe("adjust_down");
    expect(classifyStoredValueBucket("disable", 0n)).toBeNull();
    expect(classifyStoredValueBucket("enable", 0n)).toBeNull();
  });

  test("a stored-value entry keeps its sign, its account kind and its local day", () => {
    expect(
      computeStoredValueDailyDelta({
        kind: "redeem",
        amount: "-20000.00",
        accountKind: "gift_card",
        createdAt: new Date("2026-09-10T16:59:59.000Z")
      })
    ).toEqual({
      day: "2026-09-10",
      accountKind: "gift_card",
      bucket: "redeem",
      entries: 1,
      cents: -2_000_000n
    });
  });
});

describe("signed money rendering", () => {
  test("renders integer cents as canonical signed two-decimal strings", () => {
    expect(formatSignedCents(0n)).toBe("0.00");
    expect(formatSignedCents(5n)).toBe("0.05");
    expect(formatSignedCents(-150n)).toBe("-1.50");
    expect(formatSignedCents(123_456_789_012n)).toBe("1234567890.12");
  });
});

describe("CSV serialisation neutralises formulas and keeps amounts numeric", () => {
  const envelope = {
    from: "2026-09-01",
    to: "2026-09-30",
    timeZone: "Asia/Jakarta",
    enabled: true
  };

  test("tender CSV: a register named like a formula is quoted, amounts are bare", () => {
    const report: TenderReport = {
      ...envelope,
      items: [
        {
          day: "2026-09-10",
          registerId: REGISTER,
          registerCode: "=1+1",
          registerName: '@SUM(A1),"x"',
          tenderType: "cash",
          paymentCount: 1,
          payments: "50000.00",
          reversalCount: 0,
          reversals: "0.00",
          net: "50000.00"
        }
      ],
      summary: [],
      totalPayments: "50000.00",
      totalReversals: "0.00",
      totalNet: "50000.00"
    };
    const lines = serializeTenderCsv(report).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "day,register_code,register_name,tender_type,payment_count,payments,reversal_count,reversals,net"
    );
    expect(lines[1]).toBe(
      `2026-09-10,'=1+1,"'@SUM(A1),""x""",cash,1,50000.00,0,0.00,50000.00`
    );
  });

  test("cash-up CSV: a negative variance stays a bare number while a text cell cannot smuggle a formula", () => {
    const report: CashUpReport = {
      ...envelope,
      items: [
        {
          day: "2026-09-10",
          sessionId: "s",
          registerId: REGISTER,
          registerCode: "-R1",
          registerName: null,
          cashierTenantUserId: "u",
          tenderType: "cash",
          expected: "40000.00",
          counted: "39000.00",
          adjustment: "0.00",
          countedWithCorrections: "39000.00",
          variance: "-1000.00"
        }
      ],
      sessionCount: 1,
      totalVariance: "-1000.00",
      totalShort: "-1000.00",
      totalOver: "0.00"
    };
    const row = serializeCashUpVarianceCsv(report).split("\r\n")[1]!;
    expect(row).toBe(
      "2026-09-10,s,'-R1,,u,cash,40000.00,39000.00,0.00,-1000.00"
    );
  });

  test("expense CSV neutralises a tenant-typed category name", () => {
    const report: ExpenseReport = {
      ...envelope,
      items: [
        {
          day: "2026-09-10",
          categoryId: "c",
          categoryName: '=HYPERLINK("http://x")',
          tenderType: "cash",
          postedCount: 1,
          posted: "5.00",
          reversedCount: 0,
          reversed: "0.00",
          net: "5.00"
        }
      ],
      summary: [],
      totalPosted: "5.00",
      totalReversed: "0.00",
      totalNet: "5.00"
    };
    const row = serializeExpenseReportCsv(report).split("\r\n")[1]!;
    expect(row.startsWith(`2026-09-10,"'=HYPERLINK(""http://x"")",cash,`)).toBe(
      true
    );
  });

  test("loyalty and stored-value CSVs carry only day, bucket and sums", () => {
    const loyalty: LoyaltyReport = {
      ...envelope,
      items: [
        { day: "2026-09-10", bucket: "redeem", entries: 1, points: "-30" }
      ],
      summary: [],
      openingPoints: "0",
      movementPoints: "-30",
      closingPoints: "-30"
    };
    expect(serializeLoyaltyReportCsv(loyalty)).toBe(
      "day,bucket,entries,points\r\n2026-09-10,redeem,1,-30\r\n"
    );
    const stored: StoredValueReport = {
      ...envelope,
      items: [
        {
          day: "2026-09-10",
          accountKind: "gift_card",
          bucket: "issue",
          entries: 2,
          amount: "100.00"
        }
      ],
      summary: [],
      balances: [],
      totalClosing: "100.00"
    };
    expect(serializeStoredValueReportCsv(stored)).toBe(
      "day,account_kind,bucket,entries,amount\r\n2026-09-10,gift_card,issue,2,100.00\r\n"
    );
  });

  test("an empty report is a header row only", () => {
    const empty: LoyaltyReport = {
      ...envelope,
      enabled: false,
      items: [],
      summary: [],
      openingPoints: "0",
      movementPoints: "0",
      closingPoints: "0"
    };
    expect(serializeLoyaltyReportCsv(empty)).toBe(
      "day,bucket,entries,points\r\n"
    );
  });
});

describe("projection registry", () => {
  const modules = listModules();
  const commerce = modules.find((module) => module.key === "commerce")!;
  const descriptors = (commerce.reportingProjections ?? []).filter(
    (descriptor) => descriptor.key.startsWith("commerce.pos_")
  );

  test("the registry gate accepts the whole registry with the five new descriptors", () => {
    const result = validateProjectionRegistry(modules);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("exactly the five descriptors are contributed, one per family", () => {
    expect(descriptors.map((descriptor) => descriptor.key).sort()).toEqual(
      [...OPERATIONAL_REPORT_PROJECTION_KEYS].sort()
    );
    expect(
      OPERATIONAL_REPORT_FAMILIES.map((f) => f.projectionKey).sort()
    ).toEqual([...OPERATIONAL_REPORT_PROJECTION_KEYS].sort());
  });

  test("every stream with a nullable cursor reads a view that excludes the NULL rows", () => {
    for (const descriptor of descriptors) {
      if (descriptor.source.strategy !== "cursor_table") {
        throw new Error("expected cursor_table");
      }
      for (const stream of descriptor.source.streams) {
        // A table whose cursor can be NULL would break the engine's rebuild
        // scan (it has no `IS NOT NULL` predicate), so those four columns are
        // only ever scanned through the views that filter the NULLs out.
        if (
          ["settled_at", "decided_at", "posted_at", "reversed_at"].includes(
            stream.cursorColumn
          )
        ) {
          expect(stream.tableName).toStartWith("awcms_commerce_report_src_");
        } else {
          expect(stream.cursorColumn).toBe("created_at");
        }
        expect(stream.dimensional).toBeDefined();
      }
    }
  });

  test("a rebuild replays exactly the streams the steady state reads", () => {
    for (const descriptor of descriptors) {
      if (descriptor.source.strategy !== "cursor_table") continue;
      expect(descriptor.rebuildSource.streams.map((s) => s.streamKey)).toEqual(
        descriptor.source.streams.map((s) => s.streamKey)
      );
    }
  });

  test("the family registry's features are real commerce features and only the ledgers gated by an opt-in have one", () => {
    const byFamily = Object.fromEntries(
      OPERATIONAL_REPORT_FAMILIES.map((f) => [f.family, f.feature])
    );
    expect(byFamily).toEqual({
      tenders: null,
      "cash-ups": "register",
      expenses: "expenses",
      loyalty: "loyalty",
      "stored-value": "storedValue",
      returns: "returns"
    });
  });
});

describe("returns & refunds deltas (Issue #316)", () => {
  const recorded = new Date("2026-09-10T18:30:00.000Z"); // 01:30 next day in Asia/Jakarta

  test("a return lands on its recorded local day, on the original sale's register, with its refund total in cents", () => {
    expect(
      computeReturnDelta({
        kind: "return",
        refundTotal: "12500.50",
        createdAt: recorded,
        registerId: REGISTER
      })
    ).toEqual({
      day: "2026-09-11",
      registerId: REGISTER,
      section: "return",
      bucket: "return",
      detail: "",
      count: 1,
      units: 0,
      cents: 1_250_050n
    });
  });

  test("an unstamped sale lands on the no-register sentinel and an unknown kind is skipped", () => {
    expect(
      computeReturnDelta({
        kind: "exchange",
        refundTotal: "0.00",
        createdAt: recorded,
        registerId: null
      })?.registerId
    ).toBe(OPERATIONAL_NO_REGISTER_ID);
    expect(
      computeReturnDelta({
        kind: "mystery",
        refundTotal: "1.00",
        createdAt: recorded,
        registerId: null
      })
    ).toBeNull();
  });

  test("a returned line adds its units and refunded value to its disposition bucket", () => {
    expect(
      computeReturnLineDelta({
        disposition: "damaged",
        quantity: 3,
        refundAmount: "9000.00",
        createdAt: recorded,
        registerId: REGISTER
      })
    ).toMatchObject({
      section: "disposition",
      bucket: "damaged",
      count: 1,
      units: 3,
      cents: 900_000n
    });
    expect(
      computeReturnLineDelta({
        disposition: "lost",
        quantity: 1,
        refundAmount: "1.00",
        createdAt: recorded,
        registerId: null
      })
    ).toBeNull();
  });

  const leg = {
    kind: "reversal",
    status: "succeeded",
    settledAt: new Date("2026-09-10T03:00:00.000Z"),
    tenderType: "cash",
    amount: "4000.00",
    destination: "original_tender",
    registerId: REGISTER
  };

  test("only a succeeded reversal that a refund points at is a refund leg", () => {
    expect(computeRefundLegDelta(leg)).toEqual({
      day: "2026-09-10",
      registerId: REGISTER,
      section: "refund",
      bucket: "cash",
      detail: "original_tender",
      count: 1,
      units: 0,
      cents: 400_000n
    });
    expect(computeRefundLegDelta({ ...leg, kind: "payment" })).toBeNull();
    expect(computeRefundLegDelta({ ...leg, status: "failed" })).toBeNull();
    expect(computeRefundLegDelta({ ...leg, settledAt: null })).toBeNull();
    // a cancellation reversal has no refund behind it: the tender report's, not this one's
    expect(computeRefundLegDelta({ ...leg, destination: null })).toBeNull();
  });

  test("a store-credit refund keeps its destination apart from the tender it came from", () => {
    expect(
      computeRefundLegDelta({ ...leg, destination: "store_credit" })?.detail
    ).toBe("store_credit");
  });

  test("restocked and written-off units are counted apart, quarantine neither", () => {
    expect(
      summariseDispositionUnits([
        { bucket: "restock", units: 4 },
        { bucket: "damaged", units: 2 },
        { bucket: "quarantine", units: 1 },
        { bucket: "restock", units: 1 }
      ])
    ).toEqual({ restocked: 5, writtenOff: 2, quarantined: 1 });
  });

  const returnsEnvelope = {
    from: "2026-09-01",
    to: "2026-09-30",
    timeZone: "Asia/Jakarta",
    enabled: true
  };
  const row = (
    over: Partial<ReturnsReport["items"][number]>
  ): ReturnsReport["items"][number] => ({
    day: "2026-09-10",
    registerId: null,
    registerCode: null,
    registerName: null,
    section: "return",
    bucket: "return",
    detail: "",
    count: 1,
    units: 0,
    amount: "0.00",
    ...over
  });

  test("the range summary folds exact cents and splits refunds by destination", () => {
    const folded = summariseReturns([
      row({ amount: "0.10" }),
      row({ day: "2026-09-11", amount: "0.20" }),
      row({
        section: "disposition",
        bucket: "restock",
        units: 2,
        amount: "5.00"
      }),
      row({
        section: "disposition",
        bucket: "damaged",
        units: 1,
        amount: "2.50"
      }),
      row({
        section: "refund",
        bucket: "cash",
        detail: "original_tender",
        amount: "4.00"
      }),
      row({
        section: "refund",
        bucket: "cash",
        detail: "store_credit",
        amount: "1.25"
      })
    ]);
    expect(folded.returnCount).toBe(2);
    expect(folded.returnedValue).toBe("0.30");
    expect(folded.refundedToTender).toBe("4.00");
    expect(folded.refundedToStoreCredit).toBe("1.25");
    expect(folded.refundedTotal).toBe("5.25");
    expect(folded.restockedUnits).toBe(2);
    expect(folded.writtenOffUnits).toBe(1);
    expect(folded.quarantinedUnits).toBe(0);
  });

  test("the CSV is one long file and neutralises a tenant-typed register name", () => {
    const report: ReturnsReport = {
      ...returnsEnvelope,
      items: [
        row({
          registerCode: "R1",
          registerName: "=cmd|' /C calc'!A0",
          amount: "10.00"
        })
      ],
      summary: [],
      returnCount: 1,
      returnedValue: "10.00",
      refundedTotal: "0.00",
      refundedToTender: "0.00",
      refundedToStoreCredit: "0.00",
      restockedUnits: 0,
      writtenOffUnits: 0,
      quarantinedUnits: 0
    };
    const [header, line] = serializeReturnsReportCsv(report).split("\r\n");
    expect(header).toBe(
      "day,register_code,register_name,section,bucket,detail,count,units,amount"
    );
    expect(line!.startsWith("2026-09-10,R1,'=cmd|' /C calc'!A0,")).toBe(true);
    expect(line!.endsWith(",return,return,,1,0,10.00")).toBe(true);
  });
});
