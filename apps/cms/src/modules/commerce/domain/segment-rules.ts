/**
 * CRM segment rules (Issue #360, ADR-0042, PRD sections 4.5 and 6.1, threat
 * model F8 / controls C-25 and C-26) - a CLOSED, versioned JSON vocabulary and
 * its validator. Pure: no database, no clock, no I/O.
 *
 * ## Why a closed vocabulary and not an expression language
 *
 * A segment turns a rule into a list of people. If a client could name a
 * table, a column, an operator or a fragment of SQL, the rule would be a query
 * language and every defence below would be a filter over an open surface.
 * Instead the surface is a finite table (`FIELD_SPECS`): each field has a fixed
 * set of operators, a fixed value type and a fixed window rule, and
 * `application/segment-sql.ts` maps each (field, operator) pair to ONE literal
 * SQL template whose operands are bound parameters. A rule carries no tenant,
 * table or column name; an unknown key, field, operator, value shape or depth
 * above the bound is refused with a field-naming error before anything
 * reaches the database. Owner answer Q7: rule schema 1 is the PRD section 6.1
 * commerce vocabulary only; the booking-derived fields joined this table in
 * rule schema 2, with their own ADR (ADR-0051, Issue #390, after Wave C).
 *
 * ## Rule schema versions (control C-29, ADR-0051)
 *
 * The vocabulary is versioned. A stored segment version records the rule
 * schema it was written under (`rule_schema_version`, `sql/1060`) and is
 * re-validated under THAT schema whenever it is read: a version written under
 * schema 1 can never contain a field schema 2 added (it fails closed, it is not
 * evaluated differently), and a field's meaning is frozen per schema, so a past
 * campaign or earn stays explainable. Schema 2 is a strict superset of schema
 * 1 - every field, operator and value shape of schema 1 is unchanged - so old
 * rules evaluate exactly as before. New versions are written under
 * {@link SEGMENT_RULE_SCHEMA_VERSION}.
 *
 * ## Shape
 *
 * ```
 * node  = { and: node[] } | { or: node[] } | { not: node } | leaf
 * leaf  = { field, op, value?, windowDays? }
 * ```
 *
 * A node has exactly ONE of the keys `and`/`or`/`not`/`field`; a leaf has only
 * the keys its field allows. `value` is always a typed scalar (integer,
 * boolean, a money string, an ISO date-time, or `{ daysAgo }`) - there is no
 * free string anywhere in a rule, so an injection string has nowhere to live.
 *
 * ## Bounds (C-26)
 *
 * Depth, node count, children per group, distinct windows, serialised size:
 * see {@link SEGMENT_RULE_LIMITS}. They are checked here, before evaluation,
 * so a pathological rule is a `400`, not a slow query.
 */

import { normalizeMoney } from "./price-calculation";

export const SEGMENT_RULE_LIMITS = {
  /** Nesting levels of `and`/`or`/`not` (a bare leaf is depth 0). */
  maxDepth: 4,
  /** Every node, groups and leaves together. */
  maxNodes: 25,
  /** Children of one `and`/`or`. */
  maxChildren: 10,
  /** Distinct `windowDays` values across the whole rule (one aggregate each). */
  maxDistinctWindows: 3,
  /** Longest look-back window, in days (ten years). */
  maxWindowDays: 3650,
  /** Serialised JSON size of the whole rule. */
  maxBytes: 8192
} as const;

/** The rule schema new segment versions are written under. Bumping it is ADR-gated (ADR-0042 D2, ADR-0051). */
export const SEGMENT_RULE_SCHEMA_VERSION = 2;

/** Every schema the validator still understands: a stored version keeps the one it was written under. */
export type SegmentRuleSchemaVersion = 1 | 2;

export type SegmentRuleField =
  | "level"
  | "has_account"
  | "has_email"
  | "customer_since"
  | "order_count"
  | "paid_spend"
  | "last_order_date"
  | "first_order_date"
  | "loyalty_balance"
  // Rule schema 2 (ADR-0051): facts derived from the customer's booking links.
  | "booking_count"
  | "stay_count"
  | "last_stay_date"
  | "no_show_count"
  | "cancellation_count";

/** A count field: an integer compared with eq / gt / gte / lt / lte, optionally over a look-back window. */
export type SegmentCountField =
  | "order_count"
  | "booking_count"
  | "stay_count"
  | "no_show_count"
  | "cancellation_count";

/** A date field with a "never" operator. */
export type SegmentInstantField =
  "last_order_date" | "first_order_date" | "last_stay_date";

export type SegmentRuleOperator =
  "eq" | "in" | "gt" | "gte" | "lt" | "lte" | "before" | "after" | "never";

/** An absolute instant or a look-back resolved against the SERVER's as-of timestamp. */
export type SegmentDateValue =
  { kind: "at"; at: string } | { kind: "daysAgo"; daysAgo: number };

export type SegmentLeaf =
  | { type: "leaf"; field: "level"; op: "eq"; value: number }
  | { type: "leaf"; field: "level"; op: "in"; value: number[] }
  | { type: "leaf"; field: "has_account"; op: "eq"; value: boolean }
  | { type: "leaf"; field: "has_email"; op: "eq"; value: boolean }
  | {
      type: "leaf";
      field: "customer_since";
      op: "before" | "after";
      value: SegmentDateValue;
    }
  | {
      type: "leaf";
      field: SegmentCountField;
      op: "eq" | "gt" | "gte" | "lt" | "lte";
      value: number;
      windowDays: number | null;
    }
  | {
      type: "leaf";
      field: "paid_spend";
      op: "gt" | "gte" | "lt" | "lte";
      /** `numeric(14,2)` string (ADR-0003). */
      value: string;
      windowDays: number | null;
    }
  | {
      type: "leaf";
      field: SegmentInstantField;
      op: "before" | "after";
      value: SegmentDateValue;
    }
  | {
      type: "leaf";
      field: SegmentInstantField;
      op: "never";
    }
  | {
      type: "leaf";
      field: "loyalty_balance";
      op: "eq" | "gt" | "gte" | "lt" | "lte";
      value: number;
    };

export type SegmentNode =
  | SegmentLeaf
  | { type: "and"; children: SegmentNode[] }
  | { type: "or"; children: SegmentNode[] }
  | { type: "not"; child: SegmentNode };

export type SegmentRuleError = { field: string; message: string };

export type SegmentRuleResult =
  | {
      valid: true;
      node: SegmentNode;
      /** The canonical wire form that is stored (key order, sorted `in`, normalised money). */
      canonical: Record<string, unknown>;
      stats: SegmentRuleStats;
    }
  | { valid: false; errors: SegmentRuleError[] };

export type SegmentRuleStats = {
  nodeCount: number;
  depth: number;
  /** Distinct non-null `windowDays`, ascending. */
  windows: number[];
};

type FieldSpec = {
  /** The first rule schema that has this field; a rule under an older schema refuses it. */
  since: SegmentRuleSchemaVersion;
  operators: readonly SegmentRuleOperator[];
  /** Which `value` shape the field takes. */
  value: "level" | "boolean" | "date" | "count" | "money" | "points";
  /** `windowDays` is accepted (and optional) only here. */
  windowed: boolean;
};

/** The vocabulary. Adding a field here is an ADR-gated change (ADR-0042 D2). */
export const FIELD_SPECS: Readonly<Record<SegmentRuleField, FieldSpec>> = {
  level: { since: 1, operators: ["eq", "in"], value: "level", windowed: false },
  has_account: {
    since: 1,
    operators: ["eq"],
    value: "boolean",
    windowed: false
  },
  has_email: { since: 1, operators: ["eq"], value: "boolean", windowed: false },
  customer_since: {
    since: 1,
    operators: ["before", "after"],
    value: "date",
    windowed: false
  },
  order_count: {
    since: 1,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "count",
    windowed: true
  },
  paid_spend: {
    since: 1,
    operators: ["gt", "gte", "lt", "lte"],
    value: "money",
    windowed: true
  },
  last_order_date: {
    since: 1,
    operators: ["before", "after", "never"],
    value: "date",
    windowed: false
  },
  first_order_date: {
    since: 1,
    operators: ["before", "after", "never"],
    value: "date",
    windowed: false
  },
  loyalty_balance: {
    since: 1,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "points",
    windowed: false
  },
  // Rule schema 2 (ADR-0051). Counts are windowed like order_count; the window
  // is the booking instant (paid_at) for booking_count, the arrival for
  // stay_count and the decision instant for the other two.
  booking_count: {
    since: 2,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "count",
    windowed: true
  },
  stay_count: {
    since: 2,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "count",
    windowed: true
  },
  last_stay_date: {
    since: 2,
    operators: ["before", "after", "never"],
    value: "date",
    windowed: false
  },
  no_show_count: {
    since: 2,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "count",
    windowed: true
  },
  cancellation_count: {
    since: 2,
    operators: ["eq", "gt", "gte", "lt", "lte"],
    value: "count",
    windowed: true
  }
};

export const SEGMENT_RULE_FIELDS = Object.keys(
  FIELD_SPECS
) as SegmentRuleField[];

/** The fields a rule under `schemaVersion` may name. */
export function segmentRuleFieldsFor(
  schemaVersion: SegmentRuleSchemaVersion
): SegmentRuleField[] {
  return SEGMENT_RULE_FIELDS.filter(
    (name) => FIELD_SPECS[name].since <= schemaVersion
  );
}

/**
 * The booking-derived fields (rule schema 2): the ones that read the customer's
 * booking links, so defining, previewing or listing a segment that uses one is a
 * separate power (`commerce.booking_reservation_links.read`, ADR-0051 D5).
 */
export const BOOKING_RULE_FIELDS: ReadonlySet<SegmentRuleField> = new Set([
  "booking_count",
  "stay_count",
  "last_stay_date",
  "no_show_count",
  "cancellation_count"
]);

/** Whether any leaf of the tree reads a booking-derived fact. */
export function usesBookingFields(node: SegmentNode): boolean {
  switch (node.type) {
    case "leaf":
      return BOOKING_RULE_FIELDS.has(node.field);
    case "not":
      return usesBookingFields(node.child);
    case "and":
    case "or":
      return node.children.some(usesBookingFields);
  }
}

const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_COUNT = 1_000_000;
const MAX_POINTS = 1_000_000_000_000;
const LEAF_KEYS = new Set(["field", "op", "value", "windowDays"]);
const GROUP_KEYS = new Set(["and", "or", "not"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFieldName(value: unknown): value is SegmentRuleField {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(FIELD_SPECS, value)
  );
}

function parseDateValue(
  raw: unknown,
  path: string,
  errors: SegmentRuleError[]
): SegmentDateValue | null {
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    // A strict ISO date-time with a zone designator: a bare date is parsed in
    // the server's local zone by `Date.parse`, which would make the rule's
    // meaning depend on the host's TZ.
    if (
      Number.isNaN(parsed) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(
        raw
      )
    ) {
      errors.push({
        field: path,
        message:
          "value must be an ISO 8601 date-time with a zone (for example 2026-01-31T00:00:00Z) or an object { daysAgo }."
      });
      return null;
    }
    return { kind: "at", at: new Date(parsed).toISOString() };
  }
  if (isPlainObject(raw)) {
    const keys = Object.keys(raw);
    const days = raw.daysAgo;
    if (
      keys.length !== 1 ||
      keys[0] !== "daysAgo" ||
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 0 ||
      days > SEGMENT_RULE_LIMITS.maxWindowDays
    ) {
      errors.push({
        field: path,
        message: `value must be { "daysAgo": integer 0..${SEGMENT_RULE_LIMITS.maxWindowDays} } or an ISO 8601 date-time.`
      });
      return null;
    }
    return { kind: "daysAgo", daysAgo: days };
  }
  errors.push({
    field: path,
    message:
      "value must be an ISO 8601 date-time with a zone or an object { daysAgo }."
  });
  return null;
}

function parseInteger(
  raw: unknown,
  path: string,
  min: number,
  max: number,
  errors: SegmentRuleError[]
): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    errors.push({ field: path, message: "value must be an integer." });
    return null;
  }
  if (raw < min || raw > max) {
    errors.push({
      field: path,
      message: `value must be between ${min} and ${max}.`
    });
    return null;
  }
  return raw;
}

type Walk = {
  /** The rule schema the rule is validated under: a field newer than it is unknown. */
  schemaVersion: SegmentRuleSchemaVersion;
  nodeCount: number;
  maxDepth: number;
  windows: Set<number>;
  errors: SegmentRuleError[];
  /** Set once a bound is exceeded: stop descending so a hostile tree is not walked to its end. */
  halted: boolean;
};

function parseNode(
  raw: unknown,
  path: string,
  depth: number,
  walk: Walk
): { node: SegmentNode; canonical: Record<string, unknown> } | null {
  if (walk.halted) return null;
  walk.nodeCount += 1;
  if (walk.nodeCount > SEGMENT_RULE_LIMITS.maxNodes) {
    walk.errors.push({
      field: path,
      message: `A rule may contain at most ${SEGMENT_RULE_LIMITS.maxNodes} nodes.`
    });
    walk.halted = true;
    return null;
  }
  if (!isPlainObject(raw)) {
    walk.errors.push({
      field: path,
      message: "A rule node must be an object."
    });
    return null;
  }

  const keys = Object.keys(raw);
  const groupKeys = keys.filter((key) => GROUP_KEYS.has(key));

  if (groupKeys.length > 0) {
    if (keys.length !== 1) {
      walk.errors.push({
        field: path,
        message:
          "A group node has exactly one key: and, or or not - it cannot be mixed with other keys."
      });
      return null;
    }
    const groupKey = groupKeys[0]!;
    const nextDepth = depth + 1;
    if (nextDepth > SEGMENT_RULE_LIMITS.maxDepth) {
      walk.errors.push({
        field: `${path}.${groupKey}`,
        message: `Rules may nest at most ${SEGMENT_RULE_LIMITS.maxDepth} levels of and/or/not.`
      });
      walk.halted = true;
      return null;
    }
    walk.maxDepth = Math.max(walk.maxDepth, nextDepth);

    if (groupKey === "not") {
      const child = parseNode(raw.not, `${path}.not`, nextDepth, walk);
      if (!child) return null;
      return {
        node: { type: "not", child: child.node },
        canonical: { not: child.canonical }
      };
    }

    const list = raw[groupKey];
    if (!Array.isArray(list)) {
      walk.errors.push({
        field: `${path}.${groupKey}`,
        message: `${groupKey} must be an array of rule nodes.`
      });
      return null;
    }
    if (list.length < 1 || list.length > SEGMENT_RULE_LIMITS.maxChildren) {
      walk.errors.push({
        field: `${path}.${groupKey}`,
        message: `${groupKey} must hold between 1 and ${SEGMENT_RULE_LIMITS.maxChildren} nodes.`
      });
      return null;
    }
    const children: SegmentNode[] = [];
    const canonicalChildren: Record<string, unknown>[] = [];
    for (let index = 0; index < list.length; index += 1) {
      const child = parseNode(
        list[index],
        `${path}.${groupKey}[${index}]`,
        nextDepth,
        walk
      );
      if (child) {
        children.push(child.node);
        canonicalChildren.push(child.canonical);
      }
      if (walk.halted) return null;
    }
    if (children.length !== list.length) return null;
    return {
      node: { type: groupKey as "and" | "or", children },
      canonical: { [groupKey]: canonicalChildren }
    };
  }

  // Leaf.
  for (const key of keys) {
    if (!LEAF_KEYS.has(key)) {
      walk.errors.push({
        field: `${path}.${key}`,
        message: `Unknown key "${key.slice(0, 40)}". A leaf takes field, op, value and windowDays only.`
      });
      return null;
    }
  }
  if (!isFieldName(raw.field)) {
    walk.errors.push({
      field: `${path}.field`,
      message: `Unknown field. Allowed fields: ${segmentRuleFieldsFor(walk.schemaVersion).join(", ")}.`
    });
    return null;
  }
  if (FIELD_SPECS[raw.field].since > walk.schemaVersion) {
    // Not "unknown" to the vocabulary, but outside the schema this rule is read
    // under (a stored version keeps its own schema, C-29).
    walk.errors.push({
      field: `${path}.field`,
      message: `${raw.field} needs rule schema ${FIELD_SPECS[raw.field].since}; this rule is read under schema ${walk.schemaVersion}.`
    });
    return null;
  }
  const field = raw.field;
  const spec = FIELD_SPECS[field];
  const op = raw.op;
  if (
    typeof op !== "string" ||
    !(spec.operators as readonly string[]).includes(op)
  ) {
    walk.errors.push({
      field: `${path}.op`,
      message: `Operator is not allowed for ${field}. Allowed: ${spec.operators.join(", ")}.`
    });
    return null;
  }
  const operator = op as SegmentRuleOperator;

  let windowDays: number | null = null;
  if (raw.windowDays !== undefined && raw.windowDays !== null) {
    if (!spec.windowed) {
      walk.errors.push({
        field: `${path}.windowDays`,
        message: `${field} does not take a window.`
      });
      return null;
    }
    windowDays = parseInteger(
      raw.windowDays,
      `${path}.windowDays`,
      1,
      SEGMENT_RULE_LIMITS.maxWindowDays,
      walk.errors
    );
    if (windowDays === null) return null;
    walk.windows.add(windowDays);
    if (walk.windows.size > SEGMENT_RULE_LIMITS.maxDistinctWindows) {
      walk.errors.push({
        field: `${path}.windowDays`,
        message: `A rule may use at most ${SEGMENT_RULE_LIMITS.maxDistinctWindows} distinct windows.`
      });
      walk.halted = true;
      return null;
    }
  }

  const valuePath = `${path}.value`;

  if (operator === "never") {
    if (raw.value !== undefined && raw.value !== null) {
      walk.errors.push({
        field: valuePath,
        message: "The never operator takes no value."
      });
      return null;
    }
    return {
      node: {
        type: "leaf",
        field: field as SegmentInstantField,
        op: "never"
      },
      canonical: { field, op }
    };
  }

  if (raw.value === undefined) {
    walk.errors.push({ field: valuePath, message: "value is required." });
    return null;
  }

  switch (spec.value) {
    case "level": {
      if (operator === "in") {
        if (
          !Array.isArray(raw.value) ||
          raw.value.length < 1 ||
          raw.value.length > 4
        ) {
          walk.errors.push({
            field: valuePath,
            message: "value must be an array of 1 to 4 price levels."
          });
          return null;
        }
        const levels: number[] = [];
        for (let i = 0; i < raw.value.length; i += 1) {
          const level = parseInteger(
            raw.value[i],
            `${valuePath}[${i}]`,
            1,
            4,
            walk.errors
          );
          if (level === null) return null;
          levels.push(level);
        }
        const sorted = [...new Set(levels)].sort((a, b) => a - b);
        return {
          node: { type: "leaf", field: "level", op: "in", value: sorted },
          canonical: { field, op, value: sorted }
        };
      }
      const level = parseInteger(raw.value, valuePath, 1, 4, walk.errors);
      if (level === null) return null;
      return {
        node: { type: "leaf", field: "level", op: "eq", value: level },
        canonical: { field, op, value: level }
      };
    }
    case "boolean": {
      if (typeof raw.value !== "boolean") {
        walk.errors.push({
          field: valuePath,
          message: "value must be true or false."
        });
        return null;
      }
      return {
        node: {
          type: "leaf",
          field: field as "has_account" | "has_email",
          op: "eq",
          value: raw.value
        },
        canonical: { field, op, value: raw.value }
      };
    }
    case "date": {
      const date = parseDateValue(raw.value, valuePath, walk.errors);
      if (!date) return null;
      const canonicalValue =
        date.kind === "at" ? date.at : { daysAgo: date.daysAgo };
      if (field === "customer_since") {
        return {
          node: {
            type: "leaf",
            field: "customer_since",
            op: operator as "before" | "after",
            value: date
          },
          canonical: { field, op, value: canonicalValue }
        };
      }
      return {
        node: {
          type: "leaf",
          field: field as SegmentInstantField,
          op: operator as "before" | "after",
          value: date
        },
        canonical: { field, op, value: canonicalValue }
      };
    }
    case "count": {
      const count = parseInteger(
        raw.value,
        valuePath,
        0,
        MAX_COUNT,
        walk.errors
      );
      if (count === null) return null;
      return {
        node: {
          type: "leaf",
          field: field as SegmentCountField,
          op: operator as "eq" | "gt" | "gte" | "lt" | "lte",
          value: count,
          windowDays
        },
        canonical:
          windowDays === null
            ? { field, op, value: count }
            : { field, op, value: count, windowDays }
      };
    }
    case "money": {
      if (typeof raw.value !== "string" || !MONEY_PATTERN.test(raw.value)) {
        walk.errors.push({
          field: valuePath,
          message:
            'value must be a money string such as "150000.00" (a JSON number is refused).'
        });
        return null;
      }
      const money = normalizeMoney(raw.value);
      return {
        node: {
          type: "leaf",
          field: "paid_spend",
          op: operator as "gt" | "gte" | "lt" | "lte",
          value: money,
          windowDays
        },
        canonical:
          windowDays === null
            ? { field, op, value: money }
            : { field, op, value: money, windowDays }
      };
    }
    case "points": {
      const points = parseInteger(
        raw.value,
        valuePath,
        -MAX_POINTS,
        MAX_POINTS,
        walk.errors
      );
      if (points === null) return null;
      return {
        node: {
          type: "leaf",
          field: "loyalty_balance",
          op: operator as "eq" | "gt" | "gte" | "lt" | "lte",
          value: points
        },
        canonical: { field, op, value: points }
      };
    }
  }
}

/**
 * Validates a client-supplied rule tree against the closed vocabulary and
 * returns the typed tree plus its canonical stored form. Never throws on
 * hostile input: depth and size are bounded before recursion can run away.
 */
export function validateSegmentRules(
  raw: unknown,
  schemaVersion: SegmentRuleSchemaVersion = SEGMENT_RULE_SCHEMA_VERSION
): SegmentRuleResult {
  let size: number;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    return {
      valid: false,
      errors: [{ field: "rules", message: "rules must be plain JSON." }]
    };
  }
  if (size > SEGMENT_RULE_LIMITS.maxBytes) {
    return {
      valid: false,
      errors: [
        {
          field: "rules",
          message: `rules may be at most ${SEGMENT_RULE_LIMITS.maxBytes} bytes of JSON.`
        }
      ]
    };
  }
  if (raw === undefined || raw === null) {
    return {
      valid: false,
      errors: [{ field: "rules", message: "rules is required." }]
    };
  }

  const walk: Walk = {
    schemaVersion,
    nodeCount: 0,
    maxDepth: 0,
    windows: new Set(),
    errors: [],
    halted: false
  };
  const parsed = parseNode(raw, "rules", 0, walk);
  if (!parsed || walk.errors.length > 0) {
    return {
      valid: false,
      errors:
        walk.errors.length > 0
          ? walk.errors
          : [{ field: "rules", message: "rules is invalid." }]
    };
  }
  return {
    valid: true,
    node: parsed.node,
    canonical: parsed.canonical,
    stats: {
      nodeCount: walk.nodeCount,
      depth: walk.maxDepth,
      windows: [...walk.windows].sort((a, b) => a - b)
    }
  };
}

/** Counts below this are reported as "fewer than 5" (metrics section 8.5, threat model F8 small-group suppression). */
export const SEGMENT_SMALL_GROUP_THRESHOLD = 5;

export type SegmentCount =
  | { suppressed: false; count: number }
  | { suppressed: true; count: null; label: "fewer_than_5" };

/** C-27: a count under the threshold is withheld, never returned as a number. */
export function suppressSmallCount(count: number): SegmentCount {
  if (count < SEGMENT_SMALL_GROUP_THRESHOLD) {
    return { suppressed: true, count: null, label: "fewer_than_5" };
  }
  return { suppressed: false, count };
}
