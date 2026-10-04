/**
 * The one decision "does this payment leg belong to a register session?"
 * (Issue #284, ADR-0028). Kept in its own tiny file because the payment-ledger
 * writers (`payment-allocation-directory.ts`) need it and must not import the
 * register directories (which import the ledger's reads): no cycle, one rule.
 *
 * A leg is stamped with the order's register session when — and only when —
 * the order carries one AND that session is still `open` at the moment the leg
 * is written. The session row is locked `FOR SHARE`, so a concurrent close
 * (`FOR NO KEY UPDATE`) either runs entirely before the leg (the session is
 * then `closing`/`closed`, no stamp) or waits for the leg's transaction and
 * then sums it: a stamped leg is always in the cash-up that counts it, a leg
 * recorded after the close is never in a closed cash-up. `sql/971`'s trigger
 * is the independent backstop.
 */
export async function resolveRegisterSessionStamp(
  tx: Bun.SQL,
  tenantId: string,
  orderRegisterSessionId: string | null,
  options: { rejectClosing?: boolean } = {}
): Promise<string | null> {
  if (orderRegisterSessionId === null) return null;
  const rows = (await tx`
    SELECT id, status
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND id = ${orderRegisterSessionId}
      AND status IN ('open', 'closing')
    FOR SHARE
  `) as { id: string; status: string }[];
  const row = rows[0];
  if (!row) return null;
  if (row.status === "closing") {
    // A leg recorded now would be in no cash-up at all (the count is already
    // taken and the session accepts no more stamped activity). A writer that
    // opted in refuses it instead of letting the money fall between shifts.
    if (options.rejectClosing) throw new RegisterSessionClosingError();
    return null;
  }
  return row.id;
}

/**
 * Thrown by a ledger writer that opted into `rejectClosing` when the order's
 * register session is `closing` (counted, awaiting a supervisor's decision):
 * the route answers `409 REGISTER_SESSION_CLOSING`. If the supervisor rejects
 * the count the session is `open` again and the payment can be recorded.
 */
export class RegisterSessionClosingError extends Error {
  constructor() {
    super(
      "The order's register session is being closed; no payment can be recorded against it until the close is decided."
    );
    this.name = "RegisterSessionClosingError";
  }
}

export type ReversalSessionCheck =
  | { kind: "ok"; sessionId: string }
  | { kind: "not_found" }
  | { kind: "not_open"; status: string }
  | { kind: "not_session_cashier" };

/**
 * An explicit `registerSessionId` on a reversal: the session must exist in the
 * tenant, be `open`, and the actor must be its current cashier. Locks it
 * `FOR SHARE` for the rest of the transaction (same mode as every stamped
 * write), so a close cannot slip between this check and the insert.
 */
export async function checkReversalRegisterSession(
  tx: Bun.SQL,
  tenantId: string,
  sessionId: string,
  actorTenantUserId: string | null
): Promise<ReversalSessionCheck> {
  const rows = (await tx`
    SELECT id, status, current_cashier_tenant_user_id
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND id = ${sessionId} AND deleted_at IS NULL
    FOR SHARE
  `) as {
    id: string;
    status: string;
    current_cashier_tenant_user_id: string;
  }[];
  const row = rows[0];
  if (!row) return { kind: "not_found" };
  if (row.status !== "open") return { kind: "not_open", status: row.status };
  if (
    actorTenantUserId === null ||
    row.current_cashier_tenant_user_id !== actorTenantUserId
  ) {
    return { kind: "not_session_cashier" };
  }
  return { kind: "ok", sessionId: row.id };
}
