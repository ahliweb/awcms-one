/**
 * CRM segment rules and request validation (Issue #360, ADR-0042; threat model
 * controls C-25, C-26, C-27). Pure - no database. Proves the vocabulary is
 * CLOSED (unknown field / operator / key / depth is refused with a message that
 * names the path), the bounds hold, an injection string has nowhere to live,
 * and the small pure helpers around a member list (suppression, cursor,
 * masking, formula-neutral CSV) behave.
 */
import { describe, expect, test } from "bun:test";

import {
  SEGMENT_EVALUATION_LIMITS,
  decodeMemberCursor,
  encodeMemberCursor,
  maskEmail,
  parseSegmentMembersQuery,
  serializeSegmentMembersCsv,
  toMemberDto,
  validateCreateSegmentInput,
  validateSegmentPreviewRequest,
  validateUpdateSegmentInput
} from "../src/modules/commerce/domain/segment";
import {
  BOOKING_RULE_FIELDS,
  FIELD_SPECS,
  SEGMENT_RULE_FIELDS,
  SEGMENT_RULE_LIMITS,
  SEGMENT_RULE_SCHEMA_VERSION,
  SEGMENT_SMALL_GROUP_THRESHOLD,
  segmentRuleFieldsFor,
  suppressSmallCount,
  usesBookingFields,
  validateSegmentRules
} from "../src/modules/commerce/domain/segment-rules";
import { segmentNeeds } from "../src/modules/commerce/application/segment-sql";

const leaf = (field: string, op: string, value?: unknown, extra = {}) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
  ...extra
});

function errorsOf(raw: unknown): { field: string; message: string }[] {
  const result = validateSegmentRules(raw);
  if (result.valid) throw new Error("expected the rules to be refused");
  return result.errors;
}

describe("the closed vocabulary (C-25)", () => {
  test("rule schema 1 is exactly the PRD 6.1 commerce list and nothing booking-derived (owner answer Q7)", () => {
    expect([...segmentRuleFieldsFor(1)].sort() as string[]).toEqual(
      [
        "customer_since",
        "first_order_date",
        "has_account",
        "has_email",
        "last_order_date",
        "level",
        "loyalty_balance",
        "order_count",
        "paid_spend"
      ].sort()
    );
    for (const name of segmentRuleFieldsFor(1)) {
      expect(name).not.toMatch(/stay|booking|reservation|check|show|cancel/);
    }
  });

  test("rule schema 2 adds exactly the five booking-derived fields (ADR-0051) and keeps every schema 1 field", () => {
    expect(SEGMENT_RULE_SCHEMA_VERSION).toBe(2);
    const added = segmentRuleFieldsFor(2).filter(
      (name) => !segmentRuleFieldsFor(1).includes(name)
    );
    expect([...added].sort() as string[]).toEqual(
      [
        "booking_count",
        "cancellation_count",
        "last_stay_date",
        "no_show_count",
        "stay_count"
      ].sort()
    );
    expect([...BOOKING_RULE_FIELDS].sort()).toEqual([...added].sort());
    // Superset: nothing of schema 1 disappears or changes its spec.
    for (const name of segmentRuleFieldsFor(1)) {
      expect(segmentRuleFieldsFor(2)).toContain(name);
      expect(FIELD_SPECS[name].since).toBe(1);
    }
    expect([...SEGMENT_RULE_FIELDS].sort()).toEqual(
      [...segmentRuleFieldsFor(2)].sort()
    );
  });

  test("every field/operator pair the table declares validates with a value of its type", () => {
    const samples: Record<string, unknown> = {
      level: 2,
      boolean: true,
      date: { daysAgo: 30 },
      count: 3,
      money: "150000.00",
      points: 100
    };
    for (const [field, spec] of Object.entries(FIELD_SPECS)) {
      for (const op of spec.operators) {
        let value: unknown = samples[spec.value];
        if (op === "in") value = [1, 2];
        if (op === "never") value = undefined;
        const result = validateSegmentRules(leaf(field, op, value));
        expect(result.valid).toBe(true);
      }
    }
  });

  test("an unknown field is refused and the message names the path and lists the allowed fields", () => {
    const errors = errorsOf({
      and: [leaf("level", "eq", 1), leaf("email_domain", "eq", 1)]
    });
    expect(errors[0]!.field).toBe("rules.and[1].field");
    expect(errors[0]!.message).toContain("order_count");
  });

  test("an unknown operator for a known field is refused", () => {
    expect(errorsOf(leaf("level", "gte", 2))[0]!.field).toBe("rules.op");
    expect(errorsOf(leaf("has_account", "in", [true]))[0]!.field).toBe(
      "rules.op"
    );
    expect(errorsOf(leaf("order_count", "contains", 1))[0]!.field).toBe(
      "rules.op"
    );
  });

  test("an unknown key anywhere is refused by name - a tenant id, a table, a column, a SQL fragment", () => {
    for (const key of [
      "tenantId",
      "tenant_id",
      "table",
      "column",
      "sql",
      "where"
    ]) {
      const errors = errorsOf({ ...leaf("level", "eq", 1), [key]: "x" });
      expect(errors[0]!.field).toBe(`rules.${key}`);
    }
    expect(
      errorsOf({ and: [leaf("level", "eq", 1)], tenantId: "t" })[0]!.message
    ).toContain("exactly one key");
  });

  test("injection strings stay data: a string where a typed scalar belongs is refused, never interpolated", () => {
    const attacks = [
      "1; DROP TABLE awcms_commerce_customers; --",
      "' OR '1'='1",
      "$1) OR (true",
      "\u0000"
    ];
    for (const attack of attacks) {
      expect(validateSegmentRules(leaf("level", "eq", attack)).valid).toBe(
        false
      );
      expect(
        validateSegmentRules(leaf("order_count", "gte", attack)).valid
      ).toBe(false);
      expect(
        validateSegmentRules(leaf("paid_spend", "gte", attack)).valid
      ).toBe(false);
      expect(
        validateSegmentRules(leaf("loyalty_balance", "eq", attack)).valid
      ).toBe(false);
      expect(
        validateSegmentRules(leaf("has_account", "eq", attack)).valid
      ).toBe(false);
      expect(
        validateSegmentRules(leaf("last_order_date", "before", attack)).valid
      ).toBe(false);
      // An attack in the field or the operator position is an unknown name.
      expect(validateSegmentRules(leaf(attack, "eq", 1)).valid).toBe(false);
      expect(validateSegmentRules(leaf("level", attack, 1)).valid).toBe(false);
    }
  });

  test("a prototype key does not reach the field table", () => {
    expect(validateSegmentRules(leaf("__proto__", "eq", 1)).valid).toBe(false);
    expect(validateSegmentRules(leaf("constructor", "eq", 1)).valid).toBe(
      false
    );
    expect(validateSegmentRules(leaf("toString", "eq", 1)).valid).toBe(false);
  });

  test("value shapes: a money JSON number, a bare date and an out-of-range level are refused", () => {
    expect(validateSegmentRules(leaf("paid_spend", "gte", 150000)).valid).toBe(
      false
    );
    expect(validateSegmentRules(leaf("paid_spend", "gte", "1e9")).valid).toBe(
      false
    );
    expect(validateSegmentRules(leaf("paid_spend", "gte", "-5")).valid).toBe(
      false
    );
    expect(
      validateSegmentRules(leaf("last_order_date", "before", "2026-01-31"))
        .valid
    ).toBe(false);
    expect(
      validateSegmentRules(leaf("last_order_date", "before", { daysAgo: -1 }))
        .valid
    ).toBe(false);
    expect(
      validateSegmentRules(
        leaf("last_order_date", "before", { daysAgo: 1, extra: 1 })
      ).valid
    ).toBe(false);
    expect(validateSegmentRules(leaf("level", "eq", 5)).valid).toBe(false);
    expect(validateSegmentRules(leaf("level", "in", [1, 1.5])).valid).toBe(
      false
    );
    expect(validateSegmentRules(leaf("order_count", "gte", 1.5)).valid).toBe(
      false
    );
    expect(
      validateSegmentRules(leaf("last_order_date", "never", 1)).valid
    ).toBe(false);
    expect(validateSegmentRules(leaf("level", "eq")).valid).toBe(false);
  });

  test("a window applies to order_count and paid_spend only, within bounds", () => {
    expect(
      validateSegmentRules(leaf("order_count", "gte", 2, { windowDays: 90 }))
        .valid
    ).toBe(true);
    expect(
      validateSegmentRules(
        leaf("paid_spend", "gte", "1.00", { windowDays: 30 })
      ).valid
    ).toBe(true);
    expect(
      validateSegmentRules(leaf("level", "eq", 1, { windowDays: 30 })).valid
    ).toBe(false);
    expect(
      validateSegmentRules(leaf("order_count", "gte", 2, { windowDays: 0 }))
        .valid
    ).toBe(false);
    expect(
      validateSegmentRules(
        leaf("order_count", "gte", 2, {
          windowDays: SEGMENT_RULE_LIMITS.maxWindowDays + 1
        })
      ).valid
    ).toBe(false);
  });

  test("the canonical form normalises: sorted unique levels, two-decimal money, ISO instants", () => {
    const levels = validateSegmentRules(leaf("level", "in", [3, 1, 3]));
    expect(levels.valid && levels.canonical).toEqual({
      field: "level",
      op: "in",
      value: [1, 3]
    });
    const money = validateSegmentRules(leaf("paid_spend", "gte", "150000.5"));
    expect(money.valid && money.canonical).toEqual({
      field: "paid_spend",
      op: "gte",
      value: "150000.50"
    });
    const date = validateSegmentRules(
      leaf("customer_since", "after", "2026-01-31T07:00:00+07:00")
    );
    expect(date.valid && date.canonical).toEqual({
      field: "customer_since",
      op: "after",
      value: "2026-01-31T00:00:00.000Z"
    });
  });
});

describe("the bounds (C-26)", () => {
  const nest = (depth: number): unknown => {
    let node: unknown = leaf("level", "eq", 1);
    for (let i = 0; i < depth; i += 1) node = { not: node };
    return node;
  };

  test("depth up to the bound validates; one more is refused with the path", () => {
    expect(validateSegmentRules(nest(SEGMENT_RULE_LIMITS.maxDepth)).valid).toBe(
      true
    );
    const errors = errorsOf(nest(SEGMENT_RULE_LIMITS.maxDepth + 1));
    expect(errors[0]!.message).toContain(String(SEGMENT_RULE_LIMITS.maxDepth));
  });

  test("a very deep hostile tree is refused without recursing to its end", () => {
    const result = validateSegmentRules(nest(5000));
    expect(result.valid).toBe(false);
  });

  test("the node count is bounded", () => {
    const children = Array.from({ length: 10 }, () => ({
      and: Array.from({ length: 4 }, () => leaf("level", "eq", 1))
    }));
    // 1 root + 10 groups + 40 leaves = 51 nodes.
    const errors = errorsOf({ or: children });
    expect(errors.some((e) => e.message.includes("nodes"))).toBe(true);
  });

  test("children per group are bounded and an empty group is refused", () => {
    const eleven = Array.from({ length: 11 }, () => leaf("level", "eq", 1));
    expect(validateSegmentRules({ and: eleven }).valid).toBe(false);
    expect(validateSegmentRules({ and: [] }).valid).toBe(false);
  });

  test("distinct windows are bounded (one aggregate each)", () => {
    const four = [7, 14, 30, 90].map((windowDays) =>
      leaf("order_count", "gte", 1, { windowDays })
    );
    expect(validateSegmentRules({ and: four }).valid).toBe(false);
    const repeated = [7, 7, 7, 7].map((windowDays) =>
      leaf("order_count", "gte", 1, { windowDays })
    );
    expect(validateSegmentRules({ and: repeated }).valid).toBe(true);
  });

  test("the serialised size is bounded", () => {
    const huge = {
      and: [leaf("level", "eq", 1)],
      padding: "x".repeat(SEGMENT_RULE_LIMITS.maxBytes)
    };
    expect(validateSegmentRules(huge).valid).toBe(false);
  });

  test("a non-object and a missing rule are refused", () => {
    for (const raw of [null, undefined, 3, "x", [], [leaf("level", "eq", 1)]]) {
      expect(validateSegmentRules(raw).valid).toBe(false);
    }
  });

  test("stats report nodes, depth and sorted windows", () => {
    const result = validateSegmentRules({
      and: [
        leaf("order_count", "gte", 1, { windowDays: 90 }),
        { not: leaf("paid_spend", "gte", "1.00", { windowDays: 30 }) }
      ]
    });
    expect(result.valid && result.stats).toEqual({
      nodeCount: 4,
      depth: 2,
      windows: [30, 90]
    });
  });
});

describe("segmentNeeds - which relations a rule reads", () => {
  const needs = (raw: unknown) => {
    const result = validateSegmentRules(raw);
    if (!result.valid) throw new Error("invalid");
    return segmentNeeds(result.node);
  };

  test("a customer-only rule joins nothing", () => {
    expect(needs(leaf("level", "eq", 1))).toEqual({
      facts: false,
      accounts: false,
      loyalty: false,
      bookings: false,
      decisions: false
    });
  });

  test("each fact family turns on exactly its relation", () => {
    expect(needs(leaf("has_account", "eq", true)).accounts).toBe(true);
    expect(needs(leaf("loyalty_balance", "gte", 1)).loyalty).toBe(true);
    for (const field of [
      "order_count",
      "paid_spend",
      "last_order_date",
      "first_order_date"
    ]) {
      const value =
        field === "paid_spend"
          ? "1.00"
          : field.endsWith("date")
            ? undefined
            : 1;
      const op = field.endsWith("date") ? "never" : "gte";
      expect(needs(leaf(field, op, value)).facts).toBe(true);
    }
  });

  test("booking-derived fields turn on only their own scan, never the order scan (ADR-0051)", () => {
    for (const field of ["booking_count", "stay_count"]) {
      expect(needs(leaf(field, "gte", 1))).toEqual({
        facts: false,
        accounts: false,
        loyalty: false,
        bookings: true,
        decisions: false
      });
    }
    expect(needs(leaf("last_stay_date", "never")).bookings).toBe(true);
    for (const field of ["no_show_count", "cancellation_count"]) {
      expect(needs(leaf(field, "gte", 1))).toEqual({
        facts: false,
        accounts: false,
        loyalty: false,
        bookings: false,
        decisions: true
      });
    }
  });
});

describe("rule schema 2 - the booking-derived fields (ADR-0051, C-29)", () => {
  const bookingLeaves = [
    leaf("booking_count", "gte", 1, { windowDays: 365 }),
    leaf("stay_count", "eq", 0),
    leaf("last_stay_date", "before", { daysAgo: 180 }),
    leaf("last_stay_date", "never"),
    leaf("no_show_count", "gt", 1, { windowDays: 730 }),
    leaf("cancellation_count", "lte", 2)
  ];

  test("each booking field validates under schema 2 and round-trips to its canonical form", () => {
    for (const raw of bookingLeaves) {
      const result = validateSegmentRules(raw);
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.canonical).toEqual(raw);
    }
  });

  test("the default schema is the current one", () => {
    expect(validateSegmentRules(bookingLeaves[0]).valid).toBe(
      validateSegmentRules(bookingLeaves[0], SEGMENT_RULE_SCHEMA_VERSION).valid
    );
  });

  test("a version written under schema 1 refuses every booking field and says which schema it needs", () => {
    for (const raw of bookingLeaves) {
      const result = validateSegmentRules(raw, 1);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors[0]!.field).toBe("rules.field");
        expect(result.errors[0]!.message).toContain("needs rule schema 2");
        expect(result.errors[0]!.message).toContain("schema 1");
      }
    }
    // Nested too: one booking leaf anywhere refuses the whole rule.
    expect(
      validateSegmentRules(
        { and: [leaf("level", "eq", 1), { not: bookingLeaves[1] }] },
        1
      ).valid
    ).toBe(false);
  });

  test("old rules are unchanged: every schema 1 rule validates under both schemas to the same tree and canonical form", () => {
    const old = [
      leaf("level", "in", [3, 1]),
      leaf("order_count", "gte", 2, { windowDays: 90 }),
      leaf("paid_spend", "gt", "1000.5"),
      leaf("last_order_date", "never"),
      leaf("loyalty_balance", "lt", -3),
      {
        and: [
          leaf("has_account", "eq", true),
          { or: [leaf("customer_since", "before", { daysAgo: 30 })] }
        ]
      }
    ];
    for (const raw of old) {
      const one = validateSegmentRules(raw, 1);
      const two = validateSegmentRules(raw, 2);
      expect(one.valid && two.valid).toBe(true);
      if (one.valid && two.valid) {
        expect(two.node).toEqual(one.node);
        expect(two.canonical).toEqual(one.canonical);
        expect(two.stats).toEqual(one.stats);
      }
    }
  });

  test("the schema 1 error for an unknown field lists only schema 1 fields", () => {
    const result = validateSegmentRules(leaf("email_domain", "eq", 1), 1);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]!.message).toContain("order_count");
      expect(result.errors[0]!.message).not.toContain("stay_count");
    }
    const two = validateSegmentRules(leaf("email_domain", "eq", 1));
    if (!two.valid) expect(two.errors[0]!.message).toContain("stay_count");
  });

  test("booking counts take windows like order_count, share the three-window bound, and last_stay_date takes none", () => {
    expect(
      validateSegmentRules({
        and: [
          leaf("order_count", "gte", 1, { windowDays: 30 }),
          leaf("booking_count", "gte", 1, { windowDays: 90 }),
          leaf("stay_count", "gte", 1, { windowDays: 365 }),
          leaf("no_show_count", "gte", 1, { windowDays: 730 })
        ]
      }).valid
    ).toBe(false);
    expect(
      validateSegmentRules({
        and: [
          leaf("booking_count", "gte", 1, { windowDays: 90 }),
          leaf("no_show_count", "gte", 1, { windowDays: 90 }),
          leaf("stay_count", "gte", 1, { windowDays: 365 })
        ]
      }).valid
    ).toBe(true);
    expect(
      errorsOf(
        leaf("last_stay_date", "before", { daysAgo: 1 }, { windowDays: 30 })
      )[0]!.field
    ).toBe("rules.windowDays");
  });

  test("operands stay typed: a string, a float, a negative count and an unknown operator are refused for the new fields", () => {
    for (const bad of ["3", 1.5, -1, null]) {
      for (const field of [
        "booking_count",
        "stay_count",
        "no_show_count",
        "cancellation_count"
      ]) {
        expect(validateSegmentRules(leaf(field, "gte", bad)).valid).toBe(false);
      }
    }
    expect(errorsOf(leaf("stay_count", "before", 1))[0]!.field).toBe(
      "rules.op"
    );
    expect(errorsOf(leaf("last_stay_date", "gte", 1))[0]!.field).toBe(
      "rules.op"
    );
    expect(
      validateSegmentRules(leaf("last_stay_date", "before", "2026-01-31")).valid
    ).toBe(false);
    expect(validateSegmentRules(leaf("last_stay_date", "never", 1)).valid).toBe(
      false
    );
  });

  test("injection strings stay data in the new fields too", () => {
    for (const attack of ["1; DROP TABLE x", "' OR 1=1 --", "stay_count"]) {
      for (const field of [
        "booking_count",
        "stay_count",
        "no_show_count",
        "cancellation_count"
      ]) {
        expect(validateSegmentRules(leaf(field, "gte", attack)).valid).toBe(
          false
        );
      }
      expect(
        validateSegmentRules(leaf("last_stay_date", "before", attack)).valid
      ).toBe(false);
    }
  });

  test("usesBookingFields sees a booking leaf at any depth and only those", () => {
    const parse = (raw: unknown) => {
      const result = validateSegmentRules(raw);
      if (!result.valid) throw new Error("invalid");
      return result.node;
    };
    expect(usesBookingFields(parse(leaf("order_count", "gte", 1)))).toBe(false);
    expect(usesBookingFields(parse(bookingLeaves[1]))).toBe(true);
    expect(
      usesBookingFields(
        parse({
          and: [
            leaf("level", "eq", 1),
            { or: [{ not: leaf("no_show_count", "gt", 0) }] }
          ]
        })
      )
    ).toBe(true);
  });

  test("create and update stamp the current schema on the version they write", () => {
    const created = validateCreateSegmentInput({
      name: "Win back",
      rules: bookingLeaves[2]
    });
    expect(created.valid && created.value.ruleSchemaVersion).toBe(
      SEGMENT_RULE_SCHEMA_VERSION
    );
    const updated = validateUpdateSegmentInput({
      baseVersion: 1,
      rules: bookingLeaves[1]
    });
    expect(updated.valid && updated.value.rules?.ruleSchemaVersion).toBe(
      SEGMENT_RULE_SCHEMA_VERSION
    );
  });
});

describe("small-group suppression (C-27)", () => {
  test("a count under the threshold is withheld, never a number", () => {
    expect(SEGMENT_SMALL_GROUP_THRESHOLD).toBe(5);
    for (const count of [0, 1, 4]) {
      expect(suppressSmallCount(count)).toEqual({
        suppressed: true,
        count: null,
        label: "fewer_than_5"
      });
    }
    expect(suppressSmallCount(5)).toEqual({ suppressed: false, count: 5 });
    expect(suppressSmallCount(100000)).toEqual({
      suppressed: false,
      count: 100000
    });
  });
});

describe("request validation", () => {
  const rules = { and: [leaf("level", "eq", 2)] };

  test("create accepts a name, a description and rules, and trims", () => {
    const result = validateCreateSegmentInput({
      name: "  VIP  ",
      description: " d ",
      rules
    });
    expect(result.valid && result.value.name).toBe("VIP");
    expect(result.valid && result.value.description).toBe("d");
  });

  test("a foreign tenant id or any other key in the body is refused by name, never honoured (S in F8)", () => {
    const result = validateCreateSegmentInput({
      name: "x",
      rules,
      tenantId: "00000000-0000-4000-8000-000000000001"
    });
    expect(result.valid).toBe(false);
    expect(!result.valid && result.errors[0]!.field).toBe("tenantId");
  });

  test("create refuses a missing or oversized name and bad rules together", () => {
    const result = validateCreateSegmentInput({
      name: "",
      rules: { field: "nope" }
    });
    expect(!result.valid && result.errors.map((e) => e.field)).toEqual([
      "name",
      "rules.field"
    ]);
    expect(
      validateCreateSegmentInput({ name: "x".repeat(121), rules }).valid
    ).toBe(false);
    expect(validateCreateSegmentInput("x").valid).toBe(false);
  });

  test("update needs a baseVersion and something to change", () => {
    expect(validateUpdateSegmentInput({ name: "x" }).valid).toBe(false);
    expect(validateUpdateSegmentInput({ baseVersion: 1 }).valid).toBe(false);
    expect(
      validateUpdateSegmentInput({ baseVersion: 0, name: "x" }).valid
    ).toBe(false);
    const ok = validateUpdateSegmentInput({ baseVersion: 2, rules });
    expect(ok.valid && ok.value.baseVersion).toBe(2);
    expect(
      validateUpdateSegmentInput({ baseVersion: 1, name: "x", segmentId: "y" })
        .valid
    ).toBe(false);
  });

  test("preview takes rules XOR a saved segment, never both", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    expect(validateSegmentPreviewRequest({ rules }).valid).toBe(true);
    const saved = validateSegmentPreviewRequest({ segmentId: id, version: 3 });
    expect(saved.valid && saved.value).toEqual({
      kind: "version",
      segmentId: id,
      version: 3
    });
    expect(validateSegmentPreviewRequest({ rules, segmentId: id }).valid).toBe(
      false
    );
    expect(validateSegmentPreviewRequest({ segmentId: "nope" }).valid).toBe(
      false
    );
    expect(
      validateSegmentPreviewRequest({ segmentId: id, version: 0 }).valid
    ).toBe(false);
    expect(
      validateSegmentPreviewRequest({ rules, asOf: "2020-01-01" }).valid
    ).toBe(false);
    expect(validateSegmentPreviewRequest({}).valid).toBe(false);
  });

  test("a client cannot supply the as-of: the request shapes have no such key", () => {
    const result = validateSegmentPreviewRequest({
      rules,
      asOf: "2020-01-01T00:00:00Z"
    });
    expect(!result.valid && result.errors[0]!.field).toBe("asOf");
  });
});

describe("members query, cursor, masking, CSV", () => {
  const id = "00000000-0000-4000-8000-000000000042";

  test("the member cursor round-trips and a forged one is refused", () => {
    expect(decodeMemberCursor(encodeMemberCursor(id))).toBe(id);
    expect(decodeMemberCursor("not-base64-!!")).toBeNull();
    expect(
      decodeMemberCursor(Buffer.from("m1|not-a-uuid").toString("base64url"))
    ).toBeNull();
    expect(
      decodeMemberCursor(Buffer.from(`x|${id}`).toString("base64url"))
    ).toBeNull();
  });

  test("the members query bounds the page size", () => {
    const ok = parseSegmentMembersQuery(
      new URLSearchParams("limit=100&version=2")
    );
    expect(ok.valid && ok.value).toMatchObject({
      limit: 100,
      version: 2,
      cursor: null
    });
    expect(
      parseSegmentMembersQuery(new URLSearchParams("limit=101")).valid
    ).toBe(false);
    expect(parseSegmentMembersQuery(new URLSearchParams("limit=0")).valid).toBe(
      false
    );
    expect(
      parseSegmentMembersQuery(new URLSearchParams("version=x")).valid
    ).toBe(false);
    expect(
      parseSegmentMembersQuery(new URLSearchParams("cursor=zzz")).valid
    ).toBe(false);
    const defaults = parseSegmentMembersQuery(new URLSearchParams(""));
    expect(defaults.valid && defaults.value.limit).toBe(
      SEGMENT_EVALUATION_LIMITS.defaultPageSize
    );
  });

  test("a member is returned masked", () => {
    const dto = toMemberDto({
      id,
      name: "Siti",
      phone: "+6281234567890",
      email: "siti.aminah@example.com",
      level: 2
    });
    expect(dto.phoneMasked).not.toContain("1234567");
    expect(dto.phoneMasked.endsWith("7890")).toBe(true);
    expect(dto.emailMasked).toBe("si•••@example.com");
    expect(maskEmail("x")).toBe("•••");
  });

  test("the CSV neutralises a spreadsheet formula in a customer name and carries only masked contact fields", () => {
    const csv = serializeSegmentMembersCsv([
      toMemberDto({
        id,
        name: '=HYPERLINK("http://evil")',
        phone: "+6281234567890",
        email: null,
        level: 1
      }),
      toMemberDto({
        id,
        name: "Budi, S.",
        phone: "+6281234567891",
        email: "b@example.com",
        level: 3
      })
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "customer_id,name,phone_masked,email_masked,price_level"
    );
    expect(lines[1]).toContain("'=HYPERLINK");
    expect(lines[2]).toContain('"Budi, S."');
    expect(csv).not.toContain("+6281234567890");
    expect(csv).not.toContain("b@example.com");
  });
});
