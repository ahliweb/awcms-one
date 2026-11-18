/**
 * The `commerce` module's derived e-mail template categories (Issue #311).
 *
 * Declared in the module descriptor (`module.ts`, `emailTemplateCategories`,
 * ADR-0164): `email` resolves every `derived.commerce_*` allow-list from the
 * installed descriptors on demand, in every process that installs the
 * extension-point source (the web entry and each dispatcher script), so no
 * process needs to import this file for its effect. It used to be a side-effect
 * module imported by `email/application/email-dispatch.ts`, a divergence from
 * upstream that retired with the descriptor mechanism.
 *
 * Deliberately dependency-free (no database, no logger). Add every new
 * `derived.commerce_*` category HERE and nowhere else; the descriptor and
 * `tests/commerce-email-categories-dispatch.test.ts` both read this list.
 */
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

/**
 * The categories as the module descriptor declares them (ADR-0164). Only the
 * campaign category is enqueued from an `awcms_worker` transaction (the campaign
 * dispatcher job); the OTP, conversation reply and document e-mails are written
 * by the request path as `awcms_app`, which the worker guard never touches. The
 * campaign row of `awcms_email_worker_categories` is seeded by
 * `sql/1064_awcms_commerce_worker_email_category_data.sql`.
 */
export const COMMERCE_EMAIL_TEMPLATE_CATEGORY_DECLARATIONS: ReadonlyArray<{
  category: string;
  allowedVariables: readonly string[];
  workerInsert?: true;
}> = COMMERCE_DERIVED_EMAIL_CATEGORIES.map(([category, allowedVariables]) => ({
  category,
  allowedVariables,
  ...(category === CAMPAIGN_EMAIL_TEMPLATE_KEY
    ? { workerInsert: true as const }
    : {})
}));
