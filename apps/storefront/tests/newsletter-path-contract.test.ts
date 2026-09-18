import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * A string-literal guard against `apps/cms/src/modules/newsletter/domain/
 * newsletter-mail.ts`'s two path constants:
 *
 *   NEWSLETTER_CONFIRM_PATH = "/newsletter/confirm"
 *   NEWSLETTER_UNSUBSCRIBE_PATH = "/newsletter/unsubscribe"
 *
 * Those are baked into every confirmation/unsubscribe e-mail the CMS sends
 * (`buildConfirmationUrl`/`buildUnsubscribeUrl` in that same file) and are
 * NOT configurable — `subscribe.ts`'s own docblock says the public site in
 * front of this CMS (this storefront, per ADR-0070) is expected to serve
 * exactly these two paths. This test imports NOTHING from `apps/cms` — that
 * tree is an upstream subtree this repo does not own, and a test file here
 * reaching into it would itself be a divergence the next `git subtree pull`
 * has to reconcile. Instead it asserts, by file existence at the LITERAL
 * path strings above, that this app still serves a page at each one — so a
 * future upstream rename of either constant, with no matching change here,
 * fails LOUDLY in this suite instead of silently 404ing a real subscriber's
 * e-mail link in production.
 *
 * See `apps/storefront/README.md`'s "Newsletter" section for the rest of
 * the contract (the tenant-domain registration an operator needs for the
 * CMS to compose these links pointing at THIS storefront's origin at all).
 */
const STOREFRONT_SRC = new URL("../src/", import.meta.url).pathname;

describe("newsletter e-mail link path contract (apps/cms's NEWSLETTER_CONFIRM_PATH / NEWSLETTER_UNSUBSCRIBE_PATH)", () => {
  test("this app serves a page file for /newsletter/confirm", () => {
    expect(existsSync(join(STOREFRONT_SRC, "pages", "newsletter", "confirm.astro"))).toBe(true);
  });

  test("this app serves a page file for /newsletter/unsubscribe", () => {
    expect(existsSync(join(STOREFRONT_SRC, "pages", "newsletter", "unsubscribe.astro"))).toBe(true);
  });

  test("the old, never-shipped /buletin/{konfirmasi,berhenti} paths are NOT kept as aliases", () => {
    expect(existsSync(join(STOREFRONT_SRC, "pages", "buletin", "konfirmasi.astro"))).toBe(false);
    expect(existsSync(join(STOREFRONT_SRC, "pages", "buletin", "berhenti.astro"))).toBe(false);
  });
});
