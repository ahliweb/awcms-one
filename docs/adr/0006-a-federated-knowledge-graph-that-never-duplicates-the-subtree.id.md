🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0006-a-federated-knowledge-graph-that-never-duplicates-the-subtree.md)

<!-- i18n-source-hash: sha256:4bc2415d7cbe20bd8890f4c3d7a340c1fd252880c99732a37597d065c9e3afd6 -->

# ADR-0006 — Graf pengetahuan federasi: dimiliki root, code-only, tidak pernah menduplikasi milik `apps/cms`

- **Status:** Diterima
- **Tanggal:** 15 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [issue #11](https://github.com/ahliweb/awcms-one/issues/11) (cakupan alur kerja ini sendiri, dan "Recommended architecture" yang menjadi dasarnya); [`knowledge/README.md`](../../knowledge/README.md) (mekanisme lengkap — ADR ini menyatakan ulang keputusannya, bukan mekanismenya, agar keduanya tidak saling menyimpang); [ADR-0001](0001-git-subtree-with-full-history-for-apps-cms.md) (mengapa `apps/cms` tidak pernah diedit tangan dari repositori ini)

## Konteks

`apps/cms` sudah membawa graf Graphify-nya sendiri, `.graphifyignore`-nya sendiri, dan gate-nya sendiri (`apps/cms/scripts/graph-artifacts-check.ts`) — diwarisi utuh dari `ahliweb/awcms` lewat embed subtree. `awcms-one` bukan salinan telanjang dari repositori itu: ia monorepo Bun di mana workspace yang dimiliki root (`apps/storefront`, `packages/*`, `tools/`, `docs/`, `knowledge/` sendiri) tidak punya cakupan graf sama sekali — dan `README.md` menyatakannya terus terang: `audit:graf` ditahan sampai ada korpus nyata untuk dijaganya, alih-alih diporting lebih awal sebagai pemeriksaan yang akan lolos begitu saja selamanya.

Jalan pintas yang menggoda — mengekstraksi satu graf atas seluruh repositori, `apps/cms` termasuk — dipertimbangkan dan ditolak sebelum sempat dicoba: graf milik `apps/cms` sendiri sudah sekitar 12.700 node. Mengekstraksi ulang tree itu di root akan membangun salinan kedua yang bersaing dari graf kode yang sama, ter-commit di sini, tumbuh setiap kali salah satu sisi tumbuh, dengan dua otoritas kini bisa saling tidak sepakat soal berkas yang sama.

## Keputusan

Dua graf, bukan satu, sengaja dijaga terpisah:

- **`graphify-out/graph.json`** — graf milik workspace ini sendiri, dimiliki root, dibangun lewat `graphify extract . --code-only` dengan `.graphifyignore` mengecualikan `apps/cms/**` sepenuhnya. Terukur 396 node, 599 edge, 25 komunitas saat tulisan ini dibuat — dua orde magnitudo lebih kecil dari milik `apps/cms` sendiri, karena hanya mencakup apa yang benar-benar dimiliki repositori ini.
- **`apps/cms/graphify-out/graph.json`** — tidak disentuh, read-only dari sudut pandang repositori ini, artefak milik `awcms` sendiri, tiba di sini hanya lewat sinkronisasi subtree biasa (ADR-0001), tidak pernah diedit tangan atau digenerate ulang oleh apa pun di bawah `tools/` atau `packages/gerbang/`.

**Ekstraksi bersifat code-only secara default, dan ini properti keamanan, bukan performa:** `--code-only` melakukan ekstraksi AST lokal tanpa panggilan LLM jenis apa pun, untuk berkas apa pun, kapan pun, di jalur default alur kerja ini — diverifikasi langsung (baik `GEMINI_API_KEY` maupun `GOOGLE_API_KEY` tidak diset di mesin tempat ini dibangun, dan mode code-only `graphify` tidak membaca kunci provider lain apa pun), dan `graphify-out/cost.json` mencatat 0/0 token di setiap run, dicetak `audit:graf` di setiap pemeriksaan sehingga angka bukan-nol akan terlihat, bukan diam-diam. Penamaan komunitas (`graphify cluster-only .`) sama: tanpa backend LLM terkonfigurasi ia jatuh ke penamaan deterministik gratis berbasis-hub, dan 25 komunitas graf ini lalu diberi nama pilihan-manusia, berbahasa-polos, dengan tangan — disiplin yang sama yang didokumentasikan dan ditegakkan gate-nya sendiri oleh graf milik `apps/cms` sendiri.

**Tampilan federasi gabungan ada, tapi hanya sesuai permintaan dan tidak pernah ter-commit.** `bun run knowledge:graph:combine` menggabungkan graf ini dengan milik `apps/cms` sendiri menjadi `graphify-out/combined/graph.json` untuk pertanyaan lintas-workspace yang sungguh-sungguh ("apa di `apps/storefront` yang bergantung pada sesuatu di `apps/cms`") — di-gitignore, digenerate ulang segar setiap kali, tidak pernah menggantikan salah satu graf di wilayahnya sendiri. Draf awal alur kerja ini mempertimbangkan meng-commit berkas gabungan itu agar clone segar tidak perlu menginstal `graphify` untuk menanyainya; diukur terhadap ukuran nyata di atas, graf gabungan mencapai puluhan megabyte — pada dasarnya salinan kedua yang tumbuh dari graf milik `apps/cms` sendiri, ter-commit di root, persis duplikasi yang ingin dihindari keputusan ini. Ekspor Obsidian (`bun run knowledge:obsidian:export`) mengikuti aturan yang sama untuk catatan alih-alih JSON: ia hanya men-staging dan memvalidasi graf root, tidak pernah graf gabungan, untuk alasan yang identik — mengekspor graf gabungan akan menulis satu catatan per node, hampir 13.000 di antaranya, hampir semua menyatakan ulang isi milik `apps/cms` sendiri, ke dalam direktori yang di-commit repositori ini.

Mekanisme lengkap, tabel artefak terlacak/tak-terlacak, toolchain, dan tabel keamanan-dan-privasi sembilan-butir didokumentasikan sekali, di [`knowledge/README.md`](../../knowledge/README.md); ADR ini tidak menduplikasinya.

## Konsekuensi

- `bun run audit:graf` berjalan di CI tanpa syarat (ia hanya membaca artefak yang sudah ter-commit, tidak butuh jaringan dan tidak butuh biner `graphify`) dan memeriksa, antara lain, bahwa tidak ada node di graf root terlacak yang `source_file`-nya di bawah `apps/cms/` — bukti mekanis bahwa tidak ada ekstraksi duplikat yang tidak sengaja terjadi, bukan sekadar kebijakan yang dinyatakan dalam prosa.
- Perubahan pada kebijakan Graphify **milik `apps/cms` sendiri** (`.graphifyignore`-nya, daftar artefak terlacaknya, gate-nya) diusulkan di [`ahliweb/awcms#805`](https://github.com/ahliweb/awcms/issues/805) dan tiba di sini lewat sinkronisasi subtree biasa — tidak pernah diedit lokal, dengan alasan yang sama mengapa tidak ada bagian lain `apps/cms` yang diedit lokal (ADR-0001).
- Graf root adalah alat bantu navigasi atas repositori ini, tidak pernah sumber kebenaran: bagian "Working with the knowledge graph" milik `knowledge/README.md` sendiri — dan diulang `AGENTS.md` — menyatakan bahwa setiap temuan yang disingkapkannya harus diverifikasi terhadap kode, tes, dan kontrak terkini sebelum siapa pun bertindak atasnya, dan bahwa label komunitas hasil-generate atau skor kohesi rendah adalah artefak struktural dari clustering, tidak pernah dengan sendirinya bukti cacat desain.
