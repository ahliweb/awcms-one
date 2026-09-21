---
bump: minor
type: structure
impact: public
---

# Storefront redesign — account and affiliate pages

Wave 2 of the 2026-09 redesign (issue #168), built on issue #166's foundation (`.btn`, `.pill`, `.field-label`/`.is-mono`, the 42px form controls) — markup/CSS only across `apps/storefront/src/profil/toko/pages/akun/**`, `masuk.astro`, `daftar.astro`, `apps/storefront/src/styles/akun.css`, and the account scripts' own DOM-building code. The bearer-session client (`akun-sesi.ts`/`akun-klien.ts`) and every data-fetching contract are unchanged; every pre-existing `data-*` hook a test asserts on is unchanged.

- **Account shell**: an avatar tile (initials on `--bg-inverse`), the account's name/e-mail, and a "Keluar" button, plus a persistent side navigation (Ringkasan/Pesanan/Alamat/Pesan/Ulasan/Afiliasi) with `aria-current="page"` on the six account pages.
- **Ringkasan**: three stat tiles (pesanan / sedang berjalan / wishlist), computed from `akun-klien.ts` functions the client already exposes — no new endpoint. The promo-preference checkbox (issue #115) is unchanged behaviour, restyled.
- **A shared status-pill tone map** across orders/reviews/affiliate/commissions: pending → warning, paid/published/approved/completed/active → success, cancelled/expired/rejected/void/suspended → danger, processing/shipped → info.
- **Pesanan/Alamat/Pesan/Ulasan**: order rows, address cards ("Utama" pill, dashed "+ Tambah alamat"), message threads (unread pill, arrow), and review cards (mono star rating on a new `--text-rating` token scoped to `akun.css`).
- **Afiliasi**: a status pill, the referral link in a dashed mono box (a real focusable `<input readonly>`), a "Salin"/"Tersalin!" copy button (behaviour unchanged), four stat tiles, and a commission table.
- **Masuk/Daftar**: the same 42px form controls, `.field-label`, `.is-mono` phone/OTP inputs, and `.btn` submit/resend controls.

Documented in `docs/ui-ux.md`'s "Design system (2026-09 redesign)" section under a new "Account & affiliate pages, redesigned (issue #168)" heading (+ Indonesian mirror).
