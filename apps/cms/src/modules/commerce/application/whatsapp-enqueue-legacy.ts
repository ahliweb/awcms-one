/**
 * The `legacy` writer of `enqueueWhatsappMessage` (Issue #108, contract
 * #106/ADR-0017 D5; moved here unchanged by Issue #392) - the ONE way anything
 * in this codebase writes a row into `awcms_commerce_whatsapp_messages`. Takes
 * the caller's own transaction (`tx: Bun.SQL`) so a customer OTP request can
 * enqueue INSIDE the same transaction that issued the OTP row
 * (`application/customer-auth.ts`'s `requestCustomerOtp`) - a crash between the
 * two can never leave a code that was issued but whose delivery attempt was
 * silently lost, nor the reverse. Mirrors
 * `email/application/direct-address-notification.ts`'s enqueue-only shape: no
 * provider call happens here (ADR-0006) - the dispatcher (`whatsapp-dispatch.ts`)
 * sends later, outside any transaction.
 *
 * ## Why this is its own file (Issue #392)
 *
 * `application/whatsapp-enqueue.ts` is now the mode router every caller imports.
 * This file holds the function body exactly as it was, so a tenant in `legacy`
 * mode is byte-for-byte unchanged (same INSERT, same columns, same values), and
 * so the files on the `upstream` path can be proven never to import it, the
 * table it names or the provider that drains it
 * (`tests/commerce-whatsapp-upstream-boundary.test.ts`). It is deleted with the
 * `legacy` mode at the ADR-0133 section 6 end condition.
 */
import {
  hashIdentifierValue,
  normalizeIdentifierValue
} from "../../profile-identity/domain/identifier";
import { maskPhone } from "../domain/phone-normalisation";
import type { EnqueueWhatsappMessageInput } from "../domain/whatsapp-enqueue-types";
import { renderWhatsappTemplate } from "../domain/whatsapp-templates";

/**
 * Always enqueues (unlike `enqueueDirectAddressEmail`, there is no
 * suppression list for WhatsApp in this issue and no per-tenant template
 * that could be missing — the template registry is module-local and always
 * present). The caller decides whether to enqueue at all (e.g.
 * `requestCustomerOtp` checks `isWhatsappChannelEnabled` first and answers
 * `409 CHANNEL_UNAVAILABLE` before ever reaching this function).
 */
export async function enqueueLegacyWhatsappMessage(
  tx: Bun.SQL,
  input: EnqueueWhatsappMessageInput
): Promise<{ id: string; bodyRendered: string }> {
  const normalizedPhone = normalizeIdentifierValue("phone", input.toPhone);
  const phoneHash = hashIdentifierValue(normalizedPhone);
  const bodyRendered = renderWhatsappTemplate(
    input.templateKey,
    input.variables
  );

  const rows = (await tx`
    INSERT INTO awcms_commerce_whatsapp_messages
      (tenant_id, correlation_id, to_phone, to_phone_hash, to_phone_masked,
       template_key, variables, body_rendered)
    VALUES
      (${input.tenantId}, ${input.correlationId ?? null}, ${normalizedPhone},
       ${phoneHash}, ${maskPhone(normalizedPhone)}, ${input.templateKey},
       ${input.variables}::jsonb, ${bodyRendered})
    RETURNING id
  `) as { id: string }[];

  return { id: rows[0]!.id, bodyRendered };
}
