/**
 * The `commerce.*` WhatsApp templates, registered with `whatsapp_delivery`
 * (Issue #392, ADR-0133 section 6 phase 2).
 *
 * This file is a SIDE-EFFECT module: importing it calls
 * `registerWhatsappTemplate` for every commerce template. The registry is a
 * per-process `Map`, so every process that can ENQUEUE or DISPATCH a commerce
 * message in `upstream` mode must import this file:
 *
 *   * the CMS server, through `application/whatsapp-upstream-enqueue.ts` (the
 *     only caller of the port) and through `module.ts`, so the admin template
 *     list shows them;
 *   * the `whatsapp:dispatch` process, which renders nothing but looks the
 *     template up to send (`providerTemplate`, the parameter order) and fails a
 *     message whose key is not registered as `template_unknown`. That process
 *     imports no module, so `scripts/whatsapp-dispatch.ts` carries ONE
 *     side-effect import of this file (a recorded divergence from upstream, see
 *     root `AGENTS.md`; it retires when upstream gains a descriptor-declared
 *     template registration the dispatcher loads generically, the mechanism
 *     ADR-0134 gave domain-event consumers).
 *
 * Deliberately dependency-free beyond the registry itself and this module's own
 * pure template definitions (no database, no logger), so that import stays cheap
 * and cannot form a cycle. `tests/commerce-whatsapp-upstream-templates.test.ts`
 * proves the registration from a fresh process importing only the dispatch
 * script.
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
import {
  registerWhatsappTemplate,
  type WhatsappPurpose
} from "../../whatsapp-delivery/domain/whatsapp-templates";
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

for (const [key, plan] of Object.entries(COMMERCE_UPSTREAM_TEMPLATE_PLANS) as [
  WhatsappTemplateKey,
  UpstreamTemplatePlan
][]) {
  const definition = whatsappTemplateDefinition(key);

  registerWhatsappTemplate({
    key,
    version: COMMERCE_WHATSAPP_TEMPLATE_VERSION,
    purpose: plan.purpose,
    body: definition.body,
    variables: definition.variables,
    ...(plan.secretVariables ? { secretVariables: plan.secretVariables } : {})
  });
}
