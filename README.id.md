🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:6bf4272daea1da3b40ae19e547bf767d940c07e6777514194bc6441c4e805e8f -->

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE) [![runtime](https://img.shields.io/badge/runtime-Bun-blue?logo=bun&logoColor=white)](https://bun.sh)

# awcms-one

**awcms-one** adalah platform komersial borneojek-mart, yang di-re-platform dari PHP/Laravel/MySQL/React-Inertia ke stack AWCMS — Bun, Astro, dan PostgreSQL di bawah row-level security. Ini adalah **re-platform, bukan refactor**: tidak ada kode Laravel yang dibawa. Skema sumber dibaca dari basis data MySQL `commerce_bj_mart` yang hidup dan diekspresikan ulang sebagai tabel modul AWCMS di bawah RLS PostgreSQL. Kerangka dan epic lengkapnya ada di [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

## Letak repo ini di keluarga AWCMS

| | |
| --- | --- |
| **Repo ini** | `ahliweb/awcms-one` — monorepo Bun: satu backend komersial (`apps/cms`), satu storefront publik (`apps/storefront`, sedang dikerjakan), satu kontrak DTO bersama (`packages/kontrak`, sedang dikerjakan) |
| **Backend / system of record** | `apps/cms`, di repo ini — `ahliweb/awcms` disematkan utuh lewat `git subtree`, menjaga riwayat upstream tetap ada |
| **Repo model** | [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng) — tata letak workspace, gerbang audit, konvensi changeset, dan struktur dokumen governance di repo ini diadaptasi darinya |

## Kenapa `apps/cms` menyematkan `awcms` utuh

Modul commerce yang dibutuhkan platform ini tidak bisa berdiri sendiri — ia bergantung pada infrastruktur bersama `awcms` yang tidak punya paket mandiri: `withTenant` (konteks tenant RLS), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (outbox), `recordAuditEvent`, `_shared/module-contract` (`defineModule`), `getDatabaseClient`, runner migrasi SQL, dan `_shared/api-response`. Jadi `awcms` disematkan utuh, lewat `git subtree`, alih-alih dijadikan dependency sebagai paket — lihat [`AGENTS.md`](AGENTS.md#the-subtree-embed) untuk mekanika sinkronisasi dan satu aturan yang melindunginya.

## Pendekatan: fondasi dulu, lalu satu vertical slice tipis

Scaffold dulu, lalu **satu vertical slice tipis** — daftar katalog + detail produk — untuk membuktikan stack-nya bekerja dari ujung ke ujung sebelum pembangunan commerce penuh.

**Increment 1 (epic ini): fondasi + slice yang ditulis tangan, tanpa basis data hidup.** Semuanya type-check dan setiap gerbang yang tidak butuh PostgreSQL berjalan hijau. Memigrasi dan mengisi instans PostgreSQL sungguhan lalu merender darinya adalah increment 2 — AWCMS hanya-PostgreSQL sementara server borneojek berjalan MySQL, jadi instans Postgres harus disediakan lebih dulu.

Di luar cakupan increment 1: keranjang, checkout, pembayaran, pesanan, pengiriman, afiliasi, flash sale, varian, harga bertingkat, asuransi, tabel ukuran, banner promo. Slice skemanya sengaja adalah inti katalog; sisa dari tabel `products` sumber mendarat di increment berikutnya.

## Yang ada hari ini, dan yang masih dikerjakan

Repo ini masih dini: saat ini memuat akar workspace, governance dan perkakasnya, `packages/config`, dan `apps/cms`. **`apps/storefront` dan `packages/kontrak` belum ada** — keduanya sedang dikerjakan di [issue #5](https://github.com/ahliweb/awcms-one/issues/5) dan [issue #6](https://github.com/ahliweb/awcms-one/issues/6). Di mana pun dokumen ini atau `AGENTS.md` perlu menjelaskannya, ia menyatakannya terus terang alih-alih menjelaskan jalur yang belum ada.

```
apps/
└── cms/                     ahliweb/awcms v10.3.0, disematkan lewat git subtree dengan riwayat penuh —
                              backend komersial dan system of record (closes #2)
packages/
├── config/                  preset tsconfig bersama
└── gerbang/                 gerbang audit workspace ini, sebagai paket
tools/                       skrip lintas-workspace: rilis, pemeriksaan lockfile, stamp i18n docs
tests/                       tes gerbang tingkat akar (docs, changeset, toolchain, skrip)
.changesets/, .github/       tetap di akar repo — keputusan tentang repo secara keseluruhan
```

Direncanakan, belum ada:

- **`apps/storefront`** (issue #5) — storefront Astro publik: daftar katalog dan detail produk, hanya membaca API publik `apps/cms`.
- **`packages/kontrak`** (issue #6) — kontrak DTO bertipe-saja yang akan diimpor `apps/storefront` dari `apps/cms`, plus gerbang arah-impor yang menjaganya tetap satu arah.
- **Modul `commerce`** (issue #4) — domain katalog, persistensi, migrasi, dan API di dalam `apps/cms`.
- **Dokumentasi arsitektur dan referensi** (issue #7).

## Menjalankannya

```bash
cp .env.example .env
bun install
bun test               # rangkaian gerbang akar — lihat "Gerbang" di bawah
```

Repo ini **hanya-Bun**: Bun adalah runtime sekaligus package manager, versinya dipin di `packageManager`/`engines.bun`, dan `bun.lock` adalah satu-satunya lockfile.

| Perintah | Kegunaan |
| --- | --- |
| `bun install` | Meresolusi seluruh workspace |
| `bun test` | Rangkaian gerbang akar. `bunfig.toml` mengecualikan `apps/cms/**` — rangkaian itu ~500 berkas dan butuh PostgreSQL hidup; ia berjalan di bawah gerbangnya sendiri, `bun run check:cms` |
| `bun run check:lockfile` | Membuktikan `bun.lock` benar-benar milik `package.json` repo ini, untuk akar dan setiap anggota workspace |
| `bun run audit:dokumen` | Tautan markdown mati, indeks ADR (begitu `docs/adr/` ada), jalur berkas yang disebut sebuah dokumen, kutipan `ADR-NNNN`, dan hitungan tertaut bertanda |
| `bun run audit:rilis` | Backlog `.changesets/` yang menunggu, dibatasi 10 berkas dan 14 hari |
| `bun run audit:translation` | Cermin Indonesia dokumen governance yang basi atau hilang |
| `bun run audit:graf` (alias: `knowledge:check`) | Korpus graf pengetahuan akar menggambarkan dirinya sendiri secara jujur — lihat [`knowledge/README.md`](knowledge/README.md) |
| `bun run knowledge:graph:update` | Membangun ulang graf Graphify akar (`--code-only`, tanpa LLM) — butuh `graphify` di `PATH`, tidak dijalankan di CI |
| `bun run knowledge:graph:combine` | Menggabungkan graf akar dengan graf milik `apps/cms` sendiri menjadi graf federasi yang di-gitignore dan sesuai permintaan — butuh `graphify` di `PATH` |
| `bun run knowledge:obsidian:export` | Mementaskan, memvalidasi, dan menyinkronkan ekspor Obsidian yang aman dari graf akar ke `knowledge/generated/graphify/` — butuh `graphify` di `PATH` |
| `bun run docs:i18n:stamp` | Menulis banner bahasa dan penanda hash sumber pada setiap cermin `.id.md` |
| `bun run check:cms` | Rangkaian gerbang penuh `apps/cms` sendiri (lint, typecheck, tesnya sendiri, build-nya sendiri) |
| `bun run db:migrate:cms` | Menjalankan migrasi `apps/cms` terhadap `DATABASE_URL` — lihat `apps/cms/.env.example` |
| `bun run release` | Memotong rilis bertag dari changeset yang menunggu — lihat [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| `dev` / `build` / `check` / `serve` | Mendelegasikan ke `apps/storefront` begitu ia ada (issue #5); belum ada yang bisa dijalankannya |

### Gerbang

`bun test` plus empat skrip `audit:*`, semuanya diadaptasi dari `packages/gerbang` milik `ahliweb/media-lenterakalteng`. Tidak satu pun butuh build, jaringan, atau `apps/cms`, jadi semuanya berjalan tanpa syarat di setiap push.

`audit:graf` (kebersihan artefak graphify) dulu ada di daftar "tidak diporting" di bawah — repo ini belum punya korpus `graphify-out/` untuk dijaganya. [Issue #11](https://github.com/ahliweb/awcms-one/issues/11) membangun satu: graf Graphify milik-akar, `--code-only`, yang sengaja mengecualikan `apps/cms/**` (yang sudah punya graf dan gerbangnya sendiri), plus keluarga perintah federasi (`bun run knowledge:graph:update` / `knowledge:graph:combine` / `knowledge:obsidian:export`) yang didokumentasikan di [`knowledge/README.md`](knowledge/README.md). `audit:graf` sekarang memeriksa korpus itu sungguhan — lihat dokumen itu untuk persisnya apa.

**Masih tidak diporting**, dan itu disengaja: `media-lenterakalteng` juga membawa `audit:konten` (pemeriksaan konten keluaran terbit), `audit:aset` (anggaran byte pembaca), dan `audit:serapan` (penyerapan ADR upstream). Setiap satu darinya menjaga permukaan — keluaran HTML yang dibangun, server hidup yang bisa dirayapi — yang belum dimiliki repo ini. Memporting-nya sekarang akan mengirim gerbang yang selalu lulus secara trivial, yang terbaca lebih berbahaya daripada tanpa gerbang sama sekali: sebuah pemeriksaan hijau yang tidak memeriksa apa pun terlihat persis seperti yang memeriksa sesuatu dan menemukannya bersih.

## Dokumentasi

| Dokumen | Isi |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | Kontrak kerja repo ini — dibaca sebelum melakukan apa pun, manusia maupun agen |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Penyiapan, alur kerja, konvensi branch/commit, Definition of Done |
| [`SECURITY.md`](SECURITY.md) | Cara melaporkan kerentanan, dan permukaan serangan repo ini hari ini |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Peran, alur keputusan, rilis |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Perilaku yang diharapkan |
| [`SUPPORT.md`](SUPPORT.md) | Ke mana pertanyaan atau laporan bug diarahkan |
| [`CHANGELOG.md`](CHANGELOG.md) | Riwayat rilis, dilipat dari changeset |
| [`.changesets/README.md`](.changesets/README.md) | Cara menulis catatan perubahan |
| [`knowledge/README.md`](knowledge/README.md) | Workflow graf pengetahuan Graphify + Obsidian yang terfederasi |

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber otoritatif; Bahasa Indonesia di `<nama>.id.md` adalah cerminnya, dan ia mencatat hash dari bahasa Inggris yang diterjemahkannya. `bun run audit:translation` gagal saat sebuah cermin menjadi basi. Cermin dokumen ini adalah [`README.id.md`](README.id.md).

Kode repo ini sendiri (`packages/gerbang/`, `tools/`, `tests/`) ditulis dalam bahasa Inggris sepenuhnya — identifier, komentar, maupun pesan gerbang. `apps/cms` membawa konvensinya sendiri yang terpisah sebagai kode `ahliweb/awcms` yang disematkan; repo ini tidak mengatur atau mengubahnya.

## Lisensi

[MIT](LICENSE) untuk kode di repo ini. `apps/cms` membawa lisensi dan notice hak cipta `ahliweb/awcms` sendiri sebagai bagian dari riwayat yang disematkan; lihat `LICENSE` workspace itu sendiri.
