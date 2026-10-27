🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](bun-omnichannel-delivery-realtime.md)

<!-- i18n-source-hash: sha256:381ae852de45bc4e351b9a037d8588188c93b759a631dfcead5a069cfa7ebe02 -->

# Standar CRM AWCMS-One untuk dispatcher dan real-time Bun-only (usulan)

> **Persyaratan runtime, BUKAN bukti WebSocket/SSE sudah berjalan.** Issue [#467](https://github.com/ahliweb/awcms-one/issues/467), upstream AWCMS [#1167](https://github.com/ahliweb/awcms/issues/1167) dan ADR real-time [#1168](https://github.com/ahliweb/awcms/issues/1168), per 24 Oktober 2026. Kondisi aktual mengacu [status.md](status.id.md).

## Otoritas runtime dan kondisi kode

AWCMS-One adalah Bun monorepo dengan pin **`bun@1.4.4`** di `package.json`. `apps/cms` memuat upstream AWCMS sebagai **git subtree dengan seluruh sejarah**, pemrosesan kanal generik dimiliki upstream, dan `commerce` mengelola audience segmen, pemilihan kampanye serta adapter bisnis. Storefront Astro tetap memiliki profil SSG `toko`, `berita`, `landing`. **Semua layanan milik AWCMS-One** untuk broadcast email/WhatsApp/Telegram/Web Push pelanggan, publikasi media sosial, penjadwalan/outbox, SSE/WS dan gateway real-time **wajib menggunakan Bun sesuai versi repo**. Tidak boleh ada server Node.js, Socket.IO berbasis Node, runtime npm/yarn/pnpm atau dispatcher kampanye Python tersendiri. Import `node:*` yang kompatibel Bun serta adapter `@astrojs/node` yang dijalankan melalui Bun tetap boleh.

**Di luar cakupan:** OMES menjalankan worker host Python dengan HTTPS polling keluar bertanda tangan; Hermes menjalankan runtime agen sendiri; provider eksternal mengelola server mereka sendiri. Kebijakan ini tidak menulis ulang engine tersebut dan tidak menjadikannya server CRM.

## Matriks transport dan status

| Domain | Kondisi main saat ini | Standar target Bun |
| --- | --- | --- |
| Email/Mailketing generik | Upstream `email` mempunyai `bun run email:dispatch` dan adapter Mailketing v1 | Multi-akun/v2 CRM #461 dan upstream #1158–#1162 menggunakan antrean email dan API provider yang ada, tanpa mailer kedua |
| WhatsApp | Bun `whatsapp:dispatch` Meta/Fonnte/log; commerce masih memiliki migrasi mode legacy/upstream | StarSender multi-device / Meta multi-WABA #458/#1141–#1143 memakai **satu antrean WhatsApp Bun** sesudah cutover aman, default per tenant/brand; bukan lewat WebSocket |
| Web Push | Worker Bun `push:dispatch`; langganan perangkat pelanggan (#430) dan worker fan-out transaksional `commerce:customer-push:dispatch` (#432) sudah ada, push pemasaran dicadangkan dan belum dibangun | Worker push Bun dan service worker browser; bukan Node FCM/push |
| Telegram | `telegram_delivery` khusus staf | Multi-bot pelanggan #460/#1155–#1157 menggunakan kemampuan Bun yang diadmit terpisah; tidak memakai queue staf |
| Kampanye sosial | Registry/publikasi sosial masih direncanakan; segmen/kampanye commerce sudah tersedia | Worker Bun yang menghormati izin API, consent dan akun target |
| OMES/Hermes | Pemantauan host/agen ada; AI CRM #459 direncanakan | AWCMS Bun memproyeksikan status teredaksi; OMES worker host Python dan runtime Hermes tetap terpisah |
| Status admin real-time | Gateway WebSocket/SSE Bun generik belum terbukti ada | **Belum diimplementasikan:** polling aman sekarang, SSE Bun satu arah atau WebSocket native Bun dua arah setelah ADR #1168 |

**Alur durable:** transaksi domain → enqueue outbox → worker Bun claim/lease/retry → API HTTPS provider → webhook/status terverifikasi → audit tahan lama → event SSE/WS Bun untuk UI bila diadmit. WebSocket adalah transport **status**, bukan pengiriman email/WA/Telegram, sumber kebenaran inbox atau pengganti Web Push saat browser ditutup.

## Kontrol SSE/WebSocket mendatang (menunggu ADR)
- Utamakan **SSE Bun** untuk progres kampanye, hitungan dan notifikasi satu arah; gunakan **WebSocket native `Bun.serve`** hanya bila ada kebutuhan interaktif dua arah yang dibuktikan; polling HTTPS berizin adalah fallback. Validasi entrypoint Bun/Astro dan proxy HTTP/1.1 untuk WS.
- Jangan taruh bearer, API key, PII pada URL/frame koneksi. Verifikasi Origin, gunakan tiket sekali pakai berumur pendek atau session resmi, serta periksa tenant, brand, role, akun, kampanye dan topik berdasar ABAC/RLS. Topik tidak berasal dari ID tenant yang dipilih klien.
- Envelope berversi dan teredaksi dengan `tenant/campaign/channel/account/status/occurred_at/sequence/correlation`; tanpa daftar kontak/isi pesan mentah. Consent dan audit ditentukan backend, bukan lewat frame klien.
- Batasi koneksi, ukuran, idle/ping, backpressure, kuota tenant, upgrade rate, pencabutan hak, rekoneksi dan pemulihan snapshot REST. Untuk banyak instance gunakan mekanisme fan-out yang mendapat ADR; bedakan status basi/unknown.
- Jaga CSP `connect-src`, WCAG tanpa koneksi real-time, dan kondisi iOS/browser ditutup. Jangan tambah dependensi WebSocket yang mewajibkan Node.

## Issue dan gerbang pengujian

- Implementasi aktif: [AWCMS email](https://github.com/ahliweb/awcms/blob/main/src/modules/email/README.md), [WhatsApp](https://github.com/ahliweb/awcms/blob/main/src/modules/whatsapp-delivery/README.md), [Web Push](https://github.com/ahliweb/awcms/blob/main/src/modules/push-delivery/README.md); [AWCMS ADR-0002](https://github.com/ahliweb/awcms/blob/main/docs/adr/0002-bun-only-runtime.md).
- Fitur direncanakan: CRM #458, Hermes #459, Telegram #460, Mailketing #461, tes WA #466, Web Push #430–#432, standar CRM #462; upstream #1167/#1168.
- Tes: proses dan manifest deployment Bun, dua tenant dan consent, callback provider, upgrade auth/Origin/replay, status diterima versus delivered, crash/retry, pemulihan jaringan SSE/WS, OpenAPI/AsyncAPI, dokumen EN/ID, DB-backed tests, `bun test`, `bun run check`, `bun run check:cms`, audit dokumen/terjemahan, ketiga profil SSG dan `template:init`.
- Sinkronisasi upstream `apps/cms` selalu memakai **git subtree MERGE COMMIT, tidak squash/rebase**; tag upstream tidak ikut diimpor. Migrasi yang sudah diterapkan dan `bun.lock` tidak boleh diubah manual.

## Tindak lanjut penegakan atomik (2026-10-24)

- [AWCMS #1170](https://github.com/ahliweb/awcms/issues/1170) menegakkan Bun pada worker/manifes deployment.
- [AWCMS #1171](https://github.com/ahliweb/awcms/issues/1171) merancang dan membangun gateway SSE-first/WebSocket Bun hanya setelah ADR [#1168](https://github.com/ahliweb/awcms/issues/1168) diterima.
- [AWCMS-One #469](https://github.com/ahliweb/awcms-one/issues/469) menguji manifest/job/commerce Bun tanpa mengubah subtree upstream; spesifikasi tetap berupa dokumen sampai PR implementasi selesai.
