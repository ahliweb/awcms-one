/**
 * `enqueueWhatsappMessage` (Issue #108, contract #106/ADR-0017 D5) — the
 * ONE way anything in this codebase writes a row into
 * `awcms_commerce_whatsapp_messages`. Takes the caller's own transaction
 * (`tx: Bun.SQL`) so a customer OTP request can enqueue INSIDE the same
 * transaction that issued the OTP row (`application/customer-auth.ts`'s
 * `requestCustomerOtp`) — a crash between the two can never leave a code
 * that was issued but whose delivery attempt was silently lost, nor the
 * reverse. Mirrors `email/application/direct-address-notification.ts`'s
 * enqueue-only shape: no provider call happens here (ADR-0006) — the
 * dispatcher (`whatsapp-dispatch.ts`) sends later, outside any transaction.
 */
import {
  hashIdentifierValue,
  normalizeIdentifierValue
} from "../../profile-identity/domain/identifier";
import { maskPhone } from "../domain/phone-normalisation";
import {
  renderWhatsappTemplate,
  type WhatsappTemplateKey
} from "../domain/whatsapp-templates";

export type EnqueueWhatsappMessageInput = {
  tenantId: string;
  /** E.164 (`+62…`) — already normalised by the caller (`domain/phone-normalisation.ts`). */
  toPhone: string;
  templateKey: WhatsappTemplateKey;
  variables: Record<string, string>;
  correlationId?: string;
};

export type EnqueueWhatsappMessageResult = {
  id: string;
  bodyRendered: string;
};

/**
 * Always enqueues (unlike `enqueueDirectAddressEmail`, there is no
 * suppression list for WhatsApp in this issue and no per-tenant template
 * that could be missing — the template registry is module-local and always
 * present). The caller decides whether to enqueue at all (e.g.
 * `requestCustomerOtp` checks `isWhatsappChannelEnabled` first and answers
 * `409 CHANNEL_UNAVAILABLE` before ever reaching this function).
 */
export async function enqueueWhatsappMessage(
  tx: Bun.SQL,
  input: EnqueueWhatsappMessageInput
): Promise<EnqueueWhatsappMessageResult> {
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
