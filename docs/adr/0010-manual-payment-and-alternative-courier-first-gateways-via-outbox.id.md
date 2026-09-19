🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)

<!-- i18n-source-hash: sha256:18d1364662d2415397d7b74e16571744b8acfc5467891844d982318827aa2cbf -->

# ADR-0010 — Pembayaran manual dan kurir alternatif diutamakan; gateway dan agregator datang lewat outbox

- **Status:** Diterima
- **Tanggal:** 16 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** `apps/cms/AGENTS.md` ("Outbox/queue untuk integrasi eksternal"); issue #26, #29, #30, #33, #106, #109

## Konteks

Toko live memiliki transfer bank manual, QRIS manual, payment gateway (dikonfigurasi `none`), down-payment, tarif kurir RajaOngkir, kurir flat "BORNEOJEK" seharga Rp 15.000, dan self-pickup. Hanya QRIS manual, kurir alternatif, dan self-pickup yang benar-benar aktif di situs live saat ini.

## Keputusan

Increment 2 mengimplementasikan persis apa yang aktif: transfer bank manual dan QRIS manual (bukti pembayaran diunggah pelanggan, diterima atau ditolak admin), down-payment saat produk mengizinkannya, layanan kurir alternatif dengan biaya flat, dan self-pickup. Mesin status pesanan (`pending_payment → paid → processing → shipped → completed`, dengan `cancelled`/`expired` dapat dicapai dari `pending_payment`) dibangun sehingga webhook gateway nanti dapat mentransisikan `pending_payment → paid` lewat aturan `order-status.ts` yang sama yang dipakai admin hari ini. RajaOngkir dan payment gateway adalah provider eksternal dan — sesuai aturan tetap `apps/cms` — harus dipanggil lewat outbox, tidak pernah secara sinkron pada jalur pesanan; keduanya adalah #33, masing-masing dengan ADR-nya sendiri.

| | Gateway + agregator sekarang | Manual + kurir flat sekarang (**dipilih**) |
| --- | --- | --- |
| Kompleksitas operasional | dua akun provider, webhook, secret, pemisahan sandbox/production | tidak ada di luar bank/QRIS yang sudah ada di toko |
| Keamanan | verifikasi tanda tangan webhook, perlindungan replay, penanganan sedekat-PCI | bukti pembayaran adalah gambar yang ditinjau orang |
| Waktu hingga pesanan bekerja | terblokir oleh onboarding provider | langsung |
| Jangka panjang | tabel yang sama di kedua cara; mesin status agnostik-provider | enum `payment_method` sudah menamai `gateway`; menambahkannya bersifat aditif |

## Konsekuensi

- Pesanan yang belum dibayar kedaluwarsa (job `commerce:orders:expire`, setiap 1–5 menit) dan me-restock item barisnya, membatalkan-penukaran voucher apa pun lewat jalur kode yang sama yang sudah dijalankan pembatalan pelanggan sendiri; jendela kedaluwarsa adalah pengaturan toko (`orders.expiryHours`).
- Jalur unggah bukti-pembayaran (`POST .../orders/{code}/payment-proof/upload-sessions`) menjawab `503 MEDIA_UNAVAILABLE` di increment ini — alur upload-session `media_library` yang ada butuh `actorTenantUserId` terautentikasi, yang tidak dimiliki pemanggil storefront anonim; `payment.proofUpload: false` pada model-baca store-settings publik memberi tahu storefront untuk menyembunyikan kontrolnya, dan konfirmasi pembayaran tanpa gambar bukti masih sepenuhnya diterima.
- Checkout menampilkan opsi kurir sebagai "segera" (dinonaktifkan) sampai [issue #109](https://github.com/ahliweb/awcms-one/issues/109) (S1 dari #33) memberi storefront tarif kurir nyata per tujuan terhadap fixture berbasis stub — bentuk UI yang sama yang diantisipasi ADR ini, kini terisi: tarif nyata begitu kecamatan dipilih, placeholder tunggal yang dinonaktifkan sama seperti sebelumnya (kini membawa `note`) saat kurir mati, belum ada tujuan, atau penyedia tidak bisa menghitung tujuan itu. Adapter provider RajaOngkir milik `apps/cms` sendiri — kontrak yang dinamai [issue #106](https://github.com/ahliweb/awcms-one/issues/106) (D4) — masih menjadi setengah bagian #33 yang belum selesai; perubahan storefront ini ditulis sesuai bentuk kontrak itu sehingga menyambungkan provider nyata nanti tidak memerlukan perubahan UI.
