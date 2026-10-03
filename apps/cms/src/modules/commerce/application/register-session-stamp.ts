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
  orderRegisterSessionId: string | null
): Promise<string | null> {
  if (orderRegisterSessionId === null) return null;
  const rows = (await tx`
    SELECT id
    FROM awcms_commerce_register_sessions
    WHERE tenant_id = ${tenantId} AND id = ${orderRegisterSessionId}
      AND status = 'open'
    FOR SHARE
  `) as { id: string }[];
  return rows[0]?.id ?? null;
}
