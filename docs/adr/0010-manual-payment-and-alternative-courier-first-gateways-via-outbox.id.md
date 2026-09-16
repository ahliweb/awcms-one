🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md)

<!-- i18n-source-hash: sha256:9a85ace383e1c71062b7bfc45e63a0a19931508fb39ecfc8785b9ff620525c57 -->

# ADR-0010 — Pembayaran manual dan kurir alternatif diutamakan; gateway dan agregator datang lewat outbox

- **Status:** Diterima
- **Tanggal:** 16 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** `apps/cms/AGENTS.md` ("Outbox/queue untuk integrasi eksternal"); issue #26, #29, #30, #33

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
- Checkout menampilkan opsi kurir sebagai "segera" (dinonaktifkan) sampai #33 mendarat, sehingga bentuk UI tidak berubah ketika integrasi RajaOngkir berubah.
