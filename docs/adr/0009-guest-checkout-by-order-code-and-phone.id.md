🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0009-guest-checkout-by-order-code-and-phone.md)

<!-- i18n-source-hash: sha256:6b3e13a4b2e46de5ad2b586be19c3c097ceb6ae7c8f4d768020026b9e08b8803 -->

# ADR-0009 — Checkout tamu, dialamatkan dengan kode pesanan + telepon; akun pelanggan menyusul kemudian

- **Status:** Diterima
- **Tanggal:** 16 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md); issue #29, #30, #32

## Konteks

mart.borneojek.com mensyaratkan akun untuk checkout (registrasi, verifikasi e-mail, login) dan menawarkan dashboard. Membangun akun lebih dulu berarti membangun penerbitan sesi, CSRF, reset password, dan verifikasi e-mail di permukaan runtime storefront sebelum satu pesanan pun bisa dibuat.

| | Akun lebih dulu | Checkout tamu lebih dulu (**dipilih**) |
| --- | --- | --- |
| Permukaan keamanan | password, sesi, token reset, tautan verifikasi, CSRF — semua di increment runtime pertama | tanpa penyimpanan password, tanpa penyimpanan sesi; kode pesanan + telepon yang memesannya adalah kredensial untuk pelacakan |
| UX | tembok registrasi sebelum pesanan pertama (titik drop-off terbesar situs live, by design) | pesan dalam satu form; halaman konfirmasi bisa di-bookmark dan dijangkau lagi dari pesan WhatsApp |
| Kompatibilitas | cocok dengan situs live | cocok dengan alur *guest-visible* situs live; akun tiba di tabel yang sama (#32) |
| Jangka panjang | baris pelanggan lahir dengan kredensial | `awcms_commerce_customers` di-key dengan telepon sejak hari pertama, yang memang dibutuhkan login OTP |

## Keputusan

Increment 2 mengirimkan checkout tamu. `awcms_commerce_customers` dibuat atau dipakai ulang berdasarkan telepon ternormalisasi (E.164) saat pesanan dibuat, dan tidak membawa kredensial apa pun. `GET .../storefront/orders/{orderCode}?phone=` menjawab 404 netral kecuali pasangannya cocok; pengecekan telepon berjalan di dalam transaksi, bukan hanya saat persiapan request. Wishlist tetap browser-local (`localStorage`). Akun, wishlist/alamat/ulasan yang tersinkron, dan program afiliasi ada di #32, pada baris-baris yang sama ini.

## Konsekuensi

- Pelanggan yang kehilangan baik kode pesanan maupun akses ke nomor teleponnya tidak bisa melacak pesanan secara mandiri; tautan WhatsApp toko dengan kode terisi otomatis adalah fallback yang didokumentasikan.
- Ulasan mensyaratkan pesanan `completed` untuk produk itu dan dimoderasi (`pending` → `published`/`rejected`) sebelum dipublikasikan.
- 8 tabel yang dibuat keputusan ini (`awcms_commerce_{customers,customer_addresses,orders,order_items,order_events,payment_confirmations,reviews,wishlists}`) adalah `unreachableBySubject: true` di deskriptor data-lifecycle/subject-data modul ini — tamu yang hanya diidentifikasi lewat nomor telepon bertipe tidak memiliki satu pun konsep identitas sisi-staf (`tenant_user`/`identity`/`profile`/`principal`) yang menjadi dasar kosakata subject-data basis kode itu; permintaan penghapusan/ekspor yang genuine sebagai gantinya ditangani sebagai lookup admin biasa.
