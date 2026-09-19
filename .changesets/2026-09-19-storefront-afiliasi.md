---
bump: minor
type: structure
impact: public
---

# Affiliate program, from the shopper's side: `?ref=` capture, checkout attribution, `/akun/afiliasi` (issue #93, S3 of #32)

`apps/storefront` gains the shopper-facing half of #86's freshly designed affiliate program (D5) — the CMS/staff side is issue #92, tracked separately.

- `apps/storefront/src/lib/afiliasi-kontrak.ts` is a new pure-plus-storage contract: `validasiKodeAfiliasi` accepts exactly the contract's 8-character unambiguous-base32 code shape (`A`–`Z` without `I`/`O`, digits `2`–`9`), lenient on case; `bacaKodeAfiliasi`/`simpanKodeAfiliasi` read/write `localStorage` key `awcms-one:afiliasi:v1` (`{code, capturedAt}`), with a 30-day TTL an expired read drops and cleans up. Every storage access is guarded — a private window or blocked storage reads as "no referral captured", never throws.
- `apps/storefront/src/scripts/afiliasi-tangkap.ts`, mounted once from `BaseLayout.astro`'s existing script block (every page, not just the home page — a `?ref=` link can land a shopper anywhere), captures a valid `?ref=` on load and removes ONLY that parameter with `history.replaceState`, so canonical URLs stay clean without touching any other query string.
- `checkout.ts` sends `affiliateCode: bacaKodeAfiliasi()?.code ?? null` with every order — `toko-klien.ts`'s `CreateOrderRequest` gains the field additively. The CMS ignores an unknown/suspended code entirely (#86's D5): a bad or expired capture never blocks checkout.
- `apps/storefront/src/lib/awcms/pemasaran.ts`'s `StoreSettings` gains an optional `affiliateProgramEnabled` boolean, read from the public store-settings fetch at build time and defaulting to `false` when an older awcms does not send it — the same additive pattern `payment.proofUpload` already established.
- `/akun/afiliasi` (`afiliasi.astro` + `akun-afiliasi.ts`): when the program is disabled at build time, a short explanation and no controls at all; otherwise guest → link to `/masuk`; signed in with no affiliate row → "Gabung program afiliasi" (handles `409 AFFILIATE_PROGRAM_DISABLED`); enrolled → the referral link in a read-only input with a copy button (the same clipboard-API-plus-silent-fallback shape as `voucher-copy.ts`), commission rate, an Indonesian status label (Aktif/Ditangguhkan), stats formatted with `harga.ts`'s `formatPrice` (never computed client-side), and a keyset-paginated commissions list ("Muat lebih banyak") with per-row status labels (Menunggu/Disetujui/Dibayar/Dibatalkan). `aria-live`, `<noscript>`, a WhatsApp fallback, 44px controls, one `<h1>`, `noindex, follow` (the `/akun` `Disallow` prefix already covers the fetch).
- `apps/storefront/src/lib/akun-klien.ts` gains `ambilAfiliasi`, `gabungAfiliasi`, `ambilKomisiAfiliasi(cursor)` — bearer-only, wrapped in the same session-clearing behaviour every other function in that file already uses.
- `/akun`'s dashboard already links its "Afiliasi" card at `ROUTES.accountAffiliate` (declared since issue #88) — this issue is what makes that link resolve to a real page instead of a 404.
- `apps/storefront/scripts/stub-awcms.mjs` grows per-account `affiliate`/`commissions` state and `GET/POST /account/affiliate` + `GET /account/affiliate/commissions`; the fixture account (`budi@example.test`) is seeded already enrolled with a deterministic code and three commissions, one per status; a freshly registered account starts unenrolled. `POST /orders` records `affiliateCode` on the created order when present. `apps/storefront/tests/fixtures/awcms/store-settings-public.json` sets `affiliateProgramEnabled: true`.
