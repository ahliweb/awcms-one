/**
 * Allowlisted `{{var}}` substitution for a campaign's OWN `subject`/`body`
 * text (Issue #114, contract #106 ADR-0017 D9) — distinct from
 * `domain/whatsapp-templates.ts`'s fixed, in-code templates (a campaign's
 * content is user-authored per campaign, not a registry entry) and from
 * `email/domain/email-template-render.ts` (a campaign is not a row in
 * `awcms_email_templates` either — see `application/campaign-dispatch.ts`'s
 * header for why the DERIVED `derived.commerce_campaign` e-mail template
 * exists only as a pass-through shell).
 *
 * Same fail-closed posture every renderer in this codebase already takes:
 * a placeholder not in the allowlist is left as a literal `{{name}}` in the
 * output, never silently dropped or evaluated.
 */

export const CAMPAIGN_ALLOWED_VARIABLES = ["name", "storeName"] as const;
export type CampaignVariableName = (typeof CAMPAIGN_ALLOWED_VARIABLES)[number];

export function renderCampaignText(
  text: string,
  variables: Partial<Record<CampaignVariableName, string>>
): string {
  let rendered = text;
  for (const name of CAMPAIGN_ALLOWED_VARIABLES) {
    const value = variables[name] ?? "";
    rendered = rendered.split(`{{${name}}}`).join(value);
  }
  return rendered;
}
