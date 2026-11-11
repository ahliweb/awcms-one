repo: ahliweb/awcms-one
branch: main

## Last sync
date: 2026-09-21T10:52:00Z

### Updated in this project
- Membaca token, palet, dan keputusan UI/UX repo sebagai dasar redesign.
- Membuat `Admin awcms-one.dc.html` — 12 layar panel admin.
- Membuat `Publik awcms-one.dc.html` — 11 halaman situs publik (profil `toko`).

## Screen map
| Layar | Sumber di repo |
| --- | --- |
| Admin (semua layar) | `apps/cms/src/styles/tokens.css`, `apps/cms/src/styles/admin.css`, `docs/cms.md` |
| Publik (toko + akun + afiliasi) | `apps/storefront/src/styles/global.css`, `docs/ui-ux.id.md` |
| Publik (berita, artikel) | `docs/ui-ux.id.md` (bagian permukaan berita increment 3) |
| Checkout (kurir, gateway) | `docs/ui-ux.id.md`, `docs/adr/0010`, `docs/adr/0017` |
