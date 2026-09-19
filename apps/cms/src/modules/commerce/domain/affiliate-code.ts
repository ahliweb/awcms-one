/**
 * Affiliate referral code — Issue #92 (#86's D5). Pure — no database, no I/O.
 *
 * 8 characters drawn from an UNAMBIGUOUS base32-ish alphabet (no `I`/`O`
 * confusable with `1`/`0`, and no `0`/`1` themselves) — a shopper types this
 * back in as `?ref=CODE` or a checkout field, so every character must be
 * unambiguous when read off a screenshot or spoken aloud. The stub CMS
 * (`apps/storefront/scripts/stub-awcms.mjs`) and the storefront's own
 * `validasiKodeAfiliasi` already assume exactly this alphabet/length — this
 * file is the CMS-side half of that shared shape.
 *
 * Generated with `node:crypto`'s CSPRNG (`randomBytes`), never `Math.random`
 * — the same "never a non-cryptographic RNG for anything that identifies a
 * principal or a secret" rule this module's `order-code.ts` and
 * `customer-otp.ts` already follow. Uniqueness per tenant is NOT this file's
 * job: `application/affiliate-directory.ts` retries on a unique-constraint
 * collision the same way `order-directory.ts`'s `insertOrderWithRetryableCode`
 * retries `generateOrderCode`.
 */
import { randomBytes } from "node:crypto";

export const AFFILIATE_CODE_LENGTH = 8;

/** No `I`, `O`, `0`, `1` — see this file's header. 32 characters, so one random byte maps to one code character with no modulo bias. */
export const AFFILIATE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const CODE_SHAPE_PATTERN = new RegExp(
  `^[${AFFILIATE_CODE_ALPHABET}]{${AFFILIATE_CODE_LENGTH}}$`
);

/** A fresh, random 8-character code. Collision retry (per tenant) is the caller's job. */
export function generateAffiliateCode(): string {
  const bytes = randomBytes(AFFILIATE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < AFFILIATE_CODE_LENGTH; i += 1) {
    // `AFFILIATE_CODE_ALPHABET.length` is exactly 32 = 2^5, so `byte & 31` is
    // uniform over the alphabet with zero modulo bias.
    code += AFFILIATE_CODE_ALPHABET[bytes[i]! & 31];
  }
  return code;
}

/** Shape-only check (length + alphabet) — never a database lookup. Used to fail closed on an obviously-malformed `?ref=`/checkout code before ever querying it. */
export function isAffiliateCodeShape(value: string): boolean {
  return CODE_SHAPE_PATTERN.test(value);
}
