/**
 * Concurrency-safe, gapless document numbering (Issue #286, ADR-0029 D3).
 *
 * ONE statement allocates a number: an upsert on
 * `awcms_commerce_document_sequences (tenant_id, doc_type, period)` that
 * creates the counter at 1 or bumps it by exactly one, returning the value.
 * The row lock the upsert takes is held until the surrounding transaction
 * ends, so two concurrent allocations queue behind each other and receive
 * consecutive numbers; and because the bump commits or rolls back TOGETHER with
 * the numbered row the caller inserts next, a transaction that fails after
 * allocating hands its number back - no gap.
 *
 * That guarantee has one precondition, which every caller honours: allocate
 * LAST. Nothing fallible may sit between `allocateDocumentNumber` and the
 * insert that uses the number, and nothing after the insert may return a
 * failure RESPONSE (a returned `409` still commits the transaction; only a
 * thrown error rolls it back).
 */
import {
  formatDocumentNumber,
  numberingPeriod,
  type DocumentSequenceType
} from "../domain/documents";

export type AllocatedNumber = {
  number: string;
  counter: number;
  period: string;
};

export async function allocateDocumentNumber(
  tx: Bun.SQL,
  tenantId: string,
  type: DocumentSequenceType,
  now: Date
): Promise<AllocatedNumber> {
  const period = numberingPeriod(now);
  const rows = (await tx`
    INSERT INTO awcms_commerce_document_sequences (tenant_id, doc_type, period, last_number)
    VALUES (${tenantId}, ${type}, ${period}, 1)
    ON CONFLICT (tenant_id, doc_type, period)
    DO UPDATE SET last_number = awcms_commerce_document_sequences.last_number + 1,
                  updated_at = now()
    RETURNING last_number
  `) as { last_number: number | string }[];
  const counter = Number(rows[0]!.last_number);
  return {
    number: formatDocumentNumber(type, period, counter),
    counter,
    period
  };
}
