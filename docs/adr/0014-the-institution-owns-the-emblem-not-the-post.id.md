🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0014-the-institution-owns-the-emblem-not-the-post.md)

<!-- i18n-source-hash: sha256:7b96f10d14a48cb89eb6770ca9c5c17d50f7fe6f34b20b080f0f7ee988938693 -->

# ADR-0014 — Lembaga yang memiliki lambangnya; sebuah pos tidak pernah membawa satu pun

- **Status:** Accepted
- **Tanggal:** 18 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.id.md), [ADR-0011](0011-storefront-media-resolves-through-the-media-objects-endpoint.id.md); issue #59; upstream `ahliweb/awcms#806`

## Konteks

seputarborneo.com v2.3.0 menambahkan "Logo Instansi": lambang kabupaten yang ditautkan ke sebuah **artikel** lewat `berita_red.id_logo`, dengan tabel `logo`, pemilih di setiap form berita, dan aturan bahwa logo yang masih dipakai tidak boleh dihapus. Fitur itu ada karena artikel sebuah kabupaten memang seharusnya membawa lambang kabupaten tersebut.

Platform ini sudah memodelkan hubungan yang sama: setiap artikel semacam itu difilekan di bawah lembaga kabupaten tersebut (`awcms_blog_institutions`, "Mitra" pada `/mitra/{slug}`).

## Keputusan

Lambang menempel pada **lembaga** (`logo_media_id`/`logo_alt`), bukan pada pos. Karena `blog_content` adalah modul milik upstream, kolomnya ditambahkan di `ahliweb/awcms` (#806/#807) dan sampai ke repositori ini lewat `git subtree pull` yang digabung dengan merge commit; `apps/storefront` merendernya di samping paragraf pembuka artikel dan di halaman lembaga itu sendiri.

| | Pemilih per-pos (porting apa adanya) | Modul aditif di repositori ini | Per-lembaga, di upstream (**dipilih**) |
| --- | --- | --- | --- |
| Upaya redaksi | redaktur memilih logo di setiap artikel | sama | nol — memfilekan artikel ke Mitra-nya memang sudah alur kerjanya |
| Konsistensi | sebuah artikel bisa membawa logo yang bertentangan dengan kanalnya | sama | mustahil secara konstruksi |
| "Satu logo dipakai berulang" | tabel bersama plus foreign key per-pos | sama | satu baris, satu unggahan, seluruh artikel kanal itu |
| Kepemilikan | menambal subtree yang bukan milik repositori ini | konsep logo kedua di samping `media_library` | field berada bersama entitas yang dijelaskannya, di upstream, untuk setiap situs awcms |

## Konsekuensi

- Mengganti lambang sebuah lembaga memperbarui seluruh artikel kanal itu sekaligus — properti yang justru dikejar aturan "satu logo dipakai berulang" milik seputarborneo, tanpa penjaga-hapus, karena tidak ada yang menunjuk lambang itu selain lembaganya sendiri.
- `logoMediaId`/`logoAlt` bersifat **opsional** pada tipe milik storefront: build yang diarahkan ke `apps/cms` yang lebih tua dari subtree pull tidak merender lambang, bukan meledak.
- Artikel tanpa lembaga, lembaga tanpa lambang, atau id media basi tidak merender apa pun — tidak pernah bingkai kosong.
- Sisi upstream dari ini sekalian menutup lubang nyata: `media_library` sama sekali tidak mengenali unggahan SVG, dan kini mengenalinya **serta** memindainya (elemen skrip, penangan kejadian, URI `javascript:`/`data:` setelah rujukan-karakter didekode, `<!ENTITY` apa pun) — lambang adalah jenis media yang paling mungkin datang sebagai SVG.
