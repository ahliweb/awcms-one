🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:0bdea7413679cb1da42a306a5846dfe75c0a6ddfaa0960cc2ed8f4e1b427aad8 -->

# Dokumentasi

Dokumentasi arsitektur, skema, API, alur kerja CMS, perilaku storefront, pengujian, deployment, dan proses untuk `awcms-one` — mendeskripsikan repositori **sebagaimana ia benar-benar ada setelah setiap PR implementasi digabung** (increment 1: issue #2–#6, #11; increment 2, epic [#21](https://github.com/ahliweb/awcms-one/issues/21): issue #22–#30; increment 3, epic [#46](https://github.com/ahliweb/awcms-one/issues/46): issue #47–#60; increment 4, epic [#32](https://github.com/ahliweb/awcms-one/issues/32): issue #86–#93), tidak pernah sebagaimana direncanakan semula. Di mana tree dan teks asli suatu issue berbeda, dokumen-dokumen ini mengikuti tree, dan menyatakannya.

| Dokumen | Isi |
| --- | --- |
| [`arsitektur.md`](arsitektur.id.md) | Topologi dua-deployable, arah impor satu-jalur, embed subtree, jalur runtime anonim (ADR-0007), tingkat kepercayaan ketiga pelanggan-terautentikasi (ADR-0016), CSP turunan |
| [`adr/`](adr/README.id.md) | Enam belas Architecture Decision Record — trade-off di balik setiap keputusan struktural di atas |
| [`skema-basis-data.md`](skema-basis-data.id.md) | Setiap tabel `awcms_commerce_*`: kolom, tipe, constraint, indeks, RLS |
| [`kamus-data.md`](kamus-data.id.md) | Kamus data: setiap kolom, maknanya, dan kolom sumber legacy `commerce_bj_mart`-nya |
| [`api.md`](api.id.md) | API owner dan storefront anonim, envelope, paginasi, izin, domain event |
| [`cms.md`](cms.id.md) | Authoring, mesin status produk/pesanan/flash-sale, izin, log audit, media, taksonomi |
| [`routing.md`](routing.id.md) | Peta URL publik lengkap — katalog, berita, halaman runtime commerce, pengalihan legacy |
| [`seo.md`](seo.id.md) | Metadata, JSON-LD per jenis halaman, sitemap, feed, dan peta pengalihan legacy |
| [`aksesibilitas.md`](aksesibilitas.id.md) | Apa yang sudah ada, dan bahwa itu diverifikasi dengan membaca kode, bukan alat |
| [`responsif.md`](responsif.id.md) | Grid yang sebagian besar fluid plus beberapa breakpoint yang disengaja, dan bahwa itu diverifikasi dengan membaca kode, bukan browser |
| [`ui-ux.md`](ui-ux.id.md) | Gambar produk sungguhan, kontras lencana terhitung, kontrak keranjang, presentasi harga/stok |
| [`pengujian.md`](pengujian.id.md) | Empat tingkat tes, mana yang butuh PostgreSQL, dan mana yang tidak |
| [`deployment.md`](deployment.id.md) | Build vs. serve, variabel environment, apa yang boleh dan tidak boleh dijangkau container dan browser |
| [`alur-kerja-pengembangan.md`](alur-kerja-pengembangan.id.md) | Branching, pengaturan branch protection nyata, changeset, pemotongan rilis, dua job CI |

## Apa yang tidak diduplikasi direktori ini

[`knowledge/curated/`](../knowledge/curated/) sudah menyatakan lima fakta yang tidak bisa disimpulkan dari kode — peta struktural monorepo, batas kepemilikan subtree, sambungan kontrak backend/storefront, penunjuk keamanan/isolasi-tenant, dan alasan re-platform — dan direktori ini menautkan ke masing-masing alih-alih menyatakannya ulang. `apps/cms/src/modules/commerce/README.md` adalah dokumentasi modul commerce sendiri, berdekatan-kode; [`cms.md`](cms.id.md) di sini menautkan ke sana untuk detail per-field alih-alih mengulanginya. Arsitektur, threat model, dan korpus ADR `apps/cms` sendiri (ruang penomoran terpisah dari [`adr/`](adr/README.id.md) di sini) hidup di bawah `apps/cms/docs/` sebagai dokumentasi `ahliweb/awcms` sendiri, dibawa oleh embed subtree — repositori ini tidak mengatur atau menduplikasinya.

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber yang otoritatif; Bahasa Indonesia di `<name>.id.md` adalah mirror, dicap `bun run docs:i18n:stamp` setelah diterjemahkan dan diperiksa `bun run audit:translation`. Setiap dokumen di direktori ini, termasuk setiap berkas di bawah `adr/`, berada dalam cakupan gate itu — lihat `isInScope` milik `packages/gerbang/lib/docs-i18n-checks.mjs`, yang mencakup segala sesuatu di bawah `docs/**`.
