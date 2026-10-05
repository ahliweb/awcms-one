🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0037-the-commerce-migration-band-is-allocated-gap-first-and-widened-upstream.md)

<!-- i18n-source-hash: sha256:ece0d1591a6d56a5b7a0661f1beeef30255f28c4dc0fea1e158f49576991f411 -->

# ADR-0037 — Pita migrasi commerce dialokasikan celah-dulu, dan diperluas upstream

- **Status:** Diterima
- **Tanggal:** 5 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md), [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md), [ADR-0035](0035-pos-operational-reports-are-commerce-projections-over-the-existing-ledgers-on-the-reporting-engine.md); isu #281, #282, #283, #290, #293

## Konteks

ADR-0015 memberikan modul `commerce` repo ini pita `900`–`999` di `apps/cms/sql/`. Epik OSPOS (#281) menggunakan ujung pita itu: `sql/998` dan `sql/999` ada, dan tidak ada yang bisa melebihi mereka. Catatan status epik terakhir mengatakan pita itu "penuh kecuali 947–949 dan 953–959". Pemindaian `main` pada 5 Oktober 2026 menemukan lebih banyak ruang dari itu. Dua puluh nomor tidak pernah dipakai di cabang mana pun: `900`, `944`, `947`–`949`, `953`–`959`, `968`, `969`, `977`–`979`, `983`, `984` dan `989`.

Tiga isu terbuka sekarang membutuhkan migrasi, karena upstream `ahliweb/awcms` v10.5.0 mengirimkan fondasi yang mereka tunggu:

- #282 adalah adaptor commerce di atas buku besar inventori.
- #293 adalah adaptor commerce di atas modul pajak.
- #290 adalah bundel, dan sudah memegang `953`–`959`.

#283 (pengadaan) mungkin membutuhkan satu lagi.

Jumlah slot bebas bukan kendala pengikat. **Urutan** adalah. `apps/cms/scripts/db-migrate.ts` (upstream, tidak pernah disunting di sini) menerapkan setiap berkas *yang belum diterapkan* dalam urutan leksikal. Berkas yang ditempatkan dalam celah karenanya berjalan pada dua titik berbeda dalam dua basis data berbeda:

| Basis data                                 | Saat `948_…` baru berjalan                   |
| ---------------------------------------- | -------------------------------------------------------- |
| Segar (CI, aplikasi turunan baru, pemulihan) | Sebelum `949`–`999`, di tempat leksikal-nya                 |
| Sudah dimigrasikan melewati `999`              | Setelah `999`, karena semuanya di bawahnya sudah diterapkan |

Migrasi celah yang merujuk pada objek yang dibuat berkas bernomor lebih tinggi karenanya bekerja pada setiap basis data yang ada dan gagal pada setiap basis data segar. Ia juga bisa diterapkan tetapi berperilaku berbeda, misalnya blok `DO` yang menguji keberadaan tabel. Tidak ada nomor bebas yang berada di atas `989`. Apa pun yang harus merujuk tabel retur (`994`–`997`) atau tabel laporan operasional (`998`, `999`) tidak memiliki slot valid yang tersisa.

## Keputusan

**D1. Alokasikan celah secara eksplisit, menurut isu.** Dicatat di sini dan tidak di tempat lain:

| Nomor                | Pemilik                                                        |
| ------------------- | ------------------------------------------------------------ |
| `947`               | #282 — adaptor inventori commerce                            |
| `948`               | #293 — adaptor pajak commerce                                  |
| `949`               | #283 — integrasi pengadaan, jika membutuhkan migrasi      |
| `953`–`959`         | #290 — bundel / item kit (tidak berubah dari rencana #281)    |
| `968`, `969`        | Pita pool yang tidak dialokasikan                                |
| `977`–`979`         | Pita pool yang tidak dialokasikan                                |
| `983`, `984`, `989` | Pita pool yang tidak dialokasikan                                  |
| `900`, `944`        | Ditahan. Diambil hanya dengan amandemen ADR ini                          |

Isu kemudian mengambil nomor pool terendah yang memenuhi D2. Ia mencatat alokasi dengan mengamandemen tabel ini dalam perubahan yang sama.

**D2. Migrasi celah hanya boleh bergantung pada objek yang dibuat berkas bernomor lebih rendah.** Itu mencakup setiap tabel, kolom, fungsi, tipe, pemberian peran dan baris izin yang dirujuknya, termasuk yang disentuh pemicu atau blok `DO`. Upstream `001`–`899` dan pita `880`–`899` repo ini selalu diurutkan lebih rendah, jadi selalu aman. Pemeriksaan yang menegakkan ini adalah yang sudah berjalan: `local-ci/check-cms` memigrasikan PostgreSQL 18 **segar** dari `001` pada setiap PR, jadi referensi maju gagal CI daripada penerapan. Perubahan yang tidak bisa memenuhi D2 tidak mendapat nomor celah. Ia menunggu D3.

**D3. Perluas pita upstream, bukan di sini.** Perbaikan yang tahan lama adalah agar `db-migrate.ts` menerima awalan empat digit dan mengurutkan berkas menurut nilai numerik awalan mereka. Setelah melakukannya, repo ini melanjutkan di `1000` tanpa penomoran ulang. Setiap nama yang ada persis tiga digit, dan di antara nama dengan lebar yang sama, urutan numerik adalah urutan leksikal. Perubahan itu kompatibel ke belakang untuk upstream dan untuk setiap aplikasi turunan. Ia diusulkan upstream sebagai peningkatan pelari generik di bawah ADR-0024 D3 upstream, sebagai [ahliweb/awcms#911](https://github.com/ahliweb/awcms/issues/911). Ia **bukan** ditambal secara lokal: ADR-0015 sudah menolak penyuntingan `db-migrate.ts` di sini, karena alasan yang masih berlaku, yaitu konflik senyap pada setiap tarik subtree mendatang. Saat perubahan upstream tiba melalui sinkronisasi normal, `apps/cms/tests/commerce-migrations-range.test.ts` diperluas dalam sinkronisasi yang sama itu untuk menerima `900`–`9999`.

### Opsi yang dipertimbangkan

| Opsi                                                                                    | Penilaian                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Alokasi celah-dulu sekarang, perluasan empat digit upstream** (dipilih)                       | Ia membuka blokir #282, #283, #290 dan #293 hari ini. Masing-masing telah diperiksa bergantung hanya pada `901`–`905` (katalog dan pesanan), upstream `169`–`175` dan tabel pengaturan, tidak pernah pada `994`–`999`. CI basis data segar menegakkan aturan pengurutan. Perbaikan yang tahan lama mendarat di mana pelari hidup.                                                                          |
| Pakai ulang awalan (`999_awcms_commerce_z_…`), andalkan pengurutan dalam-awalan pelari | Ia bekerja secara mekanis, karena pelari tidak mewajibkan awalan unik dan tes rentang menerimanya. Tetapi urutan kemudian bergantung pada ejaan alfabet sisa nama, yang tidak ada yang baca sebagai sinyal pengurutan. ADR-0015 menolak persis pendekatan "dokumentasikan pengikat leksikal" ini. Dalam pita kami sendiri ia kurang berbahaya, tetapi sama kuatnya tidak jelas. Ditolak. |
| Tambal `MIGRATION_FILE_PATTERN` secara lokal                                                    | Satu perbedaan pendirian pada berkas upstream satu-satunya yang setiap penerapan jalankan. Ditolak oleh ADR-0015 dan masih ditolak.                                                                                                                                                                                                                   |
| Beri nomor ulang migrasi commerce yang ada untuk membuka ruang di atas                        | Checksum migrasi yang diterapkan tidak dapat berubah dan setiap basis data yang diterapkan memberi kunci mereka menurut nama. Setiap operator perlu rename buku besar, biaya sama dengan `db:commerce:renumber` sekali-saja ADR-0015, dan ia hanya membeli beberapa lusin slot. Ditolak.                                                                  |
| Lipat beberapa kekhawatiran ke dalam satu berkas migrasi                                             | Masih diizinkan, dan didorong, di mana kekhawatiran dikirim dalam satu PR. Ia mengurangi permintaan tetapi tidak menghilangkan kendala pengurutan. Pelengkap, bukan alternatif.                                                                                                                            |

## Konsekuensi

- #282, #293, #283 dan #290 dapat mengambil migrasi tanpa keputusan penomoran lebih lanjut. Nomor mereka adalah D1.
- Migrasi yang membutuhkan tabel retur atau laporan (`994`–`999`) tidak dapat ditulis sampai D3 mendarat. Tindak lanjut yang membutuhkan satu, misalnya kolom laporan retur, menunggu atau dirancang sehingga perubahan skema tidak merujuk tabel-tabel itu.
- Pada basis data yang ada, migrasi celah diterapkan setelah `999`, dalam urutan celah naik. Efeknya sama dengan pada basis data segar persis karena D2 berlaku.
- `apps/cms/tests/commerce-migrations-range.test.ts` tidak berubah oleh ADR ini. Ia berubah hanya dalam sinkronisasi yang membawa D3.

## Keamanan, kepatuhan dan operasi

Tidak ada perubahan runtime. Aturan melindungi kemampuan ulang skema: pemulihan cadangan ke kluster kosong, diikuti oleh `db:migrate`, harus mencapai skema yang sama yang dimiliki kluster yang dimigrasikan secara bertahap. Kemampuan ulang itu adalah titik bukti untuk kontrol keberlanjutan bisnis dan manajemen perubahan (pemulihan ISO/IEC 22301, manajemen perubahan ISO/IEC 27001 Annex A 8.32).
