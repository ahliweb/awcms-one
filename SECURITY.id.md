🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SECURITY.md)

<!-- i18n-source-hash: sha256:53b2c5aa90e1f0537726cecb78afbb26b3a283f3c6de54fe0a69aa10646a0f66 -->

# Kebijakan Keamanan

## Melaporkan kerentanan

**Jangan buka issue publik untuk kerentanan yang bisa dieksploitasi.**

Laporkan lewat [GitHub Security Advisory](https://github.com/ahliweb/awcms-one/security/advisories/new) (jalur privat). Sertakan langkah reproduksi, perkiraan dampak, dan commit yang Anda uji.

Kami menargetkan respons awal dalam **3 hari kerja** dan perbaikan untuk kerentanan yang terkonfirmasi dalam **14 hari kerja**, tergantung tingkat keparahannya.

## Tiga permukaan, dilaporkan dengan cara sama tetapi dimiliki berbeda

Repo ini adalah monorepo, dan hari ini ia memuat tiga permukaan serangan sungguhan beserta perkakas di sekitarnya:

- **`apps/cms`** — `ahliweb/awcms`, disematkan utuh lewat `git subtree`. Ia adalah system of record platform ini: basis data, autentikasi, otorisasi (RBAC/ABAC), dan setiap modul yang menyimpan data komersial. Kerentanan yang ditemukan di kodenya, sebagaimana berada di repositori ini, dilaporkan di sini (GitHub Security Advisory pada `ahliweb/awcms-one`), karena di situlah kode yang terdampak sebenarnya berjalan. [`apps/cms/SECURITY.md`](apps/cms/SECURITY.md) (dibawa dari upstream) mendokumentasikan rincian permukaan itu lebih dalam. Bila cacat yang sama belum diperbaiki di `ahliweb/awcms` versi terkini, laporkan juga di sana, karena deployment lain proyek itu ikut memilikinya — salinan repo ini tetap diperbaiki di sini, mengikuti subtree pull yang dijelaskan di [`AGENTS.md`](AGENTS.md#the-subtree-embed).
- **Permukaan commerce anonim milik `apps/storefront`** — sejak increment 2, browser pembeli memanggil endpoint `/api/v1/commerce/storefront/*` anonim dan lintas-origin milik `apps/cms` langsung, untuk kutipan keranjang, pembuatan pesanan, pelacakan pesanan, konfirmasi pembayaran, pembatalan, dan ulasan. Lihat "Permukaan anonim storefront" di bawah untuk perlindungan yang berlaku. Kode ini hidup di `apps/cms` (endpoint itu sendiri) dan `apps/storefront` (klien yang memanggilnya); kerentanan di salah satunya dilaporkan di sini.
- **Akar workspace** (`packages/gerbang/`, `tools/`, `tests/`) — perkakas build dan rilis, bukan layanan yang berjalan. Ia tidak punya listener jaringan, tidak punya koneksi basis data, dan tidak punya permukaan yang dihadapkan ke pengguna sama sekali; satu-satunya interaksi eksternalnya adalah memanggil `git` sebagai argv array (tidak pernah lewat shell — lihat `packages/gerbang/lib/git.mjs`). Kelas kerentanan di sini berbentuk skrip yang bisa dipaksa menulis di luar repo, atau yang akan mengeksekusi sesuatu yang dikendalikan penyerang (nama branch berbahaya, nama berkas changeset berbahaya) — laporkan dengan cara yang sama, di sini.

Container *yang dilayani* `apps/storefront` — semua kecuali permukaan commerce anonim di atas — tetap seperti yang dideskripsikan [ADR-0002](docs/adr/0002-static-output-with-build-time-fetch-for-the-storefront.id.md): server berkas statis tanpa koneksi basis data dan tanpa kredensial `apps/cms` jenis apa pun, sehingga kompromi container itu sendiri tidak menjangkau data pelanggan — lihat [`docs/arsitektur.md`](docs/arsitektur.id.md).

## Permukaan anonim storefront: apa yang melindunginya

[ADR-0007](docs/adr/0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md) adalah keputusan desainnya; bagian ini adalah daftar kontrolnya, untuk pembaca keamanan yang mau itu tanpa membaca argumen trade-off ADR itu sendiri:

- **Resolusi tenant terikat-Origin, bukan header yang dikendalikan pemanggil.** Tenant setiap request di-resolve dari `Origin`/`Host`-nya terhadap `awcms_tenant_domains` — origin yang tak terdaftar mendapat penolakan netral yang sama seperti pesanan yang tak dikenal. Tanpa cookie, tanpa bearer token, sama sekali (`mode: "cors"` / `credentials: "omit"` di setiap panggilan klien).
- **Rate limit** per IP di setiap rute, dan per nomor telepon ternormalisasi tambahan pada pembuatan pesanan.
- **Respons netral di mana pun respons yang membedakan akan bocor.** `GET .../orders/{code}?phone=` menjawab `404` yang byte-identik untuk kode pesanan tak dikenal, kode benar dengan telepon salah, dan pesanan milik tenant lain — tidak pernah tiga respons berbeda yang bisa dipakai penyerang untuk mengenumerasi kode pesanan atau nomor telepon yang valid.
- **Idempotensi pada pembuatan pesanan**, lewat store `awcms_idempotency_keys` bersama — klik "buat pesanan" yang di-double-submit tidak bisa membuat dua pesanan.
- **Tidak ada jalur tulis untuk uang yang tidak ditinjau seseorang.** Konfirmasi pembayaran memindahkan `paymentStatus` sebuah pesanan hanya setelah keputusan eksplisit `accepted`/`rejected` seorang admin; tidak ada jalur penerimaan otomatis di increment ini (lihat [ADR-0010](docs/adr/0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.id.md)).
- **CSP yang diturunkan**: `connect-src` hanya menyebut `PUBLIC_AWCMS_ORIGIN`, divalidasi ulang `apps/storefront/server/penyaji.mjs` di setiap startup server secara independen dari build yang menghasilkannya, jatuh ke baseline `'self'`-saja pada artefak yang hilang atau salah bentuk — lihat [`docs/arsitektur.md`](docs/arsitektur.id.md).
- **Tidak ada PII yang disimpan storefront itu sendiri.** Sebuah pesanan, nomor telepon, instruksi pembayaran semuanya melintas browser ↔ CMS langsung; container storefront tidak pernah melihat satu pun darinya dan tidak bisa mencatat apa yang tidak pernah diterimanya.
- **Kredensial mesin milik `apps/cms` tetap read-only secara konstruksi** — `AWCMS_API_TOKEN` saat build tidak bisa membuat pesanan bahkan jika bocor; setiap pembacaan commerce yang dicakupnya, menurut definisi, tidak destruktif.

## Kontrol yang berlaku hari ini

- **Tidak ada rahasia, token, atau kredensial** di kode, commit, issue, atau dokumentasi.
- **`bun audit` harus melaporkan nol kerentanan** sebelum rilis (`tools/rilis.mjs` menjalankannya sebelum menerapkan); `bun audit --audit-level=low` juga berjalan di setiap push CI.
- **GitHub Actions dipin ke SHA commit**, bukan tag — lihat bagian "Configuration and toolchain" di `AGENTS.md`.
- **PR `git subtree pull` di-merge dengan merge commit, tidak pernah di-squash atau di-rebase** — bukan kontrol keamanan terhadap penyerang eksternal, melainkan kontrol terhadap rusaknya kemampuan repo ini sendiri untuk menarik patch keamanan upstream ke `apps/cms` di masa depan. Lihat "The subtree embed" di `AGENTS.md`.
- **RLS `ENABLE`+`FORCE` di setiap tabel ber-scope-tenant**, termasuk kedelapan belas tabel commerce yang ditambah increment 2 — lihat [`docs/skema-basis-data.md`](docs/skema-basis-data.id.md).

## Yang BELUM benar, dinyatakan terus terang

**Belum ada deployment produksi platform ini yang hidup.** `postgres:18.4` milik `compose.yaml` hanya kemudahan lokal/CI — lihat [`docs/deployment.md`](docs/deployment.id.md) untuk persisnya apa yang tersedia dan tidak. Tidak ada sistem yang berjalan di `mart.borneojek.com` untuk diekspos kode repo ini sendiri. Akun pelanggan belum ada ([issue #32](https://github.com/ahliweb/awcms-one/issues/32)) — setiap penulisan commerce hari ini adalah entah aksi owner/admin terautentikasi di dalam `apps/cms`, atau permukaan checkout-tamu anonim yang dideskripsikan di atas; belum ada permukaan serangan sesi/login.

## Bukan kerentanan keamanan

Yang berikut penting, tetapi bukan laporan keamanan — gunakan issue biasa, atau jalur di [`SUPPORT.md`](SUPPORT.md):

- Cacat di `apps/cms` yang murni perilaku generik `ahliweb/awcms` sendiri, tidak berkaitan dengan pekerjaan komersial platform ini.
- Fitur yang hilang, atau celah antara skema sumber borneojek-mart dan apa yang sudah mendarat di sini sejauh ini — lihat [issue #21](https://github.com/ahliweb/awcms-one/issues/21) untuk apa yang masuk cakupan increment saat ini.
