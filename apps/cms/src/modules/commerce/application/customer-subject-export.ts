/**
 * The export half of a shopper's data-subject rights (Issue #529, ADR-0055 D4):
 * a versioned JSON bundle of everything `commerce` holds about ONE customer,
 * built inside the caller's RLS-scoped transaction and RETURNED, never stored.
 *
 * ## Why it is not stored
 *
 * A stored bundle is a second copy of the personal data with a retention duty
 * of its own, and the shopper asked to see the data, not to have it duplicated.
 * The `awcms_commerce_customer_subject_requests` row records that a disclosure
 * happened (who, when, through which surface, how many rows), never its content.
 *
 * ## How it is built
 *
 * 1. {@link resolveSubjectKeySets} reads the ids each table is reached by (the
 *    customer, its account, its orders and their lines, refunds, documents,
 *    conversations, loyalty and stored-value accounts, quotations and work
 *    orders) ONCE.
 * 2. Each `exported` entry of `SUBJECT_TABLES` is read as `to_jsonb(row) -
 *    redactedColumns` where the table's key column is in the key set, newest
 *    first, capped at {@link EXPORT_ROW_CAP} per section (a truncated section is
 *    named in `truncated`). Reading the whole row and subtracting the redacted
 *    columns means a column added later is disclosed rather than silently
 *    missing, and `tests/commerce-customer-subject-data.test.ts` fails if such a
 *    column looks like a secret and is not redacted.
 * 3. Push data goes through `exportCustomerPushData` (masked endpoints, consent
 *    evidence), never its tables.
 * 4. The `unanswered` section says, per table, what could not be matched to the
 *    customer and why, and `retention` says what an erasure would leave in place.
 *
 * Every table name and key column comes from the static registry (checked
 * against a strict identifier pattern when the module loads); no request value
 * is ever interpolated into SQL.
 */
import { exportCustomerPushData } from "./customer-push-erasure";
import {
  CONTACT_MATCHED_TABLES,
  UPSTREAM_CONTACT_COPIES,
  SUBJECT_TABLES,
  type SubjectKeySet,
  type SubjectTable
} from "../domain/customer-subject-data";
import { REQUIRED_RETENTION_NOTICE } from "../domain/customer-subject-policy";

export const SUBJECT_EXPORT_VERSION = 1;
export const EXPORT_ROW_CAP = 1000;

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
for (const entry of SUBJECT_TABLES) {
  if (!IDENTIFIER.test(entry.table) || !IDENTIFIER.test(entry.keyColumn)) {
    throw new Error(
      `customer-subject-data: ${entry.table}.${entry.keyColumn} is not a plain identifier.`
    );
  }
}

export type SubjectKeySets = Record<SubjectKeySet, string[]>;

type IdRow = { id: string };

async function ids(rows: PromiseLike<unknown>): Promise<string[]> {
  return ((await rows) as IdRow[]).map((row) => row.id);
}

/** Reads every id set the registry's tables are reached by. */
export async function resolveSubjectKeySets(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string
): Promise<SubjectKeySets> {
  const account = await ids(
    tx`SELECT id FROM awcms_commerce_customer_accounts
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );
  const order = await ids(
    tx`SELECT id FROM awcms_commerce_orders
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );
  const orderArray = tx.array(order, "uuid");
  const accountArray = tx.array(account, "uuid");

  // One reserved connection: the reads run one after another, never
  // concurrently (tenant-route.ts: no Promise.all over `tx`).
  const orderItem = await ids(
    tx`SELECT id FROM awcms_commerce_order_items
       WHERE tenant_id = ${tenantId} AND order_id = ANY(${orderArray}::uuid[])`
  );
  const refund = await ids(
    tx`SELECT id FROM awcms_commerce_refunds
       WHERE tenant_id = ${tenantId} AND order_id = ANY(${orderArray}::uuid[])`
  );
  const document = await ids(
    tx`SELECT id FROM awcms_commerce_documents
       WHERE tenant_id = ${tenantId} AND source_id = ANY(${orderArray}::uuid[])`
  );
  const conversation = await ids(
    tx`SELECT id FROM awcms_commerce_conversations
       WHERE tenant_id = ${tenantId} AND account_id = ANY(${accountArray}::uuid[])`
  );
  const loyaltyAccount = await ids(
    tx`SELECT id FROM awcms_commerce_loyalty_accounts
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );
  const storedValueAccount = await ids(
    tx`SELECT id FROM awcms_commerce_stored_value_accounts
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );
  const quotation = await ids(
    tx`SELECT id FROM awcms_commerce_quotations
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );
  const workOrder = await ids(
    tx`SELECT id FROM awcms_commerce_work_orders
       WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}`
  );

  return {
    customer: [customerId],
    account,
    order,
    orderItem,
    refund,
    document,
    conversation,
    loyaltyAccount,
    storedValueAccount,
    quotation,
    workOrder
  };
}

export type SubjectExportBundle = {
  version: number;
  generatedAt: string;
  customerId: string;
  sections: Record<string, unknown[]>;
  push: Awaited<ReturnType<typeof exportCustomerPushData>> | null;
  /** Sections cut at the per-section cap. */
  truncated: string[];
  /** What could not be matched to the customer, and why. */
  unanswered: { table: string; reason: string }[];
  retention: { notice: string };
};

async function readSection(
  tx: Bun.SQL,
  tenantId: string,
  entry: SubjectTable,
  keys: readonly string[]
): Promise<{ rows: unknown[]; truncated: boolean }> {
  if (keys.length === 0) return { rows: [], truncated: false };

  const rows = (await tx`
    SELECT (
      to_jsonb(t)
      - ${tx.array([...entry.redactedColumns], "text")}::text[]
      -- One policy for staff data (ADR-0055 D4): every staff stamp is kept out of
      -- the shopper's bundle, not only the request row's. A staff stamp is a
      -- column named '*_tenant_user_id' or the older 'reviewed_by' /
      -- 'created_by' pair; it identifies an employee, not the shopper.
      - ARRAY(
        SELECT k FROM jsonb_object_keys(to_jsonb(t)) AS k
        WHERE k ~ '(_tenant_user_id|^reviewed_by|^created_by)$'
      )
    ) AS row
    FROM ${tx.unsafe(entry.table)} t
    WHERE t.tenant_id = ${tenantId}
      AND ${tx.unsafe(`t.${entry.keyColumn}`)} = ANY(${tx.array([...keys], "uuid")}::uuid[])
    ORDER BY (to_jsonb(t) ->> 'created_at') DESC NULLS LAST,
             (to_jsonb(t) ->> 'id')
    LIMIT ${EXPORT_ROW_CAP + 1}
  `) as { row: unknown }[];

  const truncated = rows.length > EXPORT_ROW_CAP;
  return {
    rows: rows.slice(0, EXPORT_ROW_CAP).map((r) =>
      // The driver may hand a jsonb column back as text for a computed expression.
      typeof r.row === "string" ? JSON.parse(r.row) : r.row
    ),
    truncated
  };
}

/** Builds the bundle. Read-only; the caller records the disclosure. */
export async function buildSubjectExport(
  tx: Bun.SQL,
  tenantId: string,
  customerId: string,
  now: Date = new Date()
): Promise<SubjectExportBundle> {
  const keySets = await resolveSubjectKeySets(tx, tenantId, customerId);

  const sections: Record<string, unknown[]> = {};
  const truncated: string[] = [];

  for (const entry of SUBJECT_TABLES) {
    if (!entry.exported) continue;
    const read = await readSection(tx, tenantId, entry, keySets[entry.keySet]);
    sections[entry.section] = read.rows;
    if (read.truncated) truncated.push(entry.section);
  }

  const accountId = keySets.account[0];
  const push = accountId
    ? await exportCustomerPushData(tx, tenantId, accountId)
    : null;

  return {
    version: SUBJECT_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    customerId,
    sections,
    push,
    truncated,
    unanswered: [
      ...Object.entries(CONTACT_MATCHED_TABLES).map(([table, value]) => ({
        table,
        reason: value.reason
      })),
      ...Object.entries(UPSTREAM_CONTACT_COPIES).map(([table, reason]) => ({
        table,
        reason
      }))
    ],
    retention: { notice: REQUIRED_RETENTION_NOTICE }
  };
}

/** How many rows the bundle carries, for the request row (a count, never content). */
export function countExportRows(bundle: SubjectExportBundle): number {
  let total = 0;
  for (const rows of Object.values(bundle.sections)) total += rows.length;
  if (bundle.push) {
    total +=
      bundle.push.devices.length +
      bundle.push.preferences.length +
      bundle.push.messages.length;
  }
  return total;
}
