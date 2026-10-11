/**
 * CRM segment request validation, member masking, cursor and CSV shaping
 * (Issue #360, ADR-0042). Pure - no database, no clock, no I/O. The rule
 * vocabulary itself lives in `segment-rules.ts`; this file wraps it in the
 * request shapes the routes accept and holds the small pure helpers around a
 * member list.
 */
import { csvCell } from "./register-cash-up-csv";
import { maskPhone } from "./phone-normalisation";
import { isUuid } from "./register";
import {
  validateSegmentRules,
  type SegmentNode,
  type SegmentRuleError,
  type SegmentRuleStats
} from "./segment-rules";

export type SegmentValidation<T> =
  { valid: true; value: T } | { valid: false; errors: SegmentRuleError[] };

/** The evaluation limits (control C-26). Tuning a number is an ordinary change; adding an unbounded path is not. */
export const SEGMENT_EVALUATION_LIMITS = {
  /** Cut a statement off after this long; the answer is the stable `SEGMENT_TOO_EXPENSIVE` code. */
  statementTimeoutMs: 5000,
  /** Concurrent evaluations one tenant may run. */
  tenantConcurrency: 2,
  /** Concurrent evaluations one actor may run. */
  actorConcurrency: 1,
  /** Previews one actor may request per minute (an in-process throttle on top of the concurrency cap). */
  previewsPerMinutePerActor: 30,
  /** Rows in the preview sample - bounded and not pageable. */
  sampleSize: 10,
  defaultPageSize: 50,
  maxPageSize: 100,
  /** Rows in one CSV export. */
  maxExportRows: 10_000
} as const;

export const SEGMENT_NAME_MAX = 120;
export const SEGMENT_DESCRIPTION_MAX = 500;

export type CreateSegmentInput = {
  name: string;
  description: string | null;
  node: SegmentNode;
  canonicalRules: Record<string, unknown>;
  stats: SegmentRuleStats;
};

export type UpdateSegmentInput = {
  /** The version the edit started from; a mismatch is a 409, never a silent overwrite. */
  baseVersion: number;
  name?: string;
  description?: string | null;
  rules?: {
    node: SegmentNode;
    canonicalRules: Record<string, unknown>;
    stats: SegmentRuleStats;
  };
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateName(raw: unknown, errors: SegmentRuleError[]): string | null {
  if (typeof raw !== "string") {
    errors.push({ field: "name", message: "name must be a string." });
    return null;
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > SEGMENT_NAME_MAX) {
    errors.push({
      field: "name",
      message: `name must be 1 to ${SEGMENT_NAME_MAX} characters.`
    });
    return null;
  }
  return name;
}

function validateDescription(
  raw: unknown,
  errors: SegmentRuleError[]
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    errors.push({
      field: "description",
      message: "description must be a string or null."
    });
    return undefined;
  }
  const description = raw.trim();
  if (description.length === 0) return null;
  if (description.length > SEGMENT_DESCRIPTION_MAX) {
    errors.push({
      field: "description",
      message: `description may be at most ${SEGMENT_DESCRIPTION_MAX} characters.`
    });
    return undefined;
  }
  return description;
}

const CREATE_KEYS = new Set(["name", "description", "rules"]);
const UPDATE_KEYS = new Set(["name", "description", "rules", "baseVersion"]);

/**
 * `POST /segments`. A body key outside the allow-list - a `tenantId`, a
 * `segmentId`, anything - is refused by name rather than ignored in silence
 * (C-25: a foreign tenant id in the body must not be honoured).
 */
export function validateCreateSegmentInput(
  body: unknown
): SegmentValidation<CreateSegmentInput> {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Body must be a JSON object." }]
    };
  }
  const errors: SegmentRuleError[] = [];
  for (const key of Object.keys(body)) {
    if (!CREATE_KEYS.has(key)) {
      errors.push({
        field: key,
        message: `Unknown field "${key.slice(0, 40)}".`
      });
    }
  }
  const name = validateName(body.name, errors);
  const description = validateDescription(body.description, errors);
  const rules = validateSegmentRules(body.rules);
  if (!rules.valid) errors.push(...rules.errors);
  if (errors.length > 0 || name === null || !rules.valid) {
    return { valid: false, errors };
  }
  return {
    valid: true,
    value: {
      name,
      description: description ?? null,
      node: rules.node,
      canonicalRules: rules.canonical,
      stats: rules.stats
    }
  };
}

/** `PATCH /segments/{id}` - a rename and/or a new rule version. */
export function validateUpdateSegmentInput(
  body: unknown
): SegmentValidation<UpdateSegmentInput> {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Body must be a JSON object." }]
    };
  }
  const errors: SegmentRuleError[] = [];
  for (const key of Object.keys(body)) {
    if (!UPDATE_KEYS.has(key)) {
      errors.push({
        field: key,
        message: `Unknown field "${key.slice(0, 40)}".`
      });
    }
  }
  const baseVersion = body.baseVersion;
  if (
    typeof baseVersion !== "number" ||
    !Number.isInteger(baseVersion) ||
    baseVersion < 1
  ) {
    errors.push({
      field: "baseVersion",
      message:
        "baseVersion must be the integer version number this edit started from."
    });
  }
  const value: UpdateSegmentInput = {
    baseVersion: typeof baseVersion === "number" ? baseVersion : 0
  };
  if (body.name !== undefined) {
    const name = validateName(body.name, errors);
    if (name !== null) value.name = name;
  }
  if (body.description !== undefined) {
    const description = validateDescription(body.description, errors);
    if (description !== undefined) value.description = description;
  }
  if (body.rules !== undefined) {
    const rules = validateSegmentRules(body.rules);
    if (rules.valid) {
      value.rules = {
        node: rules.node,
        canonicalRules: rules.canonical,
        stats: rules.stats
      };
    } else {
      errors.push(...rules.errors);
    }
  }
  if (
    errors.length === 0 &&
    value.name === undefined &&
    value.description === undefined &&
    value.rules === undefined
  ) {
    errors.push({
      field: "body",
      message: "Send at least one of name, description or rules."
    });
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true, value };
}

export type SegmentPreviewRequest =
  | { kind: "rules"; node: SegmentNode; stats: SegmentRuleStats }
  | { kind: "version"; segmentId: string; version: number | null };

/**
 * `POST /segments/preview` - either an unsaved rule tree, or a saved segment
 * (optionally a specific version). Never both: one body, one meaning.
 */
export function validateSegmentPreviewRequest(
  body: unknown
): SegmentValidation<SegmentPreviewRequest> {
  if (!isPlainObject(body)) {
    return {
      valid: false,
      errors: [{ field: "body", message: "Body must be a JSON object." }]
    };
  }
  const errors: SegmentRuleError[] = [];
  for (const key of Object.keys(body)) {
    if (!["rules", "segmentId", "version"].includes(key)) {
      errors.push({
        field: key,
        message: `Unknown field "${key.slice(0, 40)}".`
      });
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  if (body.rules !== undefined) {
    if (body.segmentId !== undefined || body.version !== undefined) {
      return {
        valid: false,
        errors: [
          {
            field: "rules",
            message:
              "Send either rules or segmentId (with an optional version), not both."
          }
        ]
      };
    }
    const rules = validateSegmentRules(body.rules);
    if (!rules.valid) return { valid: false, errors: rules.errors };
    return {
      valid: true,
      value: { kind: "rules", node: rules.node, stats: rules.stats }
    };
  }

  if (!isUuid(body.segmentId)) {
    return {
      valid: false,
      errors: [
        {
          field: "segmentId",
          message: "Send rules, or the segmentId of a saved segment."
        }
      ]
    };
  }
  let version: number | null = null;
  if (body.version !== undefined && body.version !== null) {
    if (
      typeof body.version !== "number" ||
      !Number.isInteger(body.version) ||
      body.version < 1
    ) {
      return {
        valid: false,
        errors: [
          { field: "version", message: "version must be a positive integer." }
        ]
      };
    }
    version = body.version;
  }
  return {
    valid: true,
    value: { kind: "version", segmentId: body.segmentId, version }
  };
}

export type SegmentMembersQuery = {
  version: number | null;
  cursor: string | null;
  limit: number;
};

/** `?version=&cursor=&limit=` of the members list. */
export function parseSegmentMembersQuery(
  params: URLSearchParams
): SegmentValidation<SegmentMembersQuery> {
  const errors: SegmentRuleError[] = [];
  const versionRaw = params.get("version");
  let version: number | null = null;
  if (versionRaw !== null && versionRaw !== "") {
    const parsed = Number(versionRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({
        field: "version",
        message: "version must be a positive integer."
      });
    } else {
      version = parsed;
    }
  }
  const cursorRaw = params.get("cursor");
  let cursor: string | null = null;
  if (cursorRaw !== null && cursorRaw !== "") {
    cursor = decodeMemberCursor(cursorRaw);
    if (cursor === null) {
      errors.push({ field: "cursor", message: "cursor is malformed." });
    }
  }
  const limitRaw = params.get("limit");
  let limit: number = SEGMENT_EVALUATION_LIMITS.defaultPageSize;
  if (limitRaw !== null && limitRaw !== "") {
    const parsed = Number(limitRaw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > SEGMENT_EVALUATION_LIMITS.maxPageSize
    ) {
      errors.push({
        field: "limit",
        message: `limit must be an integer 1..${SEGMENT_EVALUATION_LIMITS.maxPageSize}.`
      });
    } else {
      limit = parsed;
    }
  }
  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, value: { version, cursor, limit } };
}

/** The member cursor is the last customer id, opaque to the client. */
export function encodeMemberCursor(customerId: string): string {
  return Buffer.from(`m1|${customerId}`, "utf-8").toString("base64url");
}

export function decodeMemberCursor(raw: string): string | null {
  try {
    const text = Buffer.from(raw, "base64url").toString("utf-8");
    if (!text.startsWith("m1|")) return null;
    const id = text.slice(3);
    return isUuid(id) ? id : null;
  } catch {
    return null;
  }
}

/** `jo***@example.com` - enough to recognise, not enough to contact. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

export type SegmentMemberDto = {
  id: string;
  name: string;
  phoneMasked: string;
  emailMasked: string | null;
  level: number;
};

export function toMemberDto(row: {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  level: number;
}): SegmentMemberDto {
  return {
    id: row.id,
    name: row.name,
    phoneMasked: maskPhone(row.phone),
    emailMasked: row.email ? maskEmail(row.email) : null,
    level: row.level
  };
}

export const SEGMENT_MEMBER_CSV_COLUMNS = [
  "customer_id",
  "name",
  "phone_masked",
  "email_masked",
  "price_level"
] as const;

/**
 * The member CSV. Every tenant-typed cell (the customer's name) goes through
 * `csvCell`, which neutralises a spreadsheet formula; phone and e-mail are the
 * masked forms - an export never carries a contact detail a list would not.
 */
export function serializeSegmentMembersCsv(
  members: readonly SegmentMemberDto[]
): string {
  const lines = [SEGMENT_MEMBER_CSV_COLUMNS.join(",")];
  for (const member of members) {
    lines.push(
      [
        csvCell(member.id),
        csvCell(member.name),
        csvCell(member.phoneMasked),
        csvCell(member.emailMasked ?? ""),
        csvCell(String(member.level))
      ].join(",")
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
