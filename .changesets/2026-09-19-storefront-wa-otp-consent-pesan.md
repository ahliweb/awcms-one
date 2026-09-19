---
bump: minor
type: structure
impact: public
---

# WhatsApp OTP, marketing consent, and `/akun/pesan` (issue #115, S3 of #33)

Sign-in gains a second OTP channel, `/akun` gains a promo-consent toggle,
and signed-in shoppers gain a message inbox with the store. Coded against
the contract [issue #106](https://github.com/ahliweb/awcms-one/issues/106)
(D5/D8/D9) names, so wiring `apps/cms`'s own WhatsApp adapter and inbox
storage in later needs no storefront change.

- `/masuk` renders a "Kirim kode lewat: E-mail | WhatsApp" channel choice
  only when the public store settings' new `whatsappOtpEnabled` is `true`
  at build time; choosing WhatsApp swaps the identifier field to a phone
  input (`type="tel"`, `autocomplete="tel"`, an Indonesian-format hint) and
  both request/verify send `phone`. `409 CHANNEL_UNAVAILABLE` is a plain
  message, not a dead end. `/daftar` stays e-mail-only, with a one-line note
  saying so — registration is never offered a channel choice.
- `/akun` gains a "Preferensi Promo" card: a real `<input type="checkbox">`
  in its own `<label>`, saving on `change` (`PATCH …/account/me
  {marketingConsent}`), confirmed through an `aria-live="polite"` region,
  reverting its own checked state on failure with no reload.
- `/akun/pesan` (new page + script) mirrors `/akun/pesanan`'s own
  list/`?id=`-detail split: a keyset-paginated conversation list with an
  `aria-label`'d unread badge, a "Pesan baru" form, a thread view with a
  reply form shown only while the thread is open (a closed thread shows a
  note instead). `ROUTES.accountMessages`/`accountMessage(id)` and a new
  dashboard nav card round this out.
- `akun-klien.ts` gains `via`/`phone` on the OTP request/verify functions,
  a `{name?, marketingConsent?}` `ubahProfil` input, and
  `ambilPercakapan`/`buatPercakapan`/`ambilPercakapanById`/
  `kirimPesanPercakapan` — every one bearer-only through the same
  `denganPembersihanSesi` wrapper every other account call already uses.
  `akun-kontrak.ts`'s `Akun` gains `marketingConsent: boolean` (defaults to
  `false` for a session stored before this field existed).
- `apps/storefront/scripts/stub-awcms.mjs` implements the whole surface:
  WhatsApp OTP for the fixture phone `+6281234567890` (code `123456`,
  `409 CHANNEL_UNAVAILABLE` when `whatsappOtpEnabled` is off),
  `marketingConsent` on every account, and a conversations state machine
  seeded with one open thread (an unread store reply already on it) and one
  closed thread — every new customer message schedules a simulated store
  auto-reply 2 seconds later, so unread flags are exercised without a
  manual second message.

`apps/storefront/tests/pesan-build-smoke.test.ts` (new file) proves the
real build; `akun-klien.test.ts`/`akun-kontrak.test.ts` gain unit coverage
for every new request shape and the `marketingConsent` default.
