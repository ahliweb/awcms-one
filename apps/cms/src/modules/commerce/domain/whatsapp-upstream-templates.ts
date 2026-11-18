/**
 * The `commerce.*` WhatsApp templates, registered with `whatsapp_delivery`
 * (Issue #392, ADR-0133 section 6 phase 2).
 *
 * Declared in the module descriptor (`module.ts`, `whatsappTemplates`,
 * ADR-0164): `whatsapp_delivery` registers every declared template on the first
 * lookup in any process that installed the extension-point source (the web
 * entry and each dispatcher script, `whatsapp:dispatch` included), so nothing
 * imports this file for its effect any more. It used to be a side-effect module
 * that `scripts/whatsapp-dispatch.ts` imported, a divergence from upstream that
 * retired with the descriptor mechanism.
 *
 * Deliberately dependency-free beyond this module's own pure template
 * definitions (no database, no logger). `tests/commerce-whatsapp-upstream-
 * templates.test.ts` proves the resolution from a fresh process that installs
 * the source the way the dispatch script does.
 *
 * ## Purposes (ADR-0133 section 4), fixed per template
 *
 *   * `commerce.customer_otp` - `security`: a login/registration code. Mandatory
 *     expiry (the adapter sets it from the code's own validity window), never
 *     blocked by a marketing opt-out, cleared from the queue row at a terminal
 *     state. `code` is the secret variable.
 *   * `commerce.order_paid`, `commerce.document` - `transactional`: a message
 *     about the recipient's own order or document (awcms-one ADR-0034 D5).
 *   * `commerce.campaign` - `marketing`: needs an explicit recorded opt-in in
 *     `whatsapp_delivery`'s consent store, independent of segment membership.
 *
 * The wording and the variable allow-lists are `domain/whatsapp-templates.ts`'s
 * own, read through `whatsappTemplateDefinition`, so they cannot drift while both
 * modes exist. `providerTemplate` (Meta's pre-approved template identity) is NOT
 * set: with `WHATSAPP_PROVIDER=meta` these messages fail terminally rather than
 * fall back to free text (ADR-0133 section 10, Q4); a deployment on Meta needs
 * the approved names added here first. Fonnte and `log` need nothing.
 */
import type { ModuleWhatsappTemplate } from "../../_shared/module-contract";
import type { WhatsappPurpose } from "../../whatsapp-delivery/domain/whatsapp-templates";
import {
  whatsappTemplateDefinition,
  type WhatsappTemplateKey
} from "./whatsapp-templates";

/** Bumped when a template's wording or variables change; stored on the queue row. */
export const COMMERCE_WHATSAPP_TEMPLATE_VERSION = 1;

type UpstreamTemplatePlan = {
  purpose: WhatsappPurpose;
  secretVariables?: readonly string[];
};

export const COMMERCE_UPSTREAM_TEMPLATE_PLANS: Record<
  WhatsappTemplateKey,
  UpstreamTemplatePlan
> = {
  "commerce.customer_otp": { purpose: "security", secretVariables: ["code"] },
  "commerce.order_paid": { purpose: "transactional" },
  "commerce.campaign": { purpose: "marketing" },
  "commerce.document": { purpose: "transactional" }
};

/** The templates as the module descriptor declares them (ADR-0164). */
export const COMMERCE_WHATSAPP_TEMPLATE_DECLARATIONS: readonly ModuleWhatsappTemplate[] =
  (
    Object.entries(COMMERCE_UPSTREAM_TEMPLATE_PLANS) as [
      WhatsappTemplateKey,
      UpstreamTemplatePlan
    ][]
  ).map(([key, plan]) => {
    const definition = whatsappTemplateDefinition(key);

    return {
      key,
      version: COMMERCE_WHATSAPP_TEMPLATE_VERSION,
      purpose: plan.purpose,
      body: definition.body,
      variables: definition.variables,
      ...(plan.secretVariables ? { secretVariables: plan.secretVariables } : {})
    };
  });
