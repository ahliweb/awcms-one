/**
 * `inSavepoint` - run a statement (or a short unit) whose database error the
 * caller intends to CATCH, inside a savepoint.
 *
 * Why this exists. A failing statement aborts the PostgreSQL transaction it
 * runs in. If the handler then catches the error and lets the transaction
 * commit (a `409` response, an audit row of the refusal, a retry with another
 * candidate code), PostgreSQL answers the final `COMMIT` with `ROLLBACK`.
 * Bun 1.4.2 treated that as success, silently losing every write made earlier
 * in the same transaction while the handler reported success; Bun 1.4.3 throws
 * `ERR_POSTGRES_COMMIT_ROLLED_BACK`. A savepoint confines the abort to the
 * statement: only the savepoint rolls back and the outer transaction stays
 * usable and commits what it already wrote - on both Bun versions.
 *
 * The rule: **a statement whose error is caught inside a transaction runs in a
 * savepoint.** A statement whose error always propagates out of the
 * transaction callback (so the whole transaction rolls back) needs none.
 *
 * `work` must do its reads/writes on the `sp` it is handed, never on `tx`. An
 * error thrown by `work` rolls the savepoint back and is re-thrown unchanged,
 * so `instanceof Bun.SQL.PostgresError` checks in the caller still work.
 *
 * Outside a transaction (a unit-test fake, a bare `Bun.SQL`) there is no
 * `savepoint` function and `work` runs directly on the handle it was given.
 */
export async function inSavepoint<T>(
  tx: Bun.SQL,
  work: (sp: Bun.SQL) => Promise<T>
): Promise<T> {
  const transaction = tx as Partial<Bun.TransactionSQL>;
  if (typeof transaction.savepoint !== "function") return work(tx);
  return transaction.savepoint.call(tx, (sp: Bun.SQL) =>
    work(sp)
  ) as Promise<T>;
}
