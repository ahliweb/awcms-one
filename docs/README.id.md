🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:f9cf98320c2b83c7a8cdf716d63bd774aaefbb651b42be44323dd07bc1d47234 -->

# Dokumentasi

Dokumentasi arsitektur, skema, API, alur kerja CMS, perilaku storefront, pengujian, deployment, dan proses untuk `awcms-one` — mendeskripsikan repositori **sebagaimana ia benar-benar ada setelah setiap PR implementasi digabung** (issue #2–#6, #11), tidak pernah sebagaimana direncanakan semula. Di mana tree dan teks asli suatu issue berbeda, dokumen-dokumen ini mengikuti tree, dan menyatakannya.

| Dokumen | Isi |
| --- | --- |
| [`arsitektur.md`](arsitektur.md) | Topologi dua-deployable, arah impor satu-jalur, embed subtree, aliran data saat-build |
| [`adr/`](adr/README.md) | Enam Architecture Decision Record — trade-off di balik setiap keputusan struktural di atas |
| [`skema-basis-data.md`](skema-basis-data.md) | Tabel `awcms_commerce_*`: kolom, tipe, constraint, indeks, RLS |
| [`kamus-data.md`](kamus-data.md) | Kamus data: setiap kolom, maknanya, dan kolom sumber legacy `commerce_bj_mart`-nya |
| [`api.md`](api.md) | Endpoint `/api/v1/commerce/*`, envelope, paginasi, izin, domain event |
| [`cms.md`](cms.md) | Authoring, mesin status produk, izin, log audit, media, taksonomi |
| [`routing.md`](routing.md) | Setiap rute storefront dan bagaimana `getStaticPaths()` menurunkannya |
| [`seo.md`](seo.md) | Metadata, JSON-LD `Product`, dan pertahanan XSS di sekitarnya |
| [`aksesibilitas.md`](aksesibilitas.md) | Apa yang sudah ada, dan bahwa itu diverifikasi dengan membaca kode, bukan alat |
| [`responsif.md`](responsif.md) | Grid fluid tanpa-breakpoint, dan bahwa itu diverifikasi dengan membaca kode, bukan browser |
| [`ui-ux.md`](ui-ux.md) | Tanpa gambar produk, kontras lencana terhitung, presentasi harga/stok |
| [`pengujian.md`](pengujian.md) | Tiga suite tes, yang butuh PostgreSQL, dan yang tidak |
| [`deployment.md`](deployment.md) | Build vs. serve, variabel environment, apa yang boleh dan tidak boleh dijangkau container |
| [`alur-kerja-pengembangan.md`](alur-kerja-pengembangan.md) | Branching, pengaturan branch protection nyata, changeset, pemotongan rilis |

## Apa yang tidak diduplikasi direktori ini

[`knowledge/curated/`](../knowledge/curated/) sudah menyatakan lima fakta yang tidak bisa disimpulkan dari kode — peta struktural monorepo, batas kepemilikan subtree, sambungan kontrak backend/storefront, penunjuk keamanan/isolasi-tenant, dan alasan re-platform — dan direktori ini menautkan ke masing-masing alih-alih menyatakannya ulang. `apps/cms/src/modules/commerce/README.md` adalah dokumentasi modul commerce sendiri, berdekatan-kode; [`cms.md`](cms.md) di sini menautkan ke sana untuk detail per-field alih-alih mengulanginya. Arsitektur, threat model, dan korpus ADR `apps/cms` sendiri (ruang penomoran terpisah dari [`adr/`](adr/README.md) di sini) hidup di bawah `apps/cms/docs/` sebagai dokumentasi `ahliweb/awcms` sendiri, dibawa oleh embed subtree — repositori ini tidak mengatur atau menduplikasinya.

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber yang otoritatif; Bahasa Indonesia di `<name>.id.md` adalah mirror, dicap `bun run docs:i18n:stamp` setelah diterjemahkan dan diperiksa `bun run audit:translation`. Setiap dokumen di direktori ini, termasuk setiap berkas di bawah `adr/`, berada dalam cakupan gate itu — lihat `isInScope` milik `packages/gerbang/lib/docs-i18n-checks.mjs`, yang mencakup segala sesuatu di bawah `docs/**`.
