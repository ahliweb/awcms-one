🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0027-catalog-custom-attributes-are-typed-and-allowlisted.md)

<!-- i18n-source-hash: sha256:a7615ff185671ec6829047173ed91414a053d08b5799019487964af363c7e657 -->

# ADR-0027 — Atribut kustom katalog bertipe dan di-allowlist, dan impor massal adalah validasi-lalu-terapkan

- **Status:** Diterima
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) (angka eksak melintasi kawat sebagai string), [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (ini `commerce`, bukan modul baru), [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (migrasi `960`–`964`), epik [#281](https://github.com/ahliweb/awcms-one/issues/281), issue [#291](https://github.com/ahliweb/awcms-one/issues/291)

## Konteks

OSPOS memungkinkan pedagang mendefinisikan atribut item kustom, mencari dan memfilter berdasarkannya, serta mengimpor item dari spreadsheet. Kedua sisi punya riwayat buruk: pencarian atribut kustom ditambal lebih dari sekali karena injeksi SQL (nama atau nilai atribut yang dikendalikan pengguna mencapai identifier atau ekspresi SQL), dan impor spreadsheet adalah tempat klasik di mana "kata file-nya begitu" melewati validasi yang ditegakkan setiap jalur interaktif.

Katalog awcms-one saat ini hanya memuat kolom produk tetap ditambah JSON deskriptif `variant_attributes`. Toko yang menjual sesuatu di luar bentuk yang diasumsikan kolom-kolom itu (berat, bahan, tanggal rilis, penanda organik) tidak punya tempat untuk menyimpannya, dan tidak ada yang bisa difilter. Pekerjaan ini karenanya adalah masalah desain dengan tiga kendala keras dari epik: tipe nilai harus nyata (bukan string yang kebetulan tampak seperti angka), sebuah request tidak boleh pernah bisa membentuk teks SQL, dan penulisan massal harus melewati validasi, autentikasi, dan isolasi tenant yang sama persis dengan penulisan tunggal — dan dapat dipulihkan.

## Keputusan

### D1 — Nilai adalah kolom bertipe pada tabel ternormalisasi, bukan dokumen JSON dan bukan EAV teks saja

`awcms_commerce_attribute_definitions` (skema) dan `awcms_commerce_product_attribute_values` (satu baris per entitas dan definisi) menyimpan nilai tepat di salah satu dari `value_text`, `value_scaled` (integer/desimal), `value_boolean`, `value_date`, ditegakkan oleh `CHECK (num_nonnulls(...) = 1)`, ditambah `value_search` (teks ternormalisasi dari nilai teks/enum).

Kolom `jsonb attributes` pada `awcms_commerce_products` hanya satu kolom tanpa tabel baru, dan membuat setiap filter menjadi ekspresi `->>`/cast yang dibangun dari kunci pemberian pemanggil — persis bentuk identifier dinamis yang ditambal pada OSPOS. Kolom bertipe menjadikan filter sebagai perbandingan kolom tetap dengan parameter ter-bind, memberi pemindaian rentang b-tree numerik/tanggal, dan menaruh bentuk nyata di bawah `CHECK`.

Referensi aman-tenant di skema, bukan hanya di kode aplikasi: FK komposit `(tenant_id, definition_id)`, `(tenant_id, product_id)`, dan `(variant_id, product_id)`. RLS tidak berlaku untuk pemeriksaan FK, sehingga tanpa FK itu jalur kode yang regresi dapat mengarahkan nilai tenant A ke definisi tenant B. Suite integrasi memasukkan baris semacam itu lewat koneksi yang melewati RLS dan menegaskan bahwa constraint menolaknya. Baris nilai varian membawa `product_id` dan `variant_id` sekaligus, sehingga "produk yang atribut X-nya Y" adalah satu `EXISTS` ber-indeks baik nilainya ada pada produk maupun pada salah satu variannya (kecocokan tingkat varian membuat produknya cocok — semantik faset yang terdokumentasi dan disengaja).

### D2 — Angka yang disimpan tidak pernah bergantung pada locale, dan disimpan sebagai `bigint` berskala yang eksak

Tata bahasa yang diterima berbasis ASCII dan tertutup (`domain/attribute-value.ts`): integer `[+-]?[0-9]+`, desimal `[+-]?[0-9]+(\.[0-9]+)?`; `.` adalah satu-satunya pemisah, digit awal wajib, tanpa eksponen, pengelompokan, atau spasi. **`1.234,5` dan `1,5` ditolak, bukan ditafsirkan** — apakah `1,234` berarti 1234 atau 1,234 adalah ambiguitas yang merusak katalog, jadi tata bahasanya tidak punya pembacaan untuknya. Digit pecahan lebih banyak dari `scale` definisi adalah kesalahan, tidak pernah pembulatan. Desimal JSON harus datang sebagai string (JSON `0.1` sudah berupa float); integer boleh berupa angka JSON. Tanggal adalah tanggal kalender ISO `YYYY-MM-DD` yang ketat (tahun kabisat dihormati); boolean adalah boolean JSON atau `true`/`false`; teks dinormalisasi NFC, di-trim, satu baris, dan dibatasi panjangnya (code point, bukan unit UTF-16); nilai enum adalah anggota persis dari daftar opsi tertutup. Suite tes menjalankan ulang parsing numerik dengan locale proses yang berbeda.

**Penyimpanan adalah `value_scaled bigint` = nilai × 10^6** (12 digit bulat, ≤ 6 pecahan), bukan `numeric` dan bukan float. Ini diputuskan oleh EXPLAIN, bukan selera: di bawah `FORCE ROW LEVEL SECURITY` Postgres hanya mendorong operator *leakproof* ke dalam kondisi indeks, dan operator perbandingan `numeric` tidak leakproof (`pg_proc.proleakproof = f` untuk `numeric_ge`/`_le`/`_eq`) sedangkan milik `int8` leakproof. Dengan `numeric`, filter rentang tidak akan pernah bisa memakai b-tree untuk role `awcms_app` — rencana prototipe pertama menunjukkan `Filter: (value_numeric >= 99.5)` di atas pemindaian penuh baris definisi. Integer berskala itu eksak (aturan aritmetika integer yang sama dengan yang ditetapkan ADR-0003 untuk uang), perbandingan eksak di server maupun di kode domain (`BigInt`), dan desimal kanonik dipulihkan dengan manipulasi digit, tanpa pembagian dan tanpa float di mana pun. Bentuk di kawat: integer → angka JSON (selalu terwakili eksak), desimal → string.

### D3 — Definisi adalah metadata dengan skema tertutup, dan sebagian kolom tidak dapat diubah

Definisi punya `key` stabil (`^[a-z][a-z0-9_]{0,62}$`, unik di antara definisi aktif per tenant, dibebaskan oleh soft delete), `label` bawaan ditambah `labels` per-locale, `valueType`, dokumen `constraints`, penanda `is_searchable` / `is_filterable` / `visible_admin` / `visible_public`, `applies_to` (`product`, `variant`, `both`), dan `sort_order`. Constraint adalah **skema tertutup per tipe** (teks: `minLength`/`maxLength`; integer/desimal: `min`/`max` (+ `scale` ≤ 6); tanggal: `min`/`max`; enum: `options[]`; boolean: tidak ada) dan kunci lain adalah 400 — sengaja tidak ada `pattern`/regex (ekspresi buatan tenant adalah vektor ReDoS dan tata bahasa kedua yang tidak diaudit siapa pun) dan tidak ada bahasa ekspresi. `key` dan `valueType` tidak dapat diubah: nilai tersimpan adalah kolom bertipe, jadi tipe berbeda adalah atribut berbeda. Mempersempit constraint tidak menulis ulang nilai tersimpan (nilai divalidasi saat ditulis), dengan dua penolakan yang akan diam-diam menelantarkan data: opsi enum yang masih dipakai nilai tersimpan tidak dapat dihapus, dan `applies_to` tidak dapat dipersempit di bawah nilai tersimpan. Nilai opsi enum unik tanpa membedakan huruf besar/kecil (satu btree melayani kesetaraan teks dan enum, di bawah). Tenant dibatasi 100 definisi aktif, yang membatasi header impor, pengambilan definisi per request, dan daftar definisi (tidak pernah dipaginasi).

Label opsi adalah konten buatan tenant, bukan string katalog; chrome admin diterjemahkan lewat katalog biasa.

### D4 — Request tidak pernah bisa membentuk teks SQL: parse dua tahap, satu template literal per (tipe, operator)

Filter berbentuk `attr=<key>:<operator>:<value>`, dapat diulang (≤ 5, di-AND). Tahap 1 (`parseAttributeFilterParams`) hanya memeriksa bentuk: kunci cocok dengan tata bahasa slug, operator adalah anggota himpunan **tertutup** `eq`/`in`/`gte`/`lte`/`contains`, nilai tidak kosong dan dibatasi. Tahap 2 (`resolveAttributeFilters`) mengikat kunci ke definisi **yang dikembalikan database**, memeriksa operator sah untuk tipenya (`gte`/`lte` pada integer/desimal/tanggal; `contains` pada teks; tidak ada `in` pada boolean), dan mem-parse setiap operand dengan tata bahasa bertipe yang sama dengan nilai tersimpan — `attr=weight:gte:1,5` gagal persis seperti penulisan `1,5`. Yang tersisa adalah **id** definisi, pasangan operator/tipe dari union tertutup, dan operand bertipe.

`application/attribute-filter-sql.ts` memetakan setiap pasangan (tipe, operator) ke **satu template SQL literal** yang kolomnya (`value_scaled`, `value_date`, `value_boolean`, `value_search`) tertulis di dalam template, dan mem-bind operand sebagai parameter. `switch`-nya eksaustif terhadap kedua union, sehingga operator baru adalah galat kompilasi sampai ia punya template sendiri. Tidak ada `tx.unsafe`, `${column}`, atau `${operator}` di modul itu — dan sebuah tes menegaskan persis itu lewat sumber, ditambah tes perilaku yang melempar payload ke kunci (`color";DROP TABLE ...;--`), operator (`eq;DROP...`), dan nilai (`' OR '1'='1`, `1; DROP`, `\' OR 1=1 --`) dan menegaskan setiap payload kunci/operator ditolak sebelum mencapai SQL, setiap payload nilai ditolak oleh tata bahasa bertipe atau disimpan/dicocokkan sebagai string ter-bind yang lembam, tidak ada baris yang bocor, dan tabel produk tetap utuh. Kunci yang tidak dikenal, tidak dapat difilter, dan (untuk audiens publik) tidak publik menghasilkan **satu dan sama** 400, sehingga endpoint bukan oracle skema.

Pengurutan daftar produk yang sudah ada tetap peta `ORDER BY` ber-allowlist; pengurutan berdasarkan nilai atribut ditunda (lihat Ditunda).

### D5 — Audiens: API katalog berbicara ke publik; himpunan atribut lengkap butuh izin back-office

`GET /api/v1/commerce/products` (dan `/{id}`, `/by-slug/{slug}`) adalah read model yang dipakai etalase dengan kredensial mesin. Karena itu ia selalu berbicara ke audiens **publik**: filter hanya boleh menyebut kunci `filterable && visible_public`, `q` hanya mencari atribut `searchable && visible_public`, dan `attributes[]` aditif hanya membawa nilai `visible_public` (juga pada setiap varian). Kolom yang sudah ada tidak disentuh, sehingga konsumen yang mendahului atribut tetap berfungsi. Atribut `searchable` yang tidak publik tidak pernah bisa diselidiki lewat pencarian publik.

Himpunan atribut *lengkap* — termasuk atribut khusus back-office — adalah `GET /products/{id}/attributes`, dijaga `commerce.attributes.read`, **bukan** `commerce.products.read`: kredensial etalase memegang yang terakhir, dan tidak boleh bisa membaca balik nilai mutu pemasok. Menulis nilai memakai ulang `commerce.products.update` (nilai adalah bagian dari menyunting produk, aturan "satu kata kerja per sub-resource" yang sama dengan gambar dan varian). Layar admin memanggil direktori langsung dengan audiens admin **hanya bila operator juga memegang `attributes.read`**; pencarian teks bebas `q` operator yang hanya memegang `products.read` memakai audiens publik, sehingga nilai atribut non-publik yang dapat dicari tidak dapat diprobe (kecocokan akan membocorkannya) sebagaimana ia tidak dapat dibaca. Rute ini terautentikasi, sehingga berada di balik kontrol per-kredensial yang dimiliki setiap rute owner, bukan limiter per-IP anonim milik rute etalase.

### D6 — Indeks dipilih dari rencana terukur (migrasi `963`)

Metode: 3 tenant (20k, 20k, dan 200k produk) × 5 atribut (enum 8 nilai, desimal 0–99,99, tanggal selama 3 tahun, boolean 50/50, teks 200/2000 berbeda) = 1,2 juta baris nilai, di-`ANALYZE`, `EXPLAIN (ANALYZE, BUFFERS)` dari pernyataan persis yang dikeluarkan daftar produk (fragmen sebenarnya), **sebagai role `awcms_app` di bawah kebijakan sebenarnya** — superuser akan menunjukkan rencana berbeda. Waktu eksekusi, ms (PostgreSQL 18.4, satu kontainer lokal; nilai absolut bergantung mesin, rasio dan bentuk rencana adalah buktinya):

| Filter | 20k produk, sebelum → sesudah | 200k produk, sebelum → sesudah | Rencana sesudah |
| --- | --- | --- | --- |
| desimal ≥ 99,5 (0,5% baris) | 2,57 → 0,42 | 32,7 → 11,3 | index scan pada `..._scaled_idx` |
| tanggal = (0,1%) | 2,40 → 0,25 | 19,3 → 2,1 | index scan pada `..._date_idx` |
| teks eq (0,5% / 0,05%) | 3,47 → 0,57 | 27,9 → 1,2 | index scan pada `..._search_idx` |
| desimal ≥ 90, enum eq, tanggal ≥ (10–12%) | tidak berubah (derau) | tidak berubah (derau) | hash semi-join + seq scan: planner dengan benar mengabaikan indeks |
| boolean eq (50%) | tidak berubah | tidak berubah | tidak diindeks — dua nilai tidak punya selektivitas |
| teks `contains` (LIKE) | ~6–10 | ~60–95 | linear terhadap baris definisi, diindeks atau tidak |
| `q` atas atribut searchable | ~25 | ~170–220 | `q` lama nama/sku sudah seq scan pada 200k (~120) |

Jadi tiga indeks, masing-masing `(tenant_id, definition_id, <kolom bertipe>)`, **parsial** pada kolom tidak-null dan baris aktif, dibuat; satu btree melayani kesetaraan teks dan enum. Dua hal diukur dan **ditolak**: indeks GIN `pg_trgm` pada `value_search` tidak pernah dipilih planner — `LIKE`/`ILIKE` juga tidak leakproof, sehingga di bawah RLS tidak dapat menjadi kondisi indeks bahkan untuk kata kunci langka — dan indeks boolean. Pengindeksan serampangan akan membebani setiap penulisan tanpa manfaat bacaan. Beban `contains` dan `q` searchable diterima, dibatasi oleh baris definisi, dan hanya dibayar tenant yang mengikutsertakan atribut ke dalamnya. Tes integrasi (`query plans`) menegaskan ulang, pada database 20k produk sebagai `awcms_app`, bahwa filter selektif memakai indeks sql/963 dan tidak ada kueri nilai yang seq-scan tabel nilai.

### D7 — Ekspor: RFC 4180, UTF-8, formula dinetralkan, dapat di-round-trip

`GET /products/export.csv` (`commerce.products.export`) menulis kolom inti ditambah satu `attr:<key>` per definisi aktif, berlaku untuk produk, dan terlihat admin — tetapi hanya yang `visible_public` kecuali pemanggil juga memegang `commerce.attributes.read` (operator yang hanya punya `export` tidak boleh membaca nilai atribut back-office lewat file; aturan D5 berlaku juga untuk CSV); `costPrice` dan `downloadLink` tidak diekspor. Setiap sel dinetralkan **lalu** dikutip: sel yang diawali `=`, `+`, `-`, `@`, TAB, atau CR diawali dengan `'` (pertahanan OWASP). Satu pengecualian: sel yang seluruhnya adalah angka bertanda polos (`-5`, `+3.25`) ditulis apa adanya — ia tidak mungkin formula, dan mengawalinya akan mengubah setiap angka negatif menjadi teks; `-5+cmd|...` bukan angka polos dan dinetralkan. Importer membalik persis ini (`'` diikuti karakter pemicu kehilangan kutipnya), sehingga ekspor diimpor ulang sebagai semuanya `unchanged` — ditegaskan oleh tes; biayanya adalah teks asli yang diawali `'=` kehilangan kutipnya saat diimpor ulang. Batasnya sama dengan batas impor (5000 baris); `X-AWCMS-Export-Truncated` menandai katalog yang lebih besar; ekspor diaudit.

### D8 — Impor adalah validasi → laporan → terapkan, dengan satu perencana, semua-atau-tidak-sama-sekali, dan aman terhadap replay

**Satu jalur.** `planCatalogImport` membaca file dan memutuskan setiap baris (`create`/`update`/`unchanged`/`error`) hanya dengan SELECT. Dry-run mengembalikan laporannya; apply memanggil *fungsi yang sama* dan mengeksekusi rencana hanya jika tanpa error. Kolom baris melewati `validateCreateProductInput`/`validateUpdateProductInput` — validator yang dipakai API produk tunggal — dan sel `attr:` melewati `validateAttributeAssignments`, validator yang dipakai endpoint atribut. Aturan yang ditambahkan pada salah satunya sampai ke impor tanpa biaya; nilai yang ditolak API ditolak impor karena alasan yang sama. Penulisan memakai `createProduct`/`updateProduct`, sehingga baris audit, event domain, keunikan slug/SKU, dan mesin status berjalan per baris.

**Kunci pencocokan dan semantik.** Baris dicocokkan pada `sku` (kunci eksternal stabil): produk aktif dengan SKU itu diperbarui (hanya kolom yang berubah ditulis; tanpa perubahan adalah `unchanged`), SKU lain membuat produk. Sel inti yang dikosongkan berarti "tidak berubah" (atau nilai bawaan untuk create); sel `attr:` kosong *menghapus* atribut itu, yang membuat ekspor menjadi no-op saat diimpor ulang; kolom yang tidak ada di header tidak disentuh. Slug milik produk aktif lain, dua baris dengan SKU atau slug sama dalam satu file (tidak ada tukar slug dalam satu file — lakukan dua impor), `categorySlug` yang tidak dikenal, dan transisi status ilegal adalah error baris. Kolom yang tidak dikenal adalah error *file*, bukan diabaikan — salah ketik seperti `prise` yang diam-diam dibuang akan mengimpor sesuatu yang tidak ditinjau operator.

**Semua-atau-tidak-sama-sekali, secara eksplisit.** Apply berjalan di dalam `SAVEPOINT` pada transaksi request: setiap baris masuk atau tidak satu pun. Rencana dengan error apa pun ditolak (`422 IMPORT_VALIDATION_FAILED`, tidak ada yang ditulis); konflik saat-tulis yang tidak terlihat perencana (request lain mengambil slug antara rencana dan tulis) me-rollback savepoint (`409 IMPORT_CONFLICT`) dan membiarkan katalog tak tersentuh; error lain adalah cacat dan merambat (seluruh request di-rollback, `500`). Apply bertahap/parsial dipertimbangkan dan ditolak: ia meninggalkan katalog yang separuh dari file yang ditinjau operator dan butuh alat kedua untuk merekonsiliasi. Biaya jujurnya adalah batas ukuran (5000 baris, 5 MiB) dan satu transaksi panjang — terukur: 5000 produk baru dengan dua nilai atribut masing-masing diterapkan dalam sekitar 11–14 dtk di mesin uji (≈ 2–3 ms per baris, didominasi insert audit/event per baris), jauh di dalam anggaran interaktif dan alasan batas ada di titik itu. Rute memakai kelas kerja `background_sync` agar penulisan massal tidak menggusur lalu lintas interaktif.

**Idempotensi dan identitas batch.** Apply membutuhkan `Idempotency-Key`; penyimpanan bersama mencatat hash request `sha256(byte file)`, sehingga memutar ulang kunci yang sama dengan file yang sama mengembalikan respons asli tanpa menerapkan ulang dan kunci yang sama dengan file berbeda adalah `409 IDEMPOTENCY_CONFLICT`. Media type request persis `text/csv`: `text/plain` termasuk CORS-safelisted (tanpa preflight), sehingga menerimanya akan membiarkan form lintas-situs mengirim dry-run tanpa diminta; selain itu `415`. Kunci diklaim **lebih dulu**, di dalam savepoint apply, dengan `INSERT … ON CONFLICT (tenant_id, key hash) DO NOTHING`: apply bersamaan dengan kunci yang sama menunggu pada indeks unik sampai pemenang commit, lalu tidak mendapat baris dan tidak menulis apa pun (`duplicate_key`), dan rute menjawab dengan replay tersimpan milik pemenang (file sama) atau `409 IDEMPOTENCY_CONFLICT` — tidak pernah pelanggaran unik mentah / 500. Apply yang gagal membatalkan klaim bersama tulisannya, sehingga file yang sudah dikoreksi dapat memakai ulang kunci. `awcms_commerce_catalog_import_batches` mencatat setiap batch yang diterapkan (hash file, *hash* kunci, jumlah, aktor); `(tenant_id, key hash)` uniknya adalah penjaga struktural kedua — bahkan catatan replay yang hilang tidak dapat menerapkan satu kunci dua kali. Dry-run tidak menulis apa pun, jadi tidak punya baris batch. `expectedSha256` mengikat apply ke file yang ditinjau operator (`409 IMPORT_FILE_MISMATCH`); layar admin mengirimkannya otomatis.

**Strategi rollback.** *Sebelum* commit: savepoint (di atas) — tidak ada yang perlu dibatalkan. *Sesudah* commit: tidak ada langkah destruktif yang harus dibalik — pembaruan adalah update produk biasa yang diaudit, penghapusan atribut adalah soft delete, dan baris batch ditambah jejak audit (`catalog_import.apply`, event `update` per produk yang membawa kolom berubah) mengidentifikasi persis apa yang disentuh sebuah batch. Membalik impor yang sudah di-commit adalah mengimpor ekspor sebelumnya (inilah sebabnya ekspor round-trip); tidak ada tombol "batalkan batch" dan tidak ada yang diklaim.

**Model ancaman.**

| Ancaman | Kontrol |
| --- | --- |
| Injeksi formula lewat file ekspor | Netralisasi sel pada setiap sel ekspor, dengan tes per karakter pemicu |
| Injeksi SQL lewat header/kunci/nilai/operator | Kunci di-resolve ke id definisi; nilai di-parse tata bahasa bertipe dan di-bind; tidak ada `unsafe` di jalur filter/impor (ditegaskan) |
| Impor melewati validasi | Validator yang sama dengan API interaktif; fungsi direktori yang sama |
| Impor melewati otorisasi | `products.import` **dan** `create` **dan** `update` untuk apply; dry-run butuh `import`; tenant dari sesi terverifikasi, RLS pada setiap pernyataan |
| Baca/tulis lintas tenant | Pencarian SKU/slug/kategori dibatasi RLS dan berkunci tenant; tes mengimpor SKU yang hanya ada di tenant lain (ia membuat, tidak pernah memperbarui, baris B tak tersentuh); FK komposit |
| Server-side request forgery / pengambilan jarak jauh | Tidak ada kode jaringan di importer; **tidak ada kolom yang menerima referensi media atau URL** (`imageUrl`, `media`, … adalah error kolom-tak-dikenal) — gambar tetap langkah terpisah yang eksplisit |
| Kehabisan sumber daya (file besar, baris lebar, sel raksasa, bom kutip) | Batas body 5 MiB (`readTextBody`, streaming), 5000 baris, 200 kolom, 10.000 karakter per sel, NUL ditolak, kutipan cacat adalah error parse, tidak diperbaiki; daftar diagnostik dibatasi |
| Replay / apply ganda | Kunci idempotensi + hash file + kunci batch unik |
| Menerapkan file berbeda dari yang ditinjau | `expectedSha256` |
| Membaca atribut back-office lewat API katalog | Filter audiens publik + gerbang `attributes.read` untuk himpunan lengkap (D5) |
| Kebocoran informasi pada diagnostik | Diagnostik baris adalah pesan validator sendiri tentang file operator sendiri; error tak terduga tidak pernah digaungkan (merambat) |

### D9 — Izin, dengan satu aksi akses baru

`commerce.attributes.read` dan `commerce.attributes.manage` (definisi adalah skema, satu audiens berisiko tinggi, jadi satu aksi, bukan create/update/delete); `commerce.products.export` dan `commerce.products.import`. `import` adalah `AccessAction` baru (berisiko tinggi di samping `export`; kait SoD dapat merujuknya tanpa perubahan kedua). Tenant yang sudah ada tidak otomatis mendapat izin ini (seed katalog bersifat global, `sql/961`).

### D10 — Siklus hidup: nilai di-soft-delete; mesin purge menua-kan nilai yang dihapus

Menghapus nilai memberi cap `deleted_at` (ia juga keluar dari indeks unik aktif, sehingga menetapkan atribut lagi menyisipkan baris baru); mesin purge generik meng-hard-delete nilai yang dihapus setelah jendela retensi tenant, dan nilai aktif (`deleted_at IS NULL`) tidak pernah bisa menjadi kandidat purge. Nilai juga ikut hilang berantai bersama produk, varian, atau definisi yang di-purge. Kedua tabel membawa deskriptor `dataLifecycle`; `subjectData` menandainya tak-terjangkau-subjek dan dipertahankan (deskripsi katalog, bukan orang). Setiap pembacaan, filter, pemeriksaan keunikan, dan indeks parsial mengulang `deleted_at IS NULL`.

## Konsekuensi

- Katalog kini dapat mendeskripsikan dirinya dalam istilah bertipe, tervalidasi, dan dapat difilter; biayanya lima migrasi, tiga tabel, dan permukaan izin nyata yang harus diberikan.
- Penskalaan `bigint` membatasi angka pada 12 digit bulat dan 6 digit pecahan — cukup untuk dimensi, berat, jumlah, dan harga-sebagai-atribut, tidak untuk nilai ilmiah. Rentang lebih lebar memerlukan `numeric` dan melepaskan filter rentang berbantuan indeks di bawah RLS; trade-off itu disengaja.
- Memfilter berdasarkan atribut *varian* membuat produk cocok; ketersediaan per-varian ("varian ukuran L yang tersedia") bukan yang diekspresikan ini.
- Jalur `q` searchable dan `contains` linear terhadap baris sebuah definisi. Keduanya dibatasi (≤ 100 definisi, katalog tenant ribuan) dan opt-in, tetapi tenant dengan ratusan ribu produk sebaiknya tidak menandai banyak atribut sebagai searchable.
- Impor adalah satu transaksi. 5000 baris adalah titik optimal yang terukur; katalog lebih besar dimuat dalam beberapa impor (idempoten berdasarkan SKU), bukan satu request raksasa.
- Diagnostik baris adalah pesan Inggris validator API, ditampilkan di samping chrome layar yang diterjemahkan — bahasa kontrak file itu sendiri, bukan string katalog.

## Ditunda (tidak dibangun — dicatat agar tidak ada yang mengira sebaliknya)

- **Atribut varian di CSV.** File berbentuk produk; varian dan nilai atributnya disunting lewat layar admin dan `PUT .../variants/{id}/attributes`. CSV varian membutuhkan desain kunci pencocokan sendiri (`variant sku`) dan merupakan perubahan terpisah.
- **Pengurutan berdasarkan nilai atribut.** Butuh cerita keyset atas kolom bertipe, nullable, per-definisi; pengurutan ber-allowlist yang ada tidak berubah.
- **Rendering/faset etalase (`apps/storefront`).** API siap (`attributes[]`, filter `attr=`); membangun UI faset dan halaman adalah pekerjaan etalase dan sengaja bukan bagian perubahan ini.
- **Mengganti nama opsi enum** (penulisan ulang nilai) dan label opsi per-locale.
- **Impor bertahap atau latar belakang** untuk katalog di atas 5000 baris per file.
- **Riwayat nilai atribut** di luar daftar kunci-berubah pada jejak audit.
- **Referensi media per baris** — sengaja tidak pernah; gambar tetap langkah terpisah.

## Alternatif yang dipertimbangkan

- **Atribut `jsonb` pada `products`** — ditolak (D1): ekspresi `->>` yang dibangun dari request, tanpa pemindaian rentang bertipe, tanpa bentuk yang dapat di-CHECK.
- **Penyimpanan nilai `numeric`** — ditolak (D2/D6): tidak leakproof, jadi tidak ada pemindaian rentang berindeks di bawah RLS; terukur.
- **DSL kueri dengan ekspresi atribut bernama** — ditolak: issue hanya meminta jika "domain membuktikan nilai", dan `key:operator:value` atas himpunan operator tertutup mencakup pemfilteran berfaset dengan sebagian kecil permukaan serangan.
- **Impor bertahap dengan commit per-bagian** — ditolak (D8).
- **Impor `INSERT … ON CONFLICT` per baris yang melewati fungsi direktori** — ditolak: lebih cepat, tetapi memecah validasi, event, dan audit dari jalur interaktif, persis bypass yang dilarang ADR ini.
- **Indeks trigram untuk `contains`/pencarian** — ditolak (D6): terukur tidak pernah dipakai di bawah RLS.
