/**
 * Enqueue one TRANSACTIONAL e-mail to a raw address as `awcms_worker`.
 *
 * awcms-one addition (a new file in an upstream-owned module, so the table
 * stays written by its owner; root AGENTS.md). The worker-role twin of
 * `enqueueDirectAddressEmail` (`direct-address-notification.ts`).
 *
 * ## Why a second function
 *
 * `enqueueDirectAddressEmail` (ADR-0082, extended by upstream Issues #1160 and
 * #1161) writes the message's `purpose` column explicitly. The worker's INSERT
 * on `awcms_email_messages` is COLUMN-scoped (`sql/302`) and does not include
 * `purpose` on purpose: a role that could choose the purpose of a row it
 * creates could write `security`, which a marketing opt-out or an
 * unauthenticated provider report does not hold back. Upstream's own worker
 * producers (`hr_workforce`, `crm_follow_up`) never write `purpose` for the same
 * reason; the column default is `transactional`.
 *
 * So this function writes exactly the ten columns of that grant, lets `purpose`
 * take its default, and REFUSES a category whose purpose is not `transactional`
 * (a security category goes through `enqueueDirectAddressEmail` with a
 * `SecurityMailGrant`, on the request path). The category must also be a row of
 * `awcms_email_worker_categories`: the database guard refuses the insert
 * otherwise, whatever this code does.
 *
 * The caller today is commerce's campaign dispatcher (`derived.commerce_campaign`,
 * Issue #114); `tests/commerce-campaign-email-enqueue.test.ts` pins that the
 * INSERT names no column outside the worker's grant.
 */
import {
  hashIdentifierValue,
  maskIdentifierValue,
  normalizeIdentifierValue
} from "../../profile-identity/domain/identifier";
import { purposeForEmailCategory } from "../domain/email-sender";
import { renderEmailTemplate } from "../domain/email-template-render";
import { fetchActiveEmailTemplateByKey } from "./email-template-directory";
import { fetchSuppressedRecipientHashes } from "./suppression-directory";

export type EnqueueWorkerDirectAddressResult = {
  /** `false` when the tenant has no ACTIVE template for the key, or the address is suppressed. */
  enqueued: boolean;
};

export async function enqueueWorkerDirectAddressEmail(
  tx: Bun.SQL,
  tenantId: string,
  templateKey: string,
  toAddress: string,
  variables: Record<string, string>,
  correlationId: string,
  locale = "en"
): Promise<EnqueueWorkerDirectAddressResult> {
  if (purposeForEmailCategory(templateKey) !== "transactional") {
    throw new Error(
      `enqueueWorkerDirectAddressEmail only sends transactional categories; "${templateKey}" is not one (use enqueueDirectAddressEmail with a security grant on the request path).`
    );
  }

  const template = await fetchActiveEmailTemplateByKey(
    tx,
    tenantId,
    templateKey
  );

  if (!template) {
    return { enqueued: false };
  }

  const normalized = normalizeIdentifierValue("email", toAddress);
  const addressHash = hashIdentifierValue(normalized);
  const suppressedHashes = await fetchSuppressedRecipientHashes(
    tx,
    tenantId,
    "transactional"
  );

  if (suppressedHashes.has(addressHash)) {
    return { enqueued: false };
  }

  const rendered = renderEmailTemplate(
    template,
    variables,
    templateKey,
    locale
  );

  // The ten columns of the worker's grant (sql/302) and nothing else; `purpose`
  // takes its default, `transactional`.
  await tx`
    INSERT INTO awcms_email_messages
      (tenant_id, correlation_id, category, template_key, to_address,
       to_address_hash, to_address_masked, subject, variables, priority)
    VALUES
      (${tenantId}, ${correlationId}, ${templateKey}, ${templateKey},
       ${normalized}, ${addressHash}, ${maskIdentifierValue(normalized)},
       ${rendered.subject}, ${variables}::jsonb, 'high')
  `;

  return { enqueued: true };
}
