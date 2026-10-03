/**
 * The `commerce` module's derived e-mail template categories (Issue #311).
 *
 * This file is a SIDE-EFFECT module: importing it registers every
 * `derived.commerce_*` category with `email`'s allow-list registry
 * (`registerDerivedEmailTemplateCategory`). The registry is a per-process
 * `Map`, and `renderEmailTemplate` substitutes NO variables for a category
 * that is not in it — so every process that can render a commerce e-mail must
 * import this file. The CMS server does so through the commerce application
 * files; the separate `email:dispatch` process does so through one import in
 * `email/application/email-dispatch.ts` (a recorded divergence from upstream,
 * see root `AGENTS.md`).
 *
 * Deliberately dependency-free (no database, no logger) so that import stays
 * cheap and cannot form a cycle. Add every new `derived.commerce_*` category
 * HERE and nowhere else; `tests/commerce-email-categories-dispatch.test.ts`
 * fails if a category is registered anywhere outside this file.
 */
import { registerDerivedEmailTemplateCategory } from "../../email/domain/email-template-categories";

/** `template_key` doubles as the category (`email`'s own convention) — one derived category, one template, one row per tenant. */
export const CUSTOMER_OTP_TEMPLATE_KEY = "derived.commerce_customer_otp";

/** The only variables the template may interpolate — `email-template-render.ts` silently drops anything else. */
export const CUSTOMER_OTP_TEMPLATE_VARIABLES = [
  "code",
  "expiresInMinutes",
  "storeName"
] as const;

export const CONVERSATION_REPLY_TEMPLATE_KEY =
  "derived.commerce_conversation_reply";

export const CONVERSATION_REPLY_TEMPLATE_VARIABLES = [
  "name",
  "subject",
  "storeName",
  "link"
] as const;

export const CAMPAIGN_EMAIL_TEMPLATE_KEY = "derived.commerce_campaign";
export const CAMPAIGN_EMAIL_TEMPLATE_VARIABLES = ["subject", "body"] as const;

/** Every category this module owns, with its allow-list — the single source the registrations and the regression test both read. */
export const COMMERCE_DERIVED_EMAIL_CATEGORIES: ReadonlyArray<
  readonly [string, readonly string[]]
> = [
  [CUSTOMER_OTP_TEMPLATE_KEY, CUSTOMER_OTP_TEMPLATE_VARIABLES],
  [CONVERSATION_REPLY_TEMPLATE_KEY, CONVERSATION_REPLY_TEMPLATE_VARIABLES],
  [CAMPAIGN_EMAIL_TEMPLATE_KEY, CAMPAIGN_EMAIL_TEMPLATE_VARIABLES]
];

for (const [category, variables] of COMMERCE_DERIVED_EMAIL_CATEGORIES) {
  registerDerivedEmailTemplateCategory(category, variables);
}
