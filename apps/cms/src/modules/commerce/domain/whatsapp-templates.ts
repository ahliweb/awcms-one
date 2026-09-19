/**
 * Module-local WhatsApp template registry (Issue #108, contract
 * #106/ADR-0017 D5). Deliberately NOT the `email` module's DB-backed,
 * per-tenant-editable template system (`email/domain/email-template-
 * render.ts`) — WhatsApp templates are also subject to Meta's own template
 * *approval* process for the `meta` provider (a template name, not a body,
 * is what actually gets sent — `COMMERCE_META_WA_OTP_TEMPLATE`), so a
 * tenant-editable body would silently drift from what Meta actually
 * approved. Fixed, in-code, `{{var}}` rendering with a per-template
 * variable allowlist — same allowlist discipline
 * `email-template-categories.ts` applies, just without the database.
 *
 * Three keys exist for the whole D5/D7/D9 family (`commerce.customer_otp` —
 * wired end to end by this issue; `commerce.order_paid`/`commerce.campaign`
 * — registered for the later waves that enqueue them, #D7/#D9, not yet
 * called from anywhere in this issue).
 */

export const WHATSAPP_TEMPLATE_KEYS = [
  "commerce.customer_otp",
  "commerce.order_paid",
  "commerce.campaign"
] as const;

export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export function isKnownWhatsappTemplateKey(
  value: string
): value is WhatsappTemplateKey {
  return (WHATSAPP_TEMPLATE_KEYS as readonly string[]).includes(value);
}

type WhatsappTemplateDefinition = {
  /** The only variables `renderWhatsappTemplate` will interpolate — anything else in the body stays a literal `{{name}}`, matching `email-template-render.ts`'s own "unknown placeholder is left untouched" behaviour. */
  variables: readonly string[];
  body: string;
};

const WHATSAPP_TEMPLATES: Record<
  WhatsappTemplateKey,
  WhatsappTemplateDefinition
> = {
  "commerce.customer_otp": {
    variables: ["code", "expiresInMinutes", "storeName"],
    body: "Kode verifikasi Anda adalah {{code}}. Kode ini berlaku {{expiresInMinutes}} menit.\n\n{{storeName}}"
  },
  "commerce.order_paid": {
    variables: ["orderCode", "total", "storeName"],
    body: "Pesanan {{orderCode}} telah dibayar (total {{total}}). Terima kasih telah berbelanja di {{storeName}}."
  },
  "commerce.campaign": {
    variables: ["subject", "body", "storeName"],
    body: "{{subject}}\n\n{{body}}\n\n{{storeName}}"
  }
};

export function whatsappTemplateVariables(
  templateKey: WhatsappTemplateKey
): readonly string[] {
  return WHATSAPP_TEMPLATES[templateKey].variables;
}

/**
 * Replaces every `{{var}}` occurrence whose name is in the template's own
 * allowlist with the caller-supplied value (empty string when the caller did
 * not provide one) — a variable NOT in the allowlist is never substituted,
 * even if the caller happened to pass a value under that name (fail-closed,
 * same posture `email-template-render.ts` takes).
 */
export function renderWhatsappTemplate(
  templateKey: WhatsappTemplateKey,
  variables: Record<string, string>
): string {
  const definition = WHATSAPP_TEMPLATES[templateKey];
  let rendered = definition.body;

  for (const name of definition.variables) {
    const value = variables[name] ?? "";
    rendered = rendered.split(`{{${name}}}`).join(value);
  }

  return rendered;
}
