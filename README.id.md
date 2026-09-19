🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:a257453f1002dcaaea8f7f798e7c3a968ce3a67b252451d282c626775810d9c7 -->

[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE) [![runtime](https://img.shields.io/badge/runtime-Bun-blue?logo=bun&logoColor=white)](https://bun.sh)

# awcms-one

**awcms-one** adalah platform komersial borneojek-mart, yang di-re-platform dari PHP/Laravel/MySQL/React-Inertia ke stack AWCMS — Bun, Astro, dan PostgreSQL di bawah row-level security. Ini adalah **re-platform, bukan refactor**: tidak ada kode Laravel yang dibawa. Skema sumber dibaca dari basis data MySQL `commerce_bj_mart` yang hidup dan diekspresikan ulang sebagai tabel modul AWCMS di bawah RLS PostgreSQL. Kerangka dan epic lengkapnya ada di [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

## Letak repo ini di keluarga AWCMS

| | |
| --- | --- |
| **Repo ini** | `ahliweb/awcms-one` — monorepo Bun: satu backend komersial (`apps/cms`), satu storefront publik (`apps/storefront`), satu kontrak DTO bersama (`packages/kontrak`) |
| **Backend / system of record** | `apps/cms`, di repo ini — `ahliweb/awcms` disematkan utuh lewat `git subtree`, menjaga riwayat upstream tetap ada |
| **Repo model** | [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng) — tata letak workspace, gerbang audit, konvensi changeset, dan struktur dokumen governance di repo ini diadaptasi darinya |

## Kenapa `apps/cms` menyematkan `awcms` utuh

Modul commerce yang dibutuhkan platform ini tidak bisa berdiri sendiri — ia bergantung pada infrastruktur bersama `awcms` yang tidak punya paket mandiri: `withTenant` (konteks tenant RLS), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (outbox), `recordAuditEvent`, `_shared/module-contract` (`defineModule`), `getDatabaseClient`, runner migrasi SQL, dan `_shared/api-response`. Jadi `awcms` disematkan utuh, lewat `git subtree`, alih-alih dijadikan dependency sebagai paket — lihat [`AGENTS.md`](AGENTS.md#the-subtree-embed) untuk mekanika sinkronisasi dan satu aturan yang melindunginya.

## Pendekatan: fondasi dulu, lalu satu vertical slice tipis, lalu toko lengkap

Scaffold dulu (increment 1: daftar katalog + detail produk, tanpa basis data hidup), lalu **increment 2** (epic [#21](https://github.com/ahliweb/awcms-one/issues/21)): paritas penuh BjekMart/news-portal — PostgreSQL tersedia untuk pengembangan lokal dan CI, modul `commerce` yang lengkap (kedalaman katalog, marketing, pesanan), dan situs publik yang lengkap (katalog, berita, keranjang, checkout, pelacakan pesanan, wishlist). Lalu **increment 3** (epic [#46](https://github.com/ahliweb/awcms-one/issues/46)): paritas fungsional dengan seputarborneo.com v2.4.0 — gambar sungguhan di setiap permukaan, chrome berita dan sidebar bersama, form buletin, baris bagikan, pemutar "Dengarkan berita ini", popup iklan, metadata sosial lengkap, pengalihan lawas berbasis aturan, analitik pengunjung first-party dengan sakelar GA4 opt-in, seed berbentuk seputarborneo dan exporter dump lawas, serta lambang lembaga. Lalu **increment 4** (epic [#32](https://github.com/ahliweb/awcms-one/issues/32)): identitas pelanggan sungguhan ([ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md)) — login/registrasi OTP e-mail, sesi bearer opak, dashboard akun (alamat, riwayat pesanan, ulasan, wishlist tersinkron), dan program afiliasi dengan penangkapan `?ref=`, atribusi checkout, dan layar moderasi owner. Lalu **increment 5** (epic [#33](https://github.com/ahliweb/awcms-one/issues/33)): fitur BjekMart khusus admin yang tidak punya padanan di situs publik, dan dua integrasi eksternal yang dilewatkan awcms lewat outbox ([ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.id.md)) — ongkir kurir RajaOngkir, outbox/OTP WhatsApp, payment gateway Midtrans Snap dengan intake webhook beralamat token dan job rekonsiliasi, POS (penjualan tunai, `orders.channel`), laporan penjualan (proyeksi per hari/produk/kategori), inbox pelanggan, kampanye marketing dengan consent, serta sakelar fitur per tenant plus harga bertingkat saat quote.

## Yang ada hari ini, dan yang tidak

Setiap issue anak dari [issue #21](https://github.com/ahliweb/awcms-one/issues/21), [issue #46](https://github.com/ahliweb/awcms-one/issues/46), [issue #32](https://github.com/ahliweb/awcms-one/issues/32), dan [issue #33](https://github.com/ahliweb/awcms-one/issues/33) sudah mendarat: akar workspace dan governance-nya, `packages/config`, `packages/gerbang`, `packages/kontrak`, `tools/`, `knowledge/`, `docs/`, situs publik `apps/storefront` yang lengkap — kini termasuk dashboard akun pelanggan, permukaan afiliasi, opsi kurir dan redirect payment gateway saat checkout, serta inbox pelanggan (`/akun/pesan`) — dan `apps/cms` (membawa satu modul `commerce` — katalog, marketing, pesanan, akun/OTP/sesi pelanggan, afiliasi, ongkir kurir RajaOngkir, outbox WhatsApp, payment gateway Midtrans + intake webhook, POS, laporan penjualan, inbox, kampanye, dan sakelar fitur). Di mana pun dokumen ini atau `AGENTS.md` perlu mendeskripsikan permukaan yang masih belum ada, ia menyatakannya terus terang alih-alih mendeskripsikan jalur yang belum ada — lihat [`docs/arsitektur.md`](docs/arsitektur.id.md) dan [`docs/cms.md`](docs/cms.id.md) untuk daftar lengkap dan terkininya (ubah e-mail/telepon dan verifikasi telepon pada akun yang sudah ada — [ADR-0016](docs/adr/0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.id.md) D6; unggah media sungguhan untuk gambar produk/slider; deployment PostgreSQL produksi; adapter payment gateway Xendit dan pelacakan kurir, keduanya tercatat sebagai follow-up di [ADR-0017](docs/adr/0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.id.md)).

```
apps/
├── cms/                     ahliweb/awcms v10.3.0, disematkan lewat git subtree dengan riwayat penuh —
│                             backend komersial dan system of record, membawa satu modul
│                             commerce: katalog (gambar, varian, tingkatan harga), marketing
│                             (flash sale, voucher, slider, testimoni, popup, pengaturan
│                             toko), pesanan (checkout tamu, konfirmasi pembayaran, ulasan),
│                             akun/OTP/sesi bearer pelanggan, program afiliasi, ongkir kurir
│                             RajaOngkir, outbox WhatsApp + kanal OTP, payment gateway
│                             Midtrans Snap dengan intake webhook beralamat token dan job
│                             rekonsiliasi, POS, proyeksi laporan penjualan, inbox
│                             pelanggan, kampanye marketing, dan sakelar fitur per tenant —
│                             plus API anonim dan ber-bearer /api/v1/commerce/storefront/*
│                             serta route intake webhook publik
└── storefront/              storefront Astro publik: paritas katalog + berita lengkap,
                              keranjang, checkout (opsi kurir, redirect pembayaran gateway),
                              pelacakan pesanan, wishlist, dan dashboard akun pelanggan
                              (/masuk, /daftar, /akun*) dengan wishlist tersinkron,
                              permukaan afiliasi, dan inbox (/akun/pesan) — output: "static"
                              di seluruh bagian, keranjang/checkout dan permukaan akun
                              memanggil API storefront apps/cms langsung dari browser
                              (ADR-0007, ADR-0016)
packages/
├── config/                  preset tsconfig bersama
├── gerbang/                 gerbang audit workspace ini, sebagai paket
└── kontrak/                 kontrak DTO bertipe-saja yang diimpor apps/storefront dari apps/cms,
                              plus gerbang arah-impornya
tools/                       skrip lintas-workspace: rilis, pemeriksaan lockfile, stamp i18n docs,
                              update/combine/export graf pengetahuan, data seed
tests/                       tes gerbang tingkat akar (docs, changeset, toolchain, skrip,
                              arah impor)
docs/                        referensi arsitektur, skema, API, CMS, routing, SEO, aksesibilitas,
                              responsif, UI/UX, pengujian, deployment, dan alur kerja,
                              plus docs/adr/ (tujuh belas ADR)
knowledge/                   workflow graf pengetahuan Graphify + Obsidian yang terfederasi
.claude/skills/               awcms-one-storefront, awcms-one-commerce — panduan cara
                              menambah halaman storefront atau tabel/endpoint commerce
.changesets/, .github/       tetap di akar repo — keputusan tentang repo secara keseluruhan
```

PostgreSQL hidup dan tersedia kini ada untuk pengembangan lokal dan CI (`compose.yaml`, `bun run db:up`/`db:migrate:cms`/`db:seed:cms`, job CI `check-cms`) — lihat [`docs/deployment.md`](docs/deployment.id.md) untuk urutan lengkapnya, dan untuk apa yang masih benar: **belum ada deployment PostgreSQL produksi**.

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
| `bun run audit:dokumen` | Tautan markdown mati, indeks `docs/adr/` (lengkap di dua arah, kesepakatan status), jalur berkas yang disebut sebuah dokumen, kutipan `ADR-NNNN`, dan hitungan tertaut bertanda |
| `bun run audit:rilis` | Backlog `.changesets/` yang menunggu, dibatasi 20 berkas dan 14 hari |
| `bun run audit:translation` | Cermin Indonesia dokumen governance yang basi atau hilang |
| `bun run audit:graf` (alias: `knowledge:check`) | Korpus graf pengetahuan akar menggambarkan dirinya sendiri secara jujur — lihat [`knowledge/README.md`](knowledge/README.md) |
| `bun run knowledge:graph:update` | Membangun ulang graf Graphify akar (`--code-only`, tanpa LLM) — butuh `graphify` di `PATH`, tidak dijalankan di CI |
| `bun run knowledge:graph:combine` | Menggabungkan graf akar dengan graf milik `apps/cms` sendiri menjadi graf federasi yang di-gitignore dan sesuai permintaan — butuh `graphify` di `PATH` |
| `bun run knowledge:obsidian:export` | Mementaskan, memvalidasi, dan menyinkronkan ekspor Obsidian yang aman dari graf akar ke `knowledge/generated/graphify/` — butuh `graphify` di `PATH` |
| `bun run docs:i18n:stamp` | Menulis banner bahasa dan penanda hash sumber pada setiap cermin `.id.md` |
| `bun run check:cms` | Rangkaian gerbang penuh `apps/cms` sendiri (53 langkah — lint, docs, inventaris, spec, gerbang, typecheck, tesnya sendiri, build-nya sendiri) |
| `bun run db:up` / `db:down` / `db:reset` | Menyalakan/mematikan/mereset `postgres:18.4` lokal sekali-pakai (`compose.yaml`, issue #25) |
| `bun run db:migrate:cms` | Menjalankan migrasi `apps/cms` terhadap `DATABASE_URL` — lihat `apps/cms/.env.example` |
| `bun run db:seed:cms` | Men-seed tenant `borneojek-mart`, katalog, permukaan marketing, dan contoh pesanan lewat API publik `apps/cms` sendiri — lihat [`docs/deployment.md`](docs/deployment.id.md) |
| `bun run release` | Memotong rilis bertag dari changeset yang menunggu — lihat [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| `dev` / `build` / `check` / `serve` | Mendelegasikan ke `apps/storefront` — `bun run build` men-type-check, mengambil konten katalog/marketing/berita dari `apps/cms` saat build, dan memanggang output statis termasuk CSP turunan; `bun run serve` menjalankan `apps/storefront/server/penyaji.mjs` yang sudah di-build — lihat [`docs/deployment.md`](docs/deployment.id.md) |

### Gerbang

`bun test` plus empat skrip `audit:*` berjalan tanpa syarat di setiap push, tidak butuh build, jaringan, atau `apps/cms` — job CI `check`. Job CI kedua, `check-cms`, menjalankan rangkaian gerbang penuh `apps/cms` sendiri plus rangkaian integrasi ber-gerbang-DB-nya terhadap PostgreSQL hidup yang sekali-pakai (issue #25) — lihat [`docs/alur-kerja-pengembangan.md`](docs/alur-kerja-pengembangan.id.md). **Baik `Check` maupun `check-cms` adalah status check wajib di `main`.**

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
| [`docs/README.md`](docs/README.md) | Referensi arsitektur, skema, API, CMS, routing, SEO, aksesibilitas, responsif, UI/UX, pengujian, deployment, dan alur kerja, plus [`docs/adr/`](docs/adr/README.md) |

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber otoritatif; Bahasa Indonesia di `<nama>.id.md` adalah cerminnya, dan ia mencatat hash dari bahasa Inggris yang diterjemahkannya. `bun run audit:translation` gagal saat sebuah cermin menjadi basi. Cermin dokumen ini adalah [`README.id.md`](README.id.md).

Kode repo ini sendiri (`packages/gerbang/`, `tools/`, `tests/`) ditulis dalam bahasa Inggris sepenuhnya — identifier, komentar, maupun pesan gerbang. `apps/cms` membawa konvensinya sendiri yang terpisah sebagai kode `ahliweb/awcms` yang disematkan; repo ini tidak mengatur atau mengubahnya.

## Lisensi

[MIT](LICENSE) untuk kode di repo ini. `apps/cms` membawa lisensi dan notice hak cipta `ahliweb/awcms` sendiri sebagai bagian dari riwayat yang disematkan; lihat `LICENSE` workspace itu sendiri.
