/**
 * `order_code` generation — `BJM-YYYYMMDD-XXXX` (Issue #29). Pure — no
 * database, no I/O; the caller (`application/order-directory.ts`) retries on
 * the rare unique-constraint collision the same way `createProduct`'s slug
 * collision handling already does elsewhere in this module.
 *
 * `BJM` is BorneojekMart's own storefront prefix. There is only ever one
 * seeded tenant in this repo today (`tools/seed-borneojek-mart.ts`), so
 * hard-coding it here is a known, deliberate simplification rather than an
 * oversight — a tenant-configurable prefix is a later increment's job, once
 * a second tenant actually exists to need one.
 *
 * The 4-character suffix avoids the digits/letters that are easy to
 * misread aloud or over a chat message: no `0`/`O`, no `1`/`I`.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUFFIX_LENGTH = 4;

function randomSuffix(): string {
  let suffix = "";
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) {
    suffix += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return suffix;
}

export function generateOrderCode(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `BJM-${year}${month}${day}-${randomSuffix()}`;
}
