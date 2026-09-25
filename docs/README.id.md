🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:8635526b75d9ef6eec9c667653ea318e8d3461a6f89d9ce3c7782d633d58ec9d -->

# Dokumentasi

Dokumentasi arsitektur, skema, API, alur kerja CMS, perilaku storefront, pengujian, deployment, dan proses untuk `awcms-one` — mendeskripsikan repositori **sebagaimana ia benar-benar ada di tree hari ini**, tidak pernah sebagaimana direncanakan semula. Di mana tree dan teks asli suatu issue berbeda, dokumen-dokumen ini mengikuti tree, dan menyatakannya. [`status.md`](status.id.md) adalah ringkasan keadaan-terkini tunggal yang didukung detail dokumen-dokumen ini sendiri; riwayat — issue atau epic mana yang membangun bagian mana — hidup di [`CHANGELOG.md`](../CHANGELOG.md) dan [indeks ADR](adr/README.id.md).

| Dokumen | Isi |
| --- | --- |
| [`status.md`](status.id.md) | Referensi keadaan-terkini: apa yang sudah ada per permukaan, apa yang belum, masing-masing item menaut ke detailnya sendiri |
| [`arsitektur.md`](arsitektur.id.md) | Topologi dua-deployable, arah impor satu-jalur, embed subtree, jalur runtime anonim (ADR-0007), tingkat kepercayaan ketiga pelanggan-terautentikasi (ADR-0016), port penyedia/outbox/intake webhook (ADR-0017), CSP turunan |
| [`adr/`](adr/README.id.md) | Dua puluh Architecture Decision Record — trade-off di balik setiap keputusan struktural di atas |
| [`skema-basis-data.md`](skema-basis-data.id.md) | Setiap tabel `awcms_commerce_*`: kolom, tipe, constraint, indeks, RLS |
| [`kamus-data.md`](kamus-data.id.md) | Kamus data: setiap kolom, maknanya, dan kolom sumber legacy `commerce_bj_mart`-nya |
| [`api.md`](api.id.md) | API owner dan storefront anonim, envelope, paginasi, izin, domain event |
| [`cms.md`](cms.id.md) | Authoring, mesin status produk/pesanan/flash-sale, izin, log audit, media, taksonomi |
| [`routing.md`](routing.id.md) | Peta URL publik lengkap — katalog, berita, halaman runtime commerce, pengalihan legacy |
| [`seo.md`](seo.id.md) | Metadata, JSON-LD per jenis halaman, sitemap, feed, dan peta pengalihan legacy |
| [`aksesibilitas.md`](aksesibilitas.id.md) | Apa yang sudah ada, dan bagaimana itu diverifikasi — jalankan axe-core sungguhan di CI, bukan sekadar membaca kode |
| [`responsif.md`](responsif.id.md) | Grid yang sebagian besar fluid, dan bagaimana itu diverifikasi — browser sungguhan memeriksa overflow di CI, bukan sekadar membaca kode |
| [`ui-ux.md`](ui-ux.id.md) | Sistem desain: token, gambar produk, kontras lencana terhitung, presentasi harga/stok |
| [`pengujian.md`](pengujian.id.md) | Empat tingkat tes — mana yang butuh PostgreSQL, mana yang menjalankan browser sungguhan, dan mana yang tidak |
| [`deployment.md`](deployment.id.md) | Build vs. serve, variabel environment, topologi produksi, image yang dipublikasikan, apa yang boleh dan tidak boleh dijangkau container |
| [`alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md) | Branching, pengaturan branch protection nyata, changeset, pemotongan rilis |
| [`rilis.md`](rilis.id.md) | Runbook rilis end-to-end: changeset ke tag, `release:images`, `release:publish`, bukti, verifikasi konsumen |
| [`template.md`](template.id.md) | Menggunakan awcms-one sebagai template: `template:init`, matriks profil build, seed per profil, BjekMart sebagai contoh referensi |

## Apa yang tidak diduplikasi direktori ini

[`knowledge/curated/`](../knowledge/curated/) sudah menyatakan lima fakta yang tidak bisa disimpulkan dari kode — peta struktural monorepo, batas kepemilikan subtree, sambungan kontrak backend/storefront, penunjuk keamanan/isolasi-tenant, dan alasan re-platform — dan direktori ini menautkan ke masing-masing alih-alih menyatakannya ulang. `apps/cms/src/modules/commerce/README.md` adalah dokumentasi modul commerce sendiri, berdekatan-kode; [`cms.md`](cms.id.md) di sini menautkan ke sana untuk detail per-field alih-alih mengulanginya. Arsitektur, threat model, dan korpus ADR `apps/cms` sendiri (ruang penomoran terpisah dari [`adr/`](adr/README.id.md) di sini) hidup di bawah `apps/cms/docs/` sebagai dokumentasi `ahliweb/awcms` sendiri, dibawa oleh embed subtree — repositori ini tidak mengatur atau menduplikasinya.

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber yang otoritatif; Bahasa Indonesia di `<name>.id.md` adalah mirror, dicap `bun run docs:i18n:stamp` setelah diterjemahkan dan diperiksa `bun run audit:translation`. Setiap dokumen di direktori ini, termasuk setiap berkas di bawah `adr/`, berada dalam cakupan gate itu — lihat `isInScope` milik `packages/gerbang/lib/docs-i18n-checks.mjs`, yang mencakup segala sesuatu di bawah `docs/**`.
