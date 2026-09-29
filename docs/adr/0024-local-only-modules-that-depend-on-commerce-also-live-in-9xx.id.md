🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0024-local-only-modules-that-depend-on-commerce-also-live-in-9xx.md)

<!-- i18n-source-hash: sha256:6515df1ad937437db0815f5520b3042226a2bc1f1215272dd76bfda6c40ca5d7 -->

# ADR-0024 — Modul lokal-saja yang bergantung pada `commerce` juga hidup di `9xx`

- **Status:** Diterima
- **Tanggal:** 29 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md); issue #270

## Konteks

ADR-0015 mencadangkan `sql/900`-`999` agar penambahan repo ini sendiri ke `apps/cms` yang disematkan lewat `git subtree` (ADR-0001 milik ADR-0015 sendiri) tidak pernah bertabrakan dengan penomoran `001`-`899` milik `ahliweb/awcms` upstream yang terus bertumbuh sendiri. ADR itu merumuskan aturannya khusus seputar `commerce`, karena saat itu `commerce` adalah satu-satunya kumpulan migration yang pernah ditambahkan repo ini yang tidak dibawa upstream — `apps/cms/tests/commerce-migrations-range.test.ts` karenanya mengunci "apakah migration ini dikecualikan dari aturan `< 900`" pada apakah `area` nama berkas migration-nya diawali `commerce`.

Issue #270 (IRMbyDUS) menambahkan `practice_irm` — modul kedua yang HANYA ada di `awcms-one`, tidak pernah di `awcms` upstream, dengan alasan yang sama seperti `commerce` (modul domain-bisnis yang dibangun untuk deployment ini, bukan bagian dari template generik). Tabel `awcms_practice_irm_sessions` miliknya punya foreign key sungguhan dan struktural ke `awcms_commerce_customers`/`awcms_commerce_products` — `owner_customer_id` mencatat siapa pemilik sesi practice, `product_id` mencatat entitlement pembelian mana yang membukanya — sehingga migration-nya sendiri tidak bisa diberi nomor di bawah nomor `commerce`: `apps/cms/scripts/db-migrate.ts` menerapkan setiap berkas `sql/*.sql` dalam urutan leksikal nama berkas, dan migration bernomor di bawah `900` berjalan sebelum SEMUA migration commerce `9xx` ada, termasuk yang membuat dua tabel yang direferensikan migration `practice_irm` sendiri. Diukur langsung: memberi nomor migration skema `practice_irm` di rentang `1xx` (dicoba lebih dulu) gagal pada `db:migrate` dari basis data segar dengan `relation "awcms_commerce_customers" does not exist` — bukan pelanggaran gaya, melainkan bug urutan sungguhan.

Aturan `commerce-migrations-range.test.ts` yang sudah ada — setiap migration yang area-nya TIDAK diawali `commerce` tetap di bawah `900` — tidak bisa dipenuhi oleh modul yang sekaligus (a) lokal-saja, persis seperti `commerce`, dan (b) punya dependensi FK keras ke tabel `commerce` sendiri, yang menurut konstruksinya hanya ada di `9xx`.

## Keputusan

Keempat migration `practice_irm` (`awcms_practice_irm_domains_schema`, `awcms_practice_irm_sessions_schema`, `awcms_practice_irm_permissions`, `awcms_practice_irm_worker_grants`) juga hidup di rentang `9xx` yang dicadangkan, tepat setelah migration `commerce` sendiri (`940`-`943` hari ini, melanjutkan nomor `commerce` sendiri hingga `939`). Boolean tunggal `isCommerce` milik `commerce-migrations-range.test.ts` menjadi daftar-izin kecil, eksplisit, dan beralasan berisi prefiks area LOKAL-SAJA (`commerce`, `practice_irm`) yang boleh memakai `9xx` — setiap area yang tidak ada di daftar tetap wajib di bawah `900`, sehingga aturan itu tetap menangkap kesalahan tabrakan-dengan-upstream sungguhan persis seperti sebelumnya.

Ini amendemen sempit, bukan pembukaan ulang: ia tidak menyentuh cara nomor `commerce` sendiri diberikan, dan tidak membuka `9xx` untuk setiap modul masa depan — hanya untuk satu yang disebut ADR ini, karena dua alasan di atas (LOKAL-SAJA DAN bergantung-FK secara struktural pada tabel `9xx` yang sudah ada). Modul masa depan yang lokal-saja tetapi TIDAK punya dependensi ke tabel `commerce` tidak punya alasan urutan untuk keluar dari rentang `< 900`, dan tidak boleh ditambahkan ke daftar-izin ini tanpa justifikasinya sendiri.

### Opsi yang dipertimbangkan

| Opsi | Kenapa tidak (atau kenapa dipilih) |
| --- | --- |
| **Perluas daftar-izin `9xx` ke `practice_irm`** (dipilih) | Menyelesaikan bug urutan sungguhan dengan perubahan terkecil dan paling mudah dibaca — satu entri beralasan lagi di daftar yang sudah mapan, mengikuti persis preseden yang ADR-0015 sendiri tetapkan. |
| Beri `practice_irm` nomor di bawah 900, lepas FK-nya, validasi referensi hanya di lapisan aplikasi | Kehilangan integritas referensial sungguhan (baris sesi yatim yang menunjuk pelanggan/produk yang sudah dihapus jadi mungkin) untuk masalah yang murni soal URUTAN migration, bukan soal apakah batasannya diinginkan. Header `sql/169` sendiri sudah beralasan untuk FK ini; melepasnya demi menghindari aturan penomoran adalah menyelesaikan masalah yang salah. |
| Ganti nama tabel/migration `practice_irm` menjadi bentuk `commerce_practice_irm_*` agar aturan prefiks-`commerce` yang ada menerimanya tanpa diubah | Salah-atribusi kepemilikan di setiap gerbang lain yang membaca prefiks nama tabel sebagai sinyal kepemilikan (repo ini tidak kekurangan gerbang semacam itu) — `practice_irm` adalah modulnya sendiri, dengan `module.ts`, izin, dan layar admin sendiri; kemudahan penomoran migration semestinya tidak bocor ke identitas tabel. |
| Perluas `commerce-migrations-range.test.ts` untuk menerima AREA APA PUN di `9xx`, menghapus daftar-izin sepenuhnya | Membuka kembali persis bahaya tabrakan-dengan-upstream yang ADR-0015 ada untuk menutupnya — migration bukan-lokal-saja masa depan (yang MEMANG ada di upstream) bisa mendarat di `9xx` secara tidak sengaja dan tidak ada yang menangkapnya. Daftar-izin sengaja dibuat kecil — setiap entri harus beralasan sendiri. |

## Konsekuensi

- `sql/940`-`943` milik `practice_irm`, tepat setelah `900`-`939` milik `commerce` yang sudah ada. Migration `commerce` masa depan tetap melanjutkan di nomor bebas berikutnya dalam kumpulan `9xx` bersama (hari ini, `944`) — kedua modul berbagi SATU rentang cadangan, bukan dua sub-rentang terpisah, karena tidak ada apa pun dalam penalaran penghindaran-tabrakan ADR-0015 yang bersifat per-modul.
- Modul lokal-saja masa depan yang juga butuh FK keras ke `commerce` (atau ke `practice_irm`, atau ke tabel bernomor `9xx` mana pun) mengikuti jalur yang sama: tambahkan entri beralasannya sendiri ke daftar-izin di `commerce-migrations-range.test.ts`, dalam perubahan yang (seperti ini) menjelaskan kenapa meninggalkan `9xx` sungguh tidak bisa bertahan — bukan membiarkannya terbuka sebagai jalan keluar umum.
- Docblock dan judul `apps/cms/tests/commerce-migrations-range.test.ts` tetap akurat secara semangat (`the reserved 9xx range` kini lebih luas dari sekadar `commerce`) tetapi berkasnya sendiri tidak diganti nama — perubahan terkecil yang menyelesaikan bug sungguhan, sejalan dengan kerangka "amendemen sempit" ADR ini sendiri.
