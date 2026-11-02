---
bump: minor
type: content
impact: public
---

# Storefront: one in-flight guard and an idempotency key for every mutating form

[Issue #513](https://github.com/ahliweb/awcms-one/issues/513), work unit A (the storefront client; the server half is units B and C). A shopper who tapped **Daftar** twice, pressed Enter during a slow request or whose browser retried on a weak network sent the request twice; the first created the account and the second answered "Nomor telepon ini sudah terdaftar pada akun lain." for an account the same person had just made. Every storefront form that sends a POST, PUT, PATCH or DELETE now goes through one shared single-flight guard (`apps/storefront/src/lib/kirim-tunggal.ts`): a second tap or Enter while a request is pending is ignored (not queued, no error), the controls are disabled, the form carries `aria-busy="true"` and a visually hidden polite status in the layout says "Memproses..." (no layout shift, focus kept); a success that redirects keeps the form disabled until the redirect, and a back-button restore from the bfcache releases it.

The "why" of the shape: a client guard stops the accidental double tap but never a retry, a reload or a second tab, so where a repeat would do the thing twice the page also sends an opaque `Idempotency-Key` (`crypto.randomUUID()`, `[A-Za-z0-9_-]{16,128}`, in memory only) that is stable across retries of the same attempt and rotated after a definitive answer (`apps/storefront/src/lib/kunci-idempotensi.ts`). The key is optional on the wire and carried by the OTP verify (register and sign-in), address create, starting and replying to a conversation, the anonymous payment confirmation and the anonymous order cancel; naturally idempotent operations are guarded but get none. `409 IDEMPOTENCY_CONFLICT` shows a clear message. Checkout, booking and the reservation cancel keep the keys they already had and adopt the shared guard.

- A new source-contract test fails the root suite when a script reaches a mutating call without importing the guard.
- **Release order:** the cross-origin `Idempotency-Key` header needs `idempotency-key` in the CMS routes' CORS preflight allow-list (issue #513 units B and C) before this client is deployed against them, or a browser blocks those requests.
- The new Playwright specs (`daftar-ketuk-ganda`, `checkout-ulang-jaringan`) were written without a browser and run on the trusted host.
