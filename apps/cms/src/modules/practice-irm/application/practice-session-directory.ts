/**
 * `practice_sessions` CRUD (Issue #270, ADR-0002). Every function below
 * takes `ownerCustomerId` and `productId` and calls `verifyEntitlement`
 * FIRST, before touching `awcms_practice_irm_sessions` — a customer without
 * an active entitlement for `productId` gets `{ kind: "forbidden" }` and
 * never sees practice content or session rows, on every call, not just
 * creation (PRD: "a customer without the relevant product entitlement gets
 * 403, never practice content or the ability to log a session"; `sql/941`'s
 * header has the full RLS/owner-scoping reasoning).
 *
 * `ownerCustomerId` MUST come from the caller's own verified bearer session
 * (`requireCustomerSession`, the commerce module's session guard — see
 * `sql/941`'s header on why practice-irm reuses commerce's customer identity
 * rather than inventing a second one), never from request input. Every
 * query here filters on it explicitly — the same application-level
 * owner-scoping discipline `commerce-entitlement-directory.ts`'s
 * `listEntitlementsForCustomer` already established (ADR-0016 D1: there is
 * no `app.current_customer_id` session variable in this system, so a
 * second RLS policy keyed on the customer is not a shape this system has).
 *
 * A `completed` session is immutable — `updatePracticeSession` refuses once
 * `status = 'completed'` (AGENTS.md's posted-data-is-immutable rule, applied
 * here the same way a posted ledger entry is only corrected by a NEW entry,
 * never edited in place). Nothing in this file computes, stores, or exposes
 * any value derived from `intensity`/`postIntensity` beyond the plain
 * integers themselves — see `domain/practice-session.ts`'s header.
 */
import { recordAuditEvent } from "../../logging/application/audit-log";
import { verifyEntitlement } from "../../commerce/application/commerce-entitlement-directory";
import {
  encodeKeysetCursor,
  keysetCursorCreatedAtSql,
  type KeysetCursor
} from "../../_shared/keyset-pagination";
import {
  hasMinimumFieldsToComplete,
  type PracticeSession,
  type PracticeSessionContentFields
} from "../domain/practice-session";

const AUDIT_MODULE_KEY = "practice_irm";
const AUDIT_RESOURCE_TYPE = "practice_irm_session";

export const PRACTICE_SESSION_LIST_DEFAULT_LIMIT = 20;
export const PRACTICE_SESSION_LIST_MAX_LIMIT = 50;

type SessionRow = {
  id: string;
  owner_customer_id: string;
  product_id: string;
  status: string;
  situation: string | null;
  emotion: string | null;
  intensity: number | null;
  body: string | null;
  automatic_thought: string | null;
  meaning: string | null;
  neutralize: string | null;
  post_intensity: number | null;
  navigate: string | null;
  embed: string | null;
  reinforce: string | null;
  reflection: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function toPracticeSession(row: SessionRow): PracticeSession {
  return {
    id: row.id,
    ownerCustomerId: row.owner_customer_id,
    productId: row.product_id,
    status: row.status as PracticeSession["status"],
    situation: row.situation,
    emotion: row.emotion,
    intensity: row.intensity,
    body: row.body,
    automaticThought: row.automatic_thought,
    meaning: row.meaning,
    neutralize: row.neutralize,
    postIntensity: row.post_intensity,
    navigate: row.navigate,
    embed: row.embed,
    reinforce: row.reinforce,
    reflection: row.reflection,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

const SESSION_COLUMNS = `id, owner_customer_id, product_id, status,
  situation, emotion, intensity, body, automatic_thought, meaning,
  neutralize, post_intensity, navigate, embed, reinforce, reflection,
  created_at, updated_at, completed_at`;

export type EntitlementGatedResult<T> =
  { kind: "forbidden" } | ({ kind: "ok" } & T);

async function requireEntitlement(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string
): Promise<boolean> {
  const entitlement = await verifyEntitlement(
    tx,
    tenantId,
    ownerCustomerId,
    productId
  );
  return entitlement !== null;
}

export type CreatePracticeSessionInput = Partial<PracticeSessionContentFields>;

export type CreatePracticeSessionResult =
  { kind: "forbidden" } | { kind: "created"; session: PracticeSession };

/**
 * Creates a new `draft` session. A draft may be entirely empty — the point
 * of "save-draft" (task item 5) is that a customer can start a session and
 * come back to it, so no field here is required at creation.
 */
export async function createPracticeSession(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string,
  input: CreatePracticeSessionInput,
  correlationId?: string
): Promise<CreatePracticeSessionResult> {
  if (!(await requireEntitlement(tx, tenantId, ownerCustomerId, productId))) {
    return { kind: "forbidden" };
  }

  const rows = (await tx`
    INSERT INTO awcms_practice_irm_sessions
      (tenant_id, owner_customer_id, product_id, status,
       situation, emotion, intensity, body, automatic_thought, meaning,
       neutralize, post_intensity, navigate, embed, reinforce, reflection)
    VALUES
      (${tenantId}, ${ownerCustomerId}, ${productId}, 'draft',
       ${input.situation ?? null}, ${input.emotion ?? null}, ${input.intensity ?? null},
       ${input.body ?? null}, ${input.automaticThought ?? null}, ${input.meaning ?? null},
       ${input.neutralize ?? null}, ${input.postIntensity ?? null}, ${input.navigate ?? null},
       ${input.embed ?? null}, ${input.reinforce ?? null}, ${input.reflection ?? null})
    RETURNING ${tx.unsafe(SESSION_COLUMNS)}
  `) as SessionRow[];

  const session = toPracticeSession(rows[0]!);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "practice_irm.session.created",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: session.id,
    message: `Practice session started by customer ${ownerCustomerId} for product ${productId}.`,
    attributes: { ownerCustomerId, productId },
    correlationId
  });

  return { kind: "created", session };
}

export type UpdatePracticeSessionInput = Partial<PracticeSessionContentFields>;

export type UpdatePracticeSessionResult =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "immutable" }
  | { kind: "updated"; session: PracticeSession };

/**
 * Updates a session's content fields — the "save-draft" write path for an
 * EXISTING session. Refuses `immutable` once the session is `completed`
 * (AGENTS.md's posted-data rule); a customer who wants to revise a completed
 * session logs a NEW one instead.
 */
export async function updatePracticeSession(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string,
  sessionId: string,
  input: UpdatePracticeSessionInput,
  correlationId?: string
): Promise<UpdatePracticeSessionResult> {
  if (!(await requireEntitlement(tx, tenantId, ownerCustomerId, productId))) {
    return { kind: "forbidden" };
  }

  const existingRows = (await tx`
    SELECT ${tx.unsafe(SESSION_COLUMNS)}
    FROM awcms_practice_irm_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
      AND owner_customer_id = ${ownerCustomerId} AND product_id = ${productId}
  `) as SessionRow[];

  const existing = existingRows[0];
  if (!existing) return { kind: "not_found" };
  if (existing.status === "completed") return { kind: "immutable" };

  const merged: PracticeSessionContentFields = {
    situation: input.situation ?? existing.situation,
    emotion: input.emotion ?? existing.emotion,
    intensity: input.intensity ?? existing.intensity,
    body: input.body ?? existing.body,
    automaticThought: input.automaticThought ?? existing.automatic_thought,
    meaning: input.meaning ?? existing.meaning,
    neutralize: input.neutralize ?? existing.neutralize,
    postIntensity: input.postIntensity ?? existing.post_intensity,
    navigate: input.navigate ?? existing.navigate,
    embed: input.embed ?? existing.embed,
    reinforce: input.reinforce ?? existing.reinforce,
    reflection: input.reflection ?? existing.reflection
  };

  const rows = (await tx`
    UPDATE awcms_practice_irm_sessions
    SET situation = ${merged.situation}, emotion = ${merged.emotion},
      intensity = ${merged.intensity}, body = ${merged.body},
      automatic_thought = ${merged.automaticThought}, meaning = ${merged.meaning},
      neutralize = ${merged.neutralize}, post_intensity = ${merged.postIntensity},
      navigate = ${merged.navigate}, embed = ${merged.embed},
      reinforce = ${merged.reinforce}, reflection = ${merged.reflection},
      updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
      AND owner_customer_id = ${ownerCustomerId} AND product_id = ${productId}
      AND status = 'draft'
    RETURNING ${tx.unsafe(SESSION_COLUMNS)}
  `) as SessionRow[];

  const updated = rows[0];
  // A concurrent `complete` could have won the race between the SELECT above
  // and this UPDATE's own `status = 'draft'` guard — treat that the same as
  // "already completed", never silently no-op.
  if (!updated) return { kind: "immutable" };

  void correlationId;
  return { kind: "updated", session: toPracticeSession(updated) };
}

export type CompletePracticeSessionResult =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "already_completed" }
  | { kind: "incomplete_fields" }
  | { kind: "completed"; session: PracticeSession };

/**
 * `draft -> completed`, the one status transition this table has. Requires
 * `hasMinimumFieldsToComplete` (situation + intensity present) — a presence
 * check, never a value judgement about WHAT was written.
 */
export async function completePracticeSession(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string,
  sessionId: string,
  correlationId?: string
): Promise<CompletePracticeSessionResult> {
  if (!(await requireEntitlement(tx, tenantId, ownerCustomerId, productId))) {
    return { kind: "forbidden" };
  }

  const existingRows = (await tx`
    SELECT ${tx.unsafe(SESSION_COLUMNS)}
    FROM awcms_practice_irm_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
      AND owner_customer_id = ${ownerCustomerId} AND product_id = ${productId}
  `) as SessionRow[];

  const existing = existingRows[0];
  if (!existing) return { kind: "not_found" };
  if (existing.status === "completed") return { kind: "already_completed" };

  if (
    !hasMinimumFieldsToComplete({
      situation: existing.situation,
      intensity: existing.intensity
    })
  ) {
    return { kind: "incomplete_fields" };
  }

  const rows = (await tx`
    UPDATE awcms_practice_irm_sessions
    SET status = 'completed', completed_at = now(), updated_at = now()
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
      AND owner_customer_id = ${ownerCustomerId} AND product_id = ${productId}
      AND status = 'draft'
    RETURNING ${tx.unsafe(SESSION_COLUMNS)}
  `) as SessionRow[];

  const completed = rows[0];
  if (!completed) return { kind: "already_completed" };

  const session = toPracticeSession(completed);

  await recordAuditEvent(tx, {
    tenantId,
    moduleKey: AUDIT_MODULE_KEY,
    action: "practice_irm.session.completed",
    resourceType: AUDIT_RESOURCE_TYPE,
    resourceId: session.id,
    message: `Practice session completed by customer ${ownerCustomerId} for product ${productId}.`,
    attributes: { ownerCustomerId, productId },
    correlationId
  });

  return { kind: "completed", session };
}

export type GetPracticeSessionResult =
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "found"; session: PracticeSession };

export async function getPracticeSessionForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string,
  sessionId: string
): Promise<GetPracticeSessionResult> {
  if (!(await requireEntitlement(tx, tenantId, ownerCustomerId, productId))) {
    return { kind: "forbidden" };
  }

  const rows = (await tx`
    SELECT ${tx.unsafe(SESSION_COLUMNS)}
    FROM awcms_practice_irm_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId}
      AND owner_customer_id = ${ownerCustomerId} AND product_id = ${productId}
  `) as SessionRow[];

  const row = rows[0];
  return row
    ? { kind: "found", session: toPracticeSession(row) }
    : { kind: "not_found" };
}

export type PracticeSessionListPage = {
  items: PracticeSession[];
  nextCursor: string | null;
};

export type ListPracticeSessionsResult =
  { kind: "forbidden" } | { kind: "ok"; page: PracticeSessionListPage };

/**
 * "My sessions" — history, newest first, keyset-paginated. `ownerCustomerId`
 * comes only from the verified bearer session (see this file's header);
 * `productId` scopes the history to the one entitlement being exercised,
 * the same per-call gating every other function here applies.
 */
export async function listPracticeSessionsForCustomer(
  tx: Bun.SQL,
  tenantId: string,
  ownerCustomerId: string,
  productId: string,
  cursor: KeysetCursor | null,
  limit: number = PRACTICE_SESSION_LIST_DEFAULT_LIMIT
): Promise<ListPracticeSessionsResult> {
  if (!(await requireEntitlement(tx, tenantId, ownerCustomerId, productId))) {
    return { kind: "forbidden" };
  }

  const boundedLimit = Math.min(
    Math.max(1, Math.trunc(limit)),
    PRACTICE_SESSION_LIST_MAX_LIMIT
  );
  const cursorCreatedAt = cursor?.createdAt ?? null;
  const cursorId = cursor?.id ?? null;

  const rows = (await tx`
    SELECT ${tx.unsafe(SESSION_COLUMNS)},
      ${tx.unsafe(keysetCursorCreatedAtSql())} AS created_at_cursor
    FROM awcms_practice_irm_sessions
    WHERE tenant_id = ${tenantId}
      AND owner_customer_id = ${ownerCustomerId}
      AND product_id = ${productId}
      AND (
        ${cursorCreatedAt}::timestamptz IS NULL
        OR (created_at, id) < (${cursorCreatedAt}, ${cursorId})
      )
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `) as (SessionRow & { created_at_cursor: string })[];

  const items = rows.map(toPracticeSession);
  const last = rows[rows.length - 1];
  const nextCursor =
    rows.length === boundedLimit && last
      ? encodeKeysetCursor(last.created_at_cursor, last.id)
      : null;

  return { kind: "ok", page: { items, nextCursor } };
}
