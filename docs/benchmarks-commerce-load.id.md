🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](benchmarks-commerce-load.md)

<!-- i18n-source-hash: sha256:4c28cda5953184109e0a31d954c4f27a450ebf61c947de9b7351d78db007290d -->

# Benchmark beban dan konkurensi commerce (issue #395)

Angka terukur untuk jalur uang-dan-inventaris `commerce` di bawah beban konkuren, serta verifikasi PRD M7 (p95 pratinjau segmen paling lama 3 dtk pada 100.000 pelanggan). Satu perintah, dijalankan dari `apps/cms`: `bun run bench:commerce-load` (entri `apps/cms/scripts/bench-commerce-load.ts`, implementasi `apps/cms/tests/bench/commerce-load-bench.ts`). Pendamping `apps/cms/docs/awcms/booking-benchmarks.md` milik upstream yang mem-benchmark alokator booking itu sendiri; dokumen ini mem-benchmark apa yang dibangun modul `commerce` repositori ini di atasnya ([ADR-0045](adr/0045-booking-commerce-adapter.md), [ADR-0043](adr/0043-loyalty-points-are-redeemed-as-a-server-priced-discount-line-written-with-the-ledger-debit.md)).

## Bukan bagian dari suite tes

Asersi waktu di dalam `bun test` adalah tes yang rapuh, jadi benchmark ini bukan `*.test.ts` dan tidak ada di `bun run check`. Ia menolak berjalan tanpa `DATABASE_URL` superuser (exit 2). Dua jenis asersi dijaga terpisah:

- **Invarian** selalu diberlakukan (exit 1): tidak ada alokasi ganda, tidak ada pengeluaran ganda, tidak ada saldo negatif, satu keadaan akhir yang konsisten per order.
- **Ambang** (anggaran latensi dan throughput, serta M7 sendiri) diberlakukan pada profil `standard` kecuali `--no-thresholds`. Tiap ambang berjarak lebar dari angka di bawah, kecuali `segmentPreviewP95Ms` yang merupakan target M7 (3.000 ms) itu sendiri.

## Dijalankan terhadap apa

Database sekali pakai milik harness integrasi: semua migrasi nyata, dan peran produksi (`awcms_app` di bawah FORCE RLS untuk jalur request, `awcms_worker` untuk reaper booking). Setiap peserta adalah koneksi dan transaksi tersendiri, sehingga database melihat semua peserta sekaligus. Pekerjaan ini tidak mengubah kode produksi.

## Lingkungan run yang tercatat

| Butir                | Nilai                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Tanggal              | 17 Oktober 2026                                                                                   |
| Commit               | `37c970fd` (terverifikasi: dasar, yaitu induk, commit harness `01953109` milik PR #425)           |
| CPU                  | Intel Xeon @ 2,10 GHz, `nproc` = 4                                                                |
| Memori               | `free -g`: total 15 GiB, tersedia 14 GiB                                                          |
| Bun                  | 1.4.2                                                                                             |
| PostgreSQL           | 18.4 (Debian 18.4-1.pgdg13+1), kontainer `postgres:18.4`, konfigurasi bawaan, pada host yang sama |
| Pool runtime         | 40 koneksi                                                                                        |
| Load average (1 mnt) | 1,84 saat run dimulai; 3,73 saat selesai (benchmark sendiri memenuhi 4 CPU)                       |
| Profil               | `standard`; waktu dinding 99 dtk                                                                  |

Database dan benchmark berbagi satu mesin 4 vCPU, sehingga angka mutlak adalah batas bawah untuk perangkat keras khusus, bukan batas atas. Pemeriksaan agen lain berjalan di host yang sama; beban di bawah 2 hanya saat run dimulai.

## Metode dan hasil

### 1. Hold konkuren yang dikonversi menjadi order pada satu slot berkapasitas terbatas

Tiap ronde membuat kumpulan unit sebanyak `capacity` dan menembakkan N permintaan reservasi serentak (hold beserta ordernya, ADR-0045 G2/G4), 20 ronde per sel. Invarian: tepat `capacity` order per ronde, setiap pecundang `SLOT_UNAVAILABLE`, alokasi hidup sama dengan pemenang. Badai replay mengirim 32 permintaan dengan satu kunci idempotensi dan mengharapkan satu order. Run berkelanjutan mengukur throughput tanpa persaingan pada 16 jalur.

| Sel                     | Permintaan | Order dibuat             | Peserta p50 | p95    | p99    | maks   |
| ----------------------- | ---------- | ------------------------ | ----------- | ------ | ------ | ------ |
| kapasitas 1, 8 peserta  | 160        | 20 (1/ronde)             | 90 ms       | 166 ms | 206 ms | 206 ms |
| kapasitas 5, 8 peserta  | 160        | 100 (5/ronde)            | 126 ms      | 215 ms | 248 ms | 248 ms |
| kapasitas 1, 32 peserta | 640        | 20 (1/ronde)             | 141 ms      | 174 ms | 217 ms | 218 ms |
| kapasitas 5, 32 peserta | 640        | 100 (5/ronde)            | 221 ms      | 251 ms | 269 ms | 270 ms |
| badai replay (32 x 10)  | 320        | 10 dibuat, 310 di-replay | 46 ms       | 67 ms  | 83 ms  | 88 ms  |
| berkelanjutan, 16 jalur | 300        | 300                      | 280 ms      | 397 ms | 412 ms | 441 ms |

Throughput berkelanjutan: **55,6 order per detik**. Hasil: tidak ada alokasi ganda, tepat `capacity` pemenang di setiap ronde, satu order per kunci yang di-replay.

### 2. Kedaluwarsa hold berpacu dengan penyelesaian pembayaran

500 order independen dalam tiga kohort: 100 dibayar sebelum reaper mulai, 300 berpacu (pembayaran pada saat acak sepanjang dua kali jendela 5 dtk, hold berakhir di jendela), 100 belum dibayar dan sudah lewat. Reaper booking (sebagai `awcms_worker`), penyelesaian pembayaran (`recordOwnerPayment`), dan dispatcher event domain berjalan bersamaan. Invarian (ADR-0045): setiap order berakhir tepat di satu dari tiga keadaan, dan pembayaran yang dikembalikan ok tertahan sedangkan yang ditolak tidak.

| Keadaan akhir                                                                               | Dibayar dulu | Berpacu | Belum dibayar lewat |
| ------------------------------------------------------------------------------------------- | ------------ | ------- | ------------------- |
| `confirmed` (order paid, reservasi confirmed, tanpa tanda perhatian)                        | 100          | 86      | 0                   |
| `paid_after_expiry_flagged` (paid, reservasi expired, `deposit_after_expiry` belum selesai) | 0            | 132     | 0                   |
| `closed_unpaid` (order expired atau cancelled, reservasi expired, tidak ada uang tertahan)  | 0            | 82      | 100                 |
| Tidak konsisten                                                                             | 0            | 0       | 0                   |

Penyelesaian pembayaran saat balapan: p50 13,8 ms, p95 24,6 ms, p99 29,5 ms, maks 40,6 ms. Reaper mengakhiri 314 hold; balapan memakan 10,0 dtk untuk 500 order (40 order per detik termasuk jeda tidur); tidak ada pengiriman event domain yang diulang atau masuk dead-letter. Alokasi hidup sama dengan reservasi terbuka dan tidak ada reservasi yang tertinggal `held`. Order berbayar tidak pernah dibatalkan otomatis: 132 pembayaran terlambat ditandai untuk diselesaikan orang, aturan ADR-0045.

### 3. Penukaran poin loyalti konkuren pada satu akun

Satu akun, N penukaran serentak masing-masing 1.000 poin, 20 ronde; saldo diatur agar sekitar separuh dapat menang. Invarian: pemenang = floor(saldo / poin), sisanya ditolak karena poin tidak cukup, saldo tidak pernah negatif, buku besar berjumlah sama dengan saldo tersimpan, `reconcileLoyaltyForTenant` tidak menemukan penyimpangan.

| Sel        | Saldo  | Pemenang per ronde | Order dibuat | Ditolak | Peserta p50 | p95    | p99    | maks   |
| ---------- | ------ | ------------------ | ------------ | ------- | ----------- | ------ | ------ | ------ |
| 8 pekerja  | 4.500  | 4                  | 80           | 80      | 64 ms       | 103 ms | 121 ms | 125 ms |
| 32 pekerja | 16.500 | 16                 | 320          | 320     | 183 ms      | 238 ms | 260 ms | 268 ms |

Hasil: tidak ada pengeluaran ganda, 0 saldo negatif, 0 akun menyimpang, 0 putusnya buku besar.

### 4. Pratinjau segmen pada 100.000 pelanggan (PRD M7)

Tenant dengan 100.000 pelanggan dan 250.000 order berbayar (seeding 15,7 dtk) dievaluasi oleh evaluator endpoint pratinjau dengan lima bentuk aturan, masing-masing 12 ronde (60 sampel), setelah 5 evaluasi pemanasan. Dijalankan juga dengan 2 aktor pada batas evaluasi tenant dan 6 aktor di atasnya, tempat kelebihan ditolak dengan hasil sibuk.

| Ukuran                                   | p50    | p95        | p99    | maks   |
| ---------------------------------------- | ------ | ---------- | ------ | ------ |
| Pratinjau berurutan (60 sampel)          | 293 ms | **410 ms** | 510 ms | 510 ms |
| 2 aktor konkuren (12 dilayani)           | 197 ms | 454 ms     | 454 ms | 454 ms |
| Lonjakan 6 aktor (12 dilayani, 24 sibuk) | 273 ms | 387 ms     | 387 ms | 387 ms |

p95 per aturan: `level_in_1_2` 28 ms (50.000 anggota), `order_count_gte_2` 244 ms (100.000), `windowed_orders_spend_not_lapsed` 410 ms (100.000), `account_loyalty_spend_or_tenure` 314 ms (16.666), `two_windows_and_never_not` 510 ms (100.000).

**M7 terverifikasi: p95 410 ms terhadap target 3.000 ms, margin sekitar 7 kali.** Lonjakan di atas batas selesai dalam 3,98 dtk waktu dinding, kelebihannya ditolak, bukan diantrekan.

### 4b. Pratinjau segmen dengan aturan turunan booking (issue #390, [ADR-0051](adr/0051-booking-derived-segment-rules-are-rule-schema-2-read-live-through-the-booking-links-and-never-stored.md))

Skenario yang sama (`bun run bench:commerce-load --only segment`) kini menyemai tenant yang juga menjual menginap dan mengevaluasi **sepuluh** bentuk aturan: lima di atas ditambah lima yang membaca fakta turunan booking (hitungan menginap luas; jendela dengan pengecualian tidak-hadir; fakta pesanan, menginap, kebaruan, dan pembatalan bersama; OR di kedua pemindaian booking; semua keluarga sekaligus dengan tiga jendela). Tenantnya: 100.000 pelanggan, 340.000 pesanan lunas (250.000 biasa dan 90.000 pesanan booking), 90.000 tautan booking dengan campuran status properti yang beroperasi, 29.999 keputusan pembatalan dan tidak-hadir (penyemaian memakan 37 d). Dijalankan di mesin 4-CPU yang sama pada 25 Oktober 2026, PostgreSQL 18.4, Bun 1.4.4, **load average 4,2 sebelum lari** (pekerjaan lain berbagi mesin, sehingga angka ini konservatif), profil standar, 12 putaran (120 sampel) setelah 10 evaluasi pemanasan.

| Ukuran                                         | p50    | p95         | p99     | maks    |
| ---------------------------------------------- | ------ | ----------- | ------- | ------- |
| Pratinjau berurutan (120 sampel, sepuluh bentuk) | 496 md | **1941 md** | 2021 md | 2070 md |
| 2 aktor bersamaan (12 dilayani)                | 462 md | 952 md      | 952 md  | 952 md  |
| Lonjakan 6 aktor (12 dilayani, 24 sibuk)       | 622 md | 937 md      | 937 md  | 937 md  |

p95 per aturan: lima bentuk commerce 36 / 281 / 528 / 438 / 585 md (seperti sebelumnya, dalam derau beban); `booking_stay_count_gte_1` 612 md (28.858 anggota), `booking_window_not_no_show` 888 md (21.144), `booking_orders_stay_recency_no_cancel` 1.062 md (7.858), `booking_or_across_scans` 1.015 md (35.571), `booking_every_family_three_windows` 2.070 md (571).

**M7 bertahan dengan aturan booking: p95 1.941 md terhadap target 3.000 md (margin sekitar 1,5 kali pada mesin yang sibuk).** Bentuk paling lambat membaca semua keluarga sekaligus; pemindaian booking saja memakan sekitar 270-300 md pada ukuran ini (sekitar 25 md bila fakta yang sama dibaca dari tabel yang sudah dihitung, opsi yang ditolak ADR-0051 D4). Aturan yang tidak membaca fakta booking tidak menjalankan pemindaian booking: bentuk commerce tidak melambat. Perbandingan lima-dan-lima yang sama di dalam tes integrasi `commerce-segment-booking-rules.integration.test.ts` memberi p95 1,7-1,8 d pada tiga lari. Jalur satu-pelanggan (perolehan loyalitas) memakan 187 md untuk 200 pemeriksaan pada data ini. Pada mesin dengan load average di atas 7, satu pratinjau dibatalkan oleh statement timeout 5 d, yaitu batas yang bekerja saat kontensi.

## Hasil invarian

| Invarian                                                               | Hasil     |
| ---------------------------------------------------------------------- | --------- |
| Tepat `capacity` order per ronde, tanpa alokasi ganda                  | terpenuhi |
| Kunci idempotensi yang di-replay membuat satu order                    | terpenuhi |
| Setiap order di satu keadaan akhir konsisten (500 dari 500)            | terpenuhi |
| Pembayaran diterima tertahan, pembayaran ditolak tidak                 | terpenuhi |
| Tidak ada pembatalan otomatis order yang menahan uang                  | terpenuhi |
| Tanpa pengeluaran ganda loyalti; saldo tak negatif; buku besar = saldo | terpenuhi |
| Rekonsiliasi loyalti: penyimpangan 0, putus buku besar 0               | terpenuhi |
| p95 M7 paling lama 3.000 ms                                            | terpenuhi |

Tidak ada pelanggaran ditemukan, sehingga kode produksi tidak disentuh.

## Menjalankan ulang

Lihat [`pengujian.md`](pengujian.id.md) untuk perintah persisnya. `--profile smoke` memeriksa invarian pada skala kecil dalam beberapa detik; `--only hold,race,loyalty,segment` memilih skenario; `--json <berkas>` menulis angka mentah. Ukur ulang di perangkat keras yang tenang (load 1 menit di bawah 2) sebelum membandingkan dengan angka ini.
