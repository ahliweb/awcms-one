🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md)

<!-- i18n-source-hash: sha256:9c178a37b9fde86ddb913965d7180f58a4b499b0a319d842866615dc15340b5b -->

# ADR-0019 — Topologi produksi: dua image, satu sidecar jobs, dan preflight fail-closed

- **Status:** Diterima
- **Tanggal:** 21 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) (output statis — kenapa image storefront bukan server), [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) (kenapa browser pembeli memanggil `apps/cms` langsung, tidak pernah lewat backend storefront), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) (OTP pelanggan — kanal pengiriman yang harus dipastikan siap-produksi oleh preflight ini), [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (port provider — Midtrans/RajaOngkir/WhatsApp — yang divalidasi preflight ini), [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) (`SITE_PROFILE` — sakelar waktu-build yang membuat setiap image storefront dibangun sekali untuknya); issue [#150](https://github.com/ahliweb/awcms-one/issues/150)

## Konteks

`docs/deployment.md` menyatakan, sebelum perubahan ini, bahwa deployment produksi platform ini belum ada dan `compose.yaml` hanya kemudahan lokal/CI. Itu deskripsi yang akurat sepanjang increment 6: lima increment membangun keluasan commerce/berita/akun-pelanggan/integrasi/template, dan sebuah PostgreSQL nyata untuk dev lokal dan CI (issue #25), tapi belum ada yang menyatakan bagaimana `apps/cms`, `apps/storefront`, PostgreSQL, dan job commerce/AWCMS latar belakang benar-benar berjalan bersama, sebagai identitas basis data yang mana, di balik rahasia yang mana, diperiksa gerbang yang mana — celah pengiriman yang disebutkan langsung oleh issue #150.

Tiga pertanyaan harus diputuskan bersama, karena masing-masing membatasi yang lain: (1) apa yang berjalan di mana — apakah storefront tetap build statis, atau tekanan deployment memaksanya jadi server dinamis; (2) identitas basis data mana yang dipakai setiap bagian yang bergerak untuk terhubung, dan bagaimana migrasi dipisah dari runtime; (3) bagaimana konfigurasi produksi yang buruk ditangkap sebelum mencapai pembeli, bukan sesudahnya.

## Keputusan

### D1 — `apps/cms` adalah system of record; `apps/storefront` tetap build statis dengan server kecilnya sendiri, tidak pernah jadi backend dinamis

Produksi tidak mengubah arsitektur yang sudah ditetapkan ADR-0002/ADR-0007: `apps/storefront` dibangun sekali per `SITE_PROFILE` (ADR-0018) menjadi artefak statis, dan `apps/storefront/server/penyaji.mjs` (sudah ada, dibundel oleh skrip `build` aplikasi sendiri) menyajikan artefak itu saja — ia tidak pernah mendapat kredensial runtime, tidak pernah mem-proxy ke `apps/cms`, dan tidak pernah fetch ulang konten setelah build selesai. Semua state, semua penulisan, dan setiap panggilan storefront anonim (keranjang, checkout, OTP, pelacakan pesanan) berjalan langsung dari browser pembeli ke permukaan anonim `apps/cms` sendiri (`/api/v1/commerce/storefront/*`), persis seperti yang sudah diputuskan ADR-0007. Tekanan deployment produksi adalah alasan ADR ini ada; itu sengaja bukan alasan untuk membuka ulang ADR-0002/ADR-0007 — melakukannya berarti menukar topologi statis yang terbukti murah untuk diskalakan dengan topologi dinamis demi menutup celah dokumentasi, bukan celah arsitektur.

### D2 — Dua image waktu-build, satu peran basis data runtime masing-masing, dan identitas pemilik migrasi yang terpisah

Tiga identitas basis data, tidak pernah dicampur:

- **`awcms_setup`** (atau superuser Postgres) — koneksi pemilik migrasi. Dipakai hanya oleh satu langkah/servis `migrate` sekali-jalan, tidak pernah oleh apa pun yang dibiarkan tetap berjalan.
- **`awcms_app`** — peran runtime `apps/cms` sendiri (sudah dibuat migrasi upstream `sql/019_awcms_db_role_separation.sql`). `DATABASE_URL` servis `cms` harus mengarah ke peran ini.
- **`awcms_worker`** — peran job latar belakang (`sql/022`). `DATABASE_URL` sidecar `jobs` harus mengarah ke peran ini.

`compose.production.yaml` menyandikan ini sebagai tiga servis yang membaca tiga variabel sumber berbeda (`SETUP_DATABASE_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL`) alih-alih satu `DATABASE_URL` bersama yang dipakai ulang dengan maksud berbeda — variabel bersama persis bentuk yang membuat operator bisa menempel DSN pemilik di mana-mana "agar berfungsi" dan tidak pernah menyadarinya. `apps/cms/Dockerfile.production` sudah membangun target `runtime` (hanya `dist/`, tanpa scripts, tanpa tooling berkapasitas superuser) dan target `jobs` (source penuh, sehingga 30+ skrip job yang dibawanya benar-benar bisa berjalan) — ADR ini memakai ulang keduanya, tanpa perubahan, alih-alih membuat image ketiga; `apps/cms` adalah subtree upstream dan aturan repo ini sendiri di dalamnya adalah aditif-saja (AGENTS.md).

Peran superuser/pemilik tidak pernah menjadi identitas runtime untuk `cms` atau `jobs` — ditegakkan secara mekanis oleh preflight D5, bukan hanya didokumentasikan.

### D3 — Job terjadwal berjalan dari crontab yang digenerate, tidak pernah daftar yang disalin tangan, termasuk di bawah docker-compose

`apps/cms/scripts/jobs-crontab.ts` (upstream, `bun run jobs:crontab:generate`/`:check`) sudah menggenerate `apps/cms/ops/awcms-jobs.crontab` dari registry job modul — satu-satunya sumber kebenaran tentang job mana yang ada dan kapan berjalan. Desain file itu sendiri adalah cron host yang memanggil `apps/cms/ops/run-job.sh <target>`, yang pada gilirannya menjalankan image `awcms-jobs` yang dipublikasikan lewat `docker run` biasa. Deployment berbasis docker-compose tidak butuh daftar cron kedua yang dirawat tangan untuk mendapat jaminan yang sama: `ops/run-job-compose.sh` (skrip baru milik repo ini sendiri, di root) adalah pengganti langsung `run-job.sh` dengan signature `<target> [args...]` yang identik, memanggil `docker compose -f compose.production.yaml --profile jobs run --rm jobs bun run <target>` alih-alih `docker run` biasa. Operator mengarahkan variabel `AWCMS_RUN_JOB` pada crontab yang SAMA yang sudah digenerate ke skrip ini alih-alih `apps/cms/ops/run-job.sh` — jadwalnya sendiri tetap digenerate dari registry modul, dan `jobs:crontab:check` tetap menangkap penyimpangan, karena tidak ada yang berubah soal JOB MANA yang ada atau KAPAN ia berjalan; yang berubah hanya KONTAINER MANA yang menjalankannya.

Ditolak: daemon cron yang dipanggang ke dalam image `jobs` (akan mengharuskan mengubah `apps/cms/Dockerfile.production`, upstream, dilarang oleh aturan subtree repo ini) dan sidecar scheduler pihak ketiga berbasis label (mis. Ofelia) dengan jadwal diduplikasi ke label compose (memunculkan kembali persis risiko penyimpangan daftar-cron-salinan-tangan yang ingin ditutup D3, di lokasi baru).

### D4 — `AWCMS_API_TOKEN` mencapai build storefront hanya lewat build secret BuildKit, tidak pernah ARG/ENV

Build `apps/storefront` butuh token API pemilik milik `apps/cms` untuk mengambil konten katalog/berita saat waktu build (ADR-0002), tapi kredensial itu tidak boleh pernah masuk ke layer yang dibangun, `docker history`, atau artefak yang disajikan. Satu-satunya `RUN` di `apps/storefront/Dockerfile` yang menjalankan `bun run build` membaca token dari file `--mount=type=secret,id=awcms_api_token`, mengekspornya hanya ke environment shell RUN itu sendiri — ia tidak pernah ditetapkan ke `ARG` atau `ENV` Dockerfile, sehingga tidak bisa muncul di metadata layer mana pun bahkan secara tidak sengaja. `compose.production.yaml` mengambil secret dari file lokal yang di-gitignore (`.secrets/awcms_api_token` secara default); `tools/deploy-preflight.mjs --dist` tambahan men-grep `dist/` yang sudah dibangun untuk nilai literal token sebagai pemeriksaan kedua yang independen.

### D5 — Preflight fail-closed dan berlapis: pemeriksaan spesifik-commerce `apps/cms` sendiri, lalu pemeriksaan bentuk storefront di root

Dua perintah baru, tidak menggantikan `bun run config:validate`/`bun run security:readiness` (upstream, tidak diubah) yang sudah ada di `apps/cms`, tapi berdampingan dengannya:

- `apps/cms/scripts/commerce-deploy-preflight.ts` (`bun run commerce:deploy:preflight`, tooling modul commerce yang aditif) memeriksa invarian produksi yang spesifik untuk topologi platform ini: peran DB runtime bukan pemilik/superuser (bentuk DSN selalu; `--live` tambahan terhubung dan memverifikasi `rolsuper`/`rolbypassrls`/kepemilikan tabel/RLS `ENABLE+FORCE`/kekinian buku besar migrasi), pengiriman OTP pelanggan siap-produksi (e-mail selalu wajib — modul ini tidak punya sakelar "akun pelanggan dinonaktifkan"; WhatsApp hanya ketika `COMMERCE_WHATSAPP_ENABLED=true`), gateway pembayaran dan provider tarif pengiriman bukan adapter `log` di produksi dan kredensial adapter nyatanya hadir, dan URL publik kanonik adalah `https://` yang valid. Ia mendelegasikan ke `apps/cms/scripts/validate-env.ts` upstream sendiri dan ke `jobs:crontab:check`/`jobs:env-allowlist:check` dengan men-spawn-nya (larik argv, tidak pernah string shell) alih-alih menerapkan ulang salah satunya.
- `tools/deploy-preflight.mjs` (`bun run deploy:preflight`, milik root, agnostik-workspace) memeriksa bentuk env build storefront sendiri — `SITE_PROFILE` yang valid, origin kanonik https, `AWCMS_API_TOKEN` hadir dan tidak pernah berawalan `PUBLIC_`, tidak ada variabel `PUBLIC_*` yang nilainya terlihat seperti kredensial — lalu men-spawn preflight `apps/cms` dan melipat kode keluarnya, sehingga satu perintah menjawab kesiapan seluruh platform.

Setiap pemeriksaan mencetak persis satu baris `PASS|FAIL|SKIP` dengan alasan dan tidak pernah nilai rahasia; `SKIP` (tanpa `--live`, tanpa basis data yang terjangkau) tidak pernah dihitung sebagai lulus. Kedua skrip keluar dengan kode bukan-nol begitu ada pemeriksaan yang `FAIL`.

### D6 — Setiap provider eksternal tetap di sisi server; adapter `log`/dev tidak pernah bisa diam-diam menjadi default produksi

Konsisten dengan bentuk port/adapter [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md): tidak ada kredensial pembayaran, pengiriman, atau WhatsApp yang pernah dibaca `apps/storefront` atau dikirim ke browser — setiap satunya adalah variabel environment khusus `apps/cms`, divalidasi preflight D5, tidak pernah menjadi build ARG storefront. Adapter `log` (aman untuk lokal/dev, tidak melakukan panggilan jaringan) adalah pilihan yang valid untuk **non-produksi** pada pembayaran/pengiriman, dan preflight menolaknya begitu `APP_ENV=production` (atau `--production`) ditegaskan, sehingga deployment tidak bisa melenceng dari "log" menjadi "dipercaya live" tanpa tertangkap preflight lebih dulu.

### D7 — Apa yang masih di luar cakupan

ADR ini tidak membangun: enkripsi backup saat-diam (dilacak upstream, sesuai header `apps/cms/ops/backup-awcms.sh` sendiri — "Do NOT set `BACKUP_ENCRYPTION_KEY_FILE`"), adapter pembayaran Xendit atau pelacakan kurir (keduanya disebut sebagai tindak lanjut eksplisit ADR-0017, masih belum dibangun), pipeline CI yang membangun dan mempublikasikan image per-profil `apps/storefront` ke registry (ADR ini mendokumentasikan `docker build`, bukan pipeline rilis), dan konfigurasi reverse-proxy/terminasi-TLS di luar contoh di `docs/deployment.md` — ingress operator sendiri (nginx, Traefik, load balancer terkelola) yang menerminasi TLS dan meneruskan ke port kontainer `cms`/`storefront` yang tidak dipublikasikan.

## Konsekuensi

- Deployment produksi punya satu jalur terdokumentasi dan teruji (bagian "Production runbook" di `docs/deployment.md`) alih-alih tidak ada; `compose.production.yaml` dan pengujiannya sendiri (`tests/compose-produksi.test.mjs`) membuat model basis data dua-peran dan aturan tanpa-rahasia-ter-commit diperiksa secara mekanis, bukan hanya dituliskan.
- `apps/cms/Dockerfile.production` dan `apps/cms/ops/run-job.sh`/`awcms-jobs.crontab` tidak butuh perubahan — D2/D3 ADR ini sendiri terpenuhi seluruhnya lewat tooling aditif (`commerce-deploy-preflight.ts`, `ops/run-job-compose.sh`), yang juga menjadi bukti aturan subtree aditif-saja tidak perlu dilanggar untuk mencapai topologi produksi yang nyata.
- Provider masa depan (Xendit, adapter WhatsApp kedua) atau job masa depan memperluas preflight yang sama dan crontab yang digenerate sama tanpa mekanisme baru — D5/D3 sudah agnostik terhadap jumlah provider/job.
- Satu biaya operasional yang diterima ADR ini secara sengaja: `ops/run-job-compose.sh` adalah entrypoint kedua berdampingan dengan `apps/cms/ops/run-job.sh` milik upstream sendiri, dan operator yang mencampur keduanya (sebagian job lewat `docker run` biasa, sebagian lewat compose) secara prinsip bisa menjalankan dua image berbeda untuk job yang sama. Runbook `docs/deployment.md` menyatakan dengan jelas bahwa deployment berbasis compose memakai `run-job-compose.sh` untuk setiap job, tidak pernah campuran.
