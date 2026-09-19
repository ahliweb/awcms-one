/**
 * Rate-limit bucket keys for `POST /storefront/account/otp/request`.
 *
 * The per-identifier ceiling exists so an attacker who can rotate IPs still
 * cannot flood one mailbox or — more expensively for the store and more
 * annoying for the victim — one WhatsApp number. A phone bucket therefore
 * has to treat the spellings a shopper actually types as the same number:
 * "+62 812-3456-7890", "0812 3456 7890" and "628123456789 0" all collapse to
 * digits with the Indonesian trunk prefix `0` rewritten to `62`. Full E.164
 * validation still happens later in `phone-normalisation.ts`; this only has
 * to be stable, never authoritative.
 */
export function otpPhoneRateLimitKey(rawPhone: unknown): string | null {
  if (typeof rawPhone !== "string") return null;
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const canonical = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return `commerce:account:otp:request:phone:${canonical}`;
}

export function otpEmailRateLimitKey(rawEmail: unknown): string | null {
  if (typeof rawEmail !== "string") return null;
  const email = rawEmail.trim().toLowerCase();
  if (!email) return null;
  return `commerce:account:otp:request:email:${email}`;
}
