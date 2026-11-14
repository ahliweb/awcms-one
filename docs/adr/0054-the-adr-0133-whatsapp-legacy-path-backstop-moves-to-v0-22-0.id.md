🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0054-the-adr-0133-whatsapp-legacy-path-backstop-moves-to-v0-22-0.md)

<!-- i18n-source-hash: sha256:e4905ee0d7cfebaff0d25ed186b290a7439bad7a80736fda4b0e47fe1ac8f9dc -->

# ADR-0054 — Batas akhir jalur legacy WhatsApp commerce pindah ke v0.22.0

- **Status:** Diterima
- **Tanggal:** 11 November 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** issue [#394](https://github.com/ahliweb/awcms-one/issues/394) (penghapusannya, fase 4, masih terbuka dan belum dimulai); [ADR-0047](0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md) (router mode per tenant D1-D9, cutover terjaga D10-D15, amendemen tinjauan D16-D17, dan baris Konsekuensi yang memulai jam batas akhir); ADR-0133 upstream bagian 6 (fase, lima kondisi akhir, dan batas akhir) di `apps/cms/docs/adr/`; [ADR-0024](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md) (repositori ini adalah template; produk turunan memiliki tenant dan runtime-nya sendiri); [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) D5 (outbox milik commerce yang menjadi jalur legacy); epik [#280](https://github.com/ahliweb/awcms-one/issues/280) butir 31

## Konteks

ADR-0133 `awcms` upstream bagian 6 mengakhiri adapter kompatibilitas WhatsApp commerce dengan batas akhir bertanggal: adapter dan jalur legacy dihapus "selambat-lambatnya pada **rilis minor kedua template downstream setelah rilis yang pertama kali memuat mode `upstream` (langkah 2)**; jika kondisi di atas belum terpenuhi saat itu, keputusan untuk memperpanjangnya membutuhkan ADR baru dengan tanggal baru". Adapter kompatibilitas tanpa akhir bertanggal adalah mode kegagalan yang sengaja ditolak bagian itu. Konsekuensi [ADR-0047](0047-commerce-whatsapp-moves-to-the-upstream-queue-through-a-per-tenant-mode-router.md) menerima jam itu dan menyatakan bahwa ia dimulai dengan rilis yang membawa router.

Fakta-faktanya, dari [`CHANGELOG.md`](../../CHANGELOG.md):

- Mode `upstream` (router mode per tenant #392, `sql/1027`) dan cutover terjaga (#393, `sql/1028`) pertama kali dirilis di **v0.17.0, 20 Oktober 2026**.
- Dua rilis minor setelahnya adalah v0.18.0 (25 Oktober 2026) dan **v0.19.0 (11 November 2026)**. Batas akhir karena itu jatuh tempo pada v0.19.0, dan v0.19.0 sudah dirilis.
- Rilis saat ini adalah v0.20.0 (11 November 2026). Jalur legacy tidak dihapus di rilis mana pun, dan tidak satu pun dari lima kondisi akhir sudah dibuktikan.

Kondisi-kondisi itu tidak dapat dibuktikan **di repositori ini**, dan itu sifat dari apa repositori ini, bukan kelalaian pekerjaan. Menurut ADR-0024, `awcms-one` adalah template dan deployment acuan: produk turunan yang dibuat darinya memiliki tenant, basis data, domain, rahasia, job terjadwal, dan siklus operasinya sendiri. Kondisi 2 dan 3 ("setiap tenant di setiap deployment berada dalam mode `upstream`, dengan nol baris non-terminal di antrean legacy, dan jendela retensi sudah lewat atau sudah dibersihkan") adalah pernyataan tentang tenant yang tidak dipegang repositori ini. Tidak ada tenant di sini yang sudah di-flip, dan deployment acuan tidak boleh dipakai untuk membuat bukti itu (ADR-0024: tidak ada tenancy runtime konsumen di sini). Menghapus jalur legacy (layar, job, flag, tabel) selagi tenant sebuah produk turunan masih berjalan dalam mode `legacy` akan merusak produk itu pada peningkatan versi berikutnya; kondisi 2 ADR-0133 sendiri ada untuk mencegah hal persis itu.

Jadi batas akhir terlewat, dan ADR-0133 `awcms` menyatakan apa yang dibutuhkan: ADR baru dengan tanggal baru, bukan pergeseran diam-diam. Inilah ADR itu.

## Keputusan

**D1 — Batas akhir pindah: jalur legacy dihapus selambat-lambatnya pada rilis minor kedua setelah v0.20.0, yaitu v0.22.0.** Aturan hitungnya adalah milik ADR-0133 `awcms` sendiri, diterapkan pada jangkar baru: v0.21.0 adalah rilis minor pertama setelah v0.20.0 dan v0.22.0 yang kedua. Rilis yang bukan minor (patch `0.x.y`) tidak dihitung; sebuah mayor akan memulai ulang pertanyaan itu dalam ADR baru. Tanggal baru menggantikan yang ada di Konsekuensi ADR-0047 (catatan Amendemen di sana menunjuk ke sini); ADR-0133 upstream tidak berubah dan redaksinya ("ADR baru dengan tanggal baru") adalah yang diterapkan ADR ini.

**D2 — Lima kondisi akhir tidak berubah.** Itu milik upstream, dikutip di sini hanya agar PR penghapusan punya satu daftar periksa:

1. Setiap pemanggil commerce (OTP pelanggan, pesanan dibayar, kampanye, pengiriman dokumen) mengantre lewat router dan port upstream; `apps/cms/tests/commerce-whatsapp-upstream-boundary.test.ts` (ADR-0047 D9) hijau dengan daftar izinnya kosong.
2. Setiap tenant di setiap deployment berada dalam mode `upstream` dan `awcms_commerce_whatsapp_messages` memuat **nol baris non-terminal** (`queued`, `sending`; status yang tidak dikenal dihitung non-terminal, ADR-0047 D11).
3. Jendela retensi lama sudah lewat untuk baris terminal, atau `commerce:whatsapp:purge` sudah membersihkannya; buku besar upaya pengiriman juga demikian.
4. `commerce:whatsapp:dispatch`, `commerce:whatsapp:purge`, layar admin dan jalur API WhatsApp milik commerce, serta flag mode `legacy` dihapus, dengan jalur API terlebih dahulu dialihkan atau di-alias ke jalur upstream selama **satu rilis minor** dan diumumkan di changelog.
5. Sebuah migrasi akhir menghapus dua tabel legacy (`awcms_commerce_whatsapp_messages` dan `awcms_commerce_whatsapp_delivery_attempts`), dicatat sebagai **keputusan kelas restore** di ADR PR penghapusan, bukan sebagai migrasi `down`.

Tidak ada yang dilonggarkan, diurutkan ulang, atau dikesampingkan oleh ADR ini. Hanya tanggalnya yang pindah.

**D3 — ADR ini tidak menghapus atau mengubah kode, skema, atau tabel apa pun.** Router, penulis legacy, dispatcher dan purge legacy, layar admin, `sql/1027` dan `sql/1028`, serta kedua tabel legacy tetap persis seperti sekarang. Default `legacy` tetap, sehingga tenant yang tidak melakukan apa-apa tetap berjalan. Ini hanya catatan keputusan.

**D4 — Bukti yang wajib dibawa PR penghapusan (issue #394).** Daftar kondisi adalah daftar penerimaan; setiap butir mendapat satu baris di PR:

- Kondisi 1: keluaran uji batas dengan daftar izin kosong, ditambah `git grep` yang menunjukkan tidak ada berkas commerce yang menyebut tabel, provider, dispatcher, atau penulis legacy di luar berkas yang dihapus.
- Kondisi 2 dan 3: karena repositori ini tidak dapat menunjukkannya untuk tenant milik orang lain, buktinya adalah **pernyataan tertulis per produk turunan yang dikenal** (pemilik repositori produk, tanggal, dan catatan bukti dari `commerce:whatsapp:cutover --status` untuk setiap tenant: `mode: upstream`, `queues.legacy.nonTerminal: 0`, sisa jumlah baris tabel legacy dan eksekusi purge), ditambah `--status` deployment acuan sendiri. Produk turunan yang belum menyatakannya saat PR digabung tidak tercakup dalam penghapusan ini dan menanggung konsekuensi di D5. Jika tidak ada produk turunan yang dapat menyatakannya, PR menyebutkannya.
- Kondisi 4: rilis penghapusan menghapus job, layar, dan flag, serta menjadikan jalur API lama alias dari jalur upstream; masa alias (satu rilis minor) diumumkan di changelog rilis itu, dan alias dihapus pada rilis minor berikutnya, tidak pernah pada rilis yang sama.
- Kondisi 5: migrasinya, catatan kelas restore (kedua tabel tidak dapat dipulihkan dengan migrasi turun; cadangan yang diambil sebelum deploy adalah jalur pemulihan), dan hasil `bun run db:migrate` pada basis data yang memuat baris legacy.

Batas akhir di D1 berlaku untuk rilis penghapusan itu: ia dirilis **selambat-lambatnya pada v0.22.0**, sebagaimana kata-kata ADR-0133 `awcms` ("adapter dan jalur legacy dihapus") menempatkannya. Alias yang diperkenalkannya, dan migrasi kondisi 5 yang menghapus dua tabel legacy, menyusul selambat-lambatnya pada rilis minor berikutnya (v0.23.0). Jika rilis penghapusan bergeser melewati v0.22.0, D6 berlaku.

**D5 — Yang harus dilakukan produk turunan sebelum itu.** Produk turunan memiliki tenant-nya (ADR-0024), jadi pekerjaannya milik mereka dan dilakukan di repositori mereka sendiri, dengan issue mereka sendiri:

1. Konfigurasikan kanal upstream (`WHATSAPP_ENABLED`, `WHATSAPP_PROVIDER` beserta kredensialnya, `WHATSAPP_RECIPIENT_HASH_KEYS`) di lingkungan CMS dan sidecar job, lalu baca celah yang diketahui di ADR-0047 (consent pemasaran tidak dijembatani, variabel satu baris dan dibatasi 1.000 karakter, Meta membutuhkan identitas template provider, batas lajunya berbeda).
2. Flip setiap tenant dengan perintah yang sudah ada, satu tenant per satu: `bun run commerce:whatsapp:cutover --tenant <tenant-uuid> --to upstream --reason "<mengapa>" --ack-warnings` (uji coba dulu dengan `--dry-run`; `--wait <detik>` menunggu antrean legacy kosong). API-nya setara: `POST /api/v1/commerce/whatsapp/mode`. Runbook ada di [`docs/deployment.md`](../deployment.md).
3. Kosongkan antrean legacy: flip ditolak selama antrean legacy memuat baris non-terminal, sehingga tenant yang sudah di-flip tidak punya baris itu, dan `commerce:whatsapp:purge` kemudian menghapus baris terminal dan upaya pengiriman setelah retensinya lewat.
4. Kirim satu OTP nyata ke nomor yang dikuasai operator setelah setiap flip (flip tidak memverifikasi kredensial provider), dan simpan catatan buktinya.

Produk turunan yang masih di `legacy` saat mengadopsi rilis yang menghapus jalur itu, menurut D2 kondisi 2, belum memenuhi prasyarat untuk peningkatan itu; ia harus flip sebelum mengadopsinya, atau tetap pada rilis terakhir yang masih membawa jalur itu dan menanggung divergensinya sendiri. Changelog rilis yang memperkenalkan alias menyatakannya dengan kata-kata yang jelas.

**D6 — Jika batas akhir baru juga terlewat, jawabannya adalah ADR lain, bukan pergeseran diam-diam.** Jika lima kondisi belum dibuktikan saat v0.22.0 dipotong, sebuah ADR dengan tanggal baru dan jangkar baru ditulis **dalam siklus rilis yang sama, sebelum tag v0.22.0**, dengan dua bagian yang sama seperti ADR ini: apa yang sudah dibuktikan dan apa yang belum, dan siapa pemilik bukti yang kurang. Penundaan ketiga juga mencatat, di ADR itu, apakah template sebaiknya tetap membawa jalur legacy sama sekali, atau membekukannya di balik cakrawala dukungan yang terdokumentasi dan berhenti mengirimkan `legacy` sebagai default untuk produk turunan baru. Entri changelog yang menyatakan penghapusan "akan terjadi nanti" tanpa ADR bukanlah keputusan.

**D7 — Pemeriksaan agar tanggalnya tetap jujur.** Batas akhir adalah sebuah kalimat; kalimat kedaluwarsa tanpa suara. Saat v0.21.0 dirilis, catatan rilisnya menyebut ADR ini dan menyatakan bahwa tinggal satu rilis minor sebelum batas akhir; PR penghapusan, saat dibuka, menautkan kembali ke sini. Daftar "belum ada di sini" di `docs/status.md` menyatakan tanggalnya dan mengutip ADR ini, yang merupakan satu tempat yang dilihat pembaca. ADR ini tidak menambah gerbang: uji struktural yang gagal karena nomor versi akan mengodekan tanggal itu untuk kedua kalinya dan akan salah pada hari rilis minor dilewati. Tinjau ulang jika tanggal bergeser untuk kedua kalinya.

## Konsekuensi

- Tidak ada yang teramati berubah hari ini: setiap tenant di `legacy` tetap berjalan, setiap tenant yang sudah di-flip tetap berjalan, dan router, cutover, serta dispatcher legacy tidak tersentuh.
- Batas akhir ADR-0133 `awcms` dipenuhi secara prosedural oleh ADR baru dengan tanggal baru, sebagaimana disyaratkan ADR-0133, bukan oleh penghapusan. Tanggal sebelumnya (v0.19.0) dicatat sebagai terlewat, secara terbuka, dengan alasannya: buktinya milik tenant yang tidak dipegang template ini.
- Produk turunan mendapat cakrawala yang dinyatakan (v0.22.0) dan prosedur yang tepat (D5) alih-alih "suatu hari nanti" yang tidak berujung; mereka dapat merencanakan flip setiap tenant terhadapnya.
- Pekerjaan penghapusan (issue #394) tetap terbuka dan belum dimulai. Daftar prasyaratnya kini adalah daftar periksa D2/D4, dan rilis penghapusannya punya tenggat (v0.22.0), dengan alias dan migrasi penghapus tabel hilang selambat-lambatnya pada v0.23.0.
- Risiko yang diterima ADR ini adalah yang disebut ADR-0133: adapter kompatibilitas dibawa lebih lama dari rencana. Biayanya dua rilis minor lagi dengan outbox WhatsApp kedua di pohon kode; manfaatnya tidak ada tenant produk turunan yang rusak oleh penghapusan yang tak dapat ia antisipasi.
- ADR-0047 mendapat catatan "Diubah oleh ADR-0054" di samping teks batas akhirnya; ADR-0133 upstream tidak disunting (itu milik upstream, dan ia sudah mengatur ADR ini).
