/**
 * `practice_sessions` — the 12-field record from PRD §16 (`web-irmbydus.com`
 * `redesign/PRD_IRMbyDUS_v1.0.md`), Issue #270 / ADR-0002. Pure — no
 * database, no I/O.
 *
 * ## The 12 fields walk the five domains in order
 *
 * `situation` / `emotion` / `intensity` / `body` / `automatic_thought` /
 * `meaning` is IDENTIFY; `neutralize` is NEUTRALIZE; `post_intensity` is the
 * re-measure after working the NEUTRALIZE step; `navigate` is NAVIGATE;
 * `embed` is EMBED; `reinforce` is REINFORCE; `reflection` closes the
 * session. This is not a coincidence of naming — it is why the table has
 * exactly these fields in exactly this order, and `domain/practice-irm-
 * domain-content.ts`'s five domains describe the same cycle this table
 * records one pass of.
 *
 * ## `intensity`/`postIntensity` are PLAIN INTEGERS, and MUST STAY THAT WAY
 *
 * PRD's Explicit Non-Goals list forbids "clinical scoring" and "psychological
 * profiling"; ADR-0002's Consequences state it as a rule, not a preference:
 * "stored as plain integers 0-10 with no derived scoring logic anywhere
 * (PRD explicitly forbids treating this as a diagnostic score)". `isValid
 * IntensityValue` below is the ONLY function this file exports that touches
 * either field, and all it does is check a range — it does not sum them,
 * average them, bucket them into a severity label, or derive anything a
 * caller could read as a score. `tests/practice-session-no-derived-score.
 * test.ts` asserts this module (and the rest of the codebase) never grows
 * one. If a future change needs to compare, chart, or classify these values,
 * that is the PRD conversation to have BEFORE writing the code — not a
 * two-line helper slipped in beside CRUD.
 */

export const PRACTICE_SESSION_STATUSES = ["draft", "completed"] as const;

export type PracticeSessionStatus = (typeof PRACTICE_SESSION_STATUSES)[number];

export function isPracticeSessionStatus(
  value: unknown
): value is PracticeSessionStatus {
  return (
    typeof value === "string" &&
    (PRACTICE_SESSION_STATUSES as readonly string[]).includes(value)
  );
}

/** Inclusive range the CHECK constraint on both columns enforces at the database, mirrored here for input validation before the round trip. */
export const PRACTICE_SESSION_INTENSITY_MIN = 0;
export const PRACTICE_SESSION_INTENSITY_MAX = 10;

/**
 * A plain range check — nothing else. See this file's own header: this is
 * the ONLY function touching `intensity`/`postIntensity`, and it must never
 * grow a second responsibility (averaging, bucketing, labelling).
 */
export function isValidIntensityValue(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PRACTICE_SESSION_INTENSITY_MIN &&
    value <= PRACTICE_SESSION_INTENSITY_MAX
  );
}

/** The 12 PRD §16 content fields, all free text, all optional until `complete` (a draft may be partial). */
export type PracticeSessionContentFields = {
  situation: string | null;
  emotion: string | null;
  intensity: number | null;
  body: string | null;
  automaticThought: string | null;
  meaning: string | null;
  neutralize: string | null;
  postIntensity: number | null;
  navigate: string | null;
  embed: string | null;
  reinforce: string | null;
  reflection: string | null;
};

/** The shape every read path (create/save-draft/update/complete/list/get one) returns. */
export type PracticeSession = PracticeSessionContentFields & {
  id: string;
  ownerCustomerId: string;
  productId: string;
  status: PracticeSessionStatus;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

/**
 * The minimum a session must carry before it may move `draft -> completed`
 * (task item 5's "complete a practice session"). Deliberately narrow — just
 * enough that a "completed" entry is not empty — and NOT a scoring rule: it
 * checks presence, never a value's magnitude beyond the plain 0-10 range
 * `isValidIntensityValue` already enforces on write.
 */
export function hasMinimumFieldsToComplete(
  fields: Pick<PracticeSessionContentFields, "situation" | "intensity">
): boolean {
  return (
    typeof fields.situation === "string" &&
    fields.situation.trim().length > 0 &&
    fields.intensity !== null
  );
}
