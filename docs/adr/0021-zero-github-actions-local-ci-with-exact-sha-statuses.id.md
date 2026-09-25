🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0021-zero-github-actions-local-ci-with-exact-sha-statuses.md)

<!-- i18n-source-hash: sha256:d5e7794ab389b47627e60fa2f154608e8f85fd14d289d8879e89f508c5bb3649 -->

# ADR-0021 — Nol GitHub Actions: CI lokal dengan status komit ber-SHA-eksak

- **Status:** Diterima
- **Tanggal:** 26 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0019](0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md) (gerbang `codeql`/`e2e`/`check-cms` yang permukaan eksekusinya digantikan ADR ini, bukan maksudnya); [ADR-0020](0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) (workflow terpisah, non-wajib, yang tidak disentuh ADR ini); "The gates" milik AGENTS.md (dua belas status check wajib yang direproduksi 1:1 oleh bagian 1 ini); issue [#225](https://github.com/ahliweb/awcms-one/issues/225)

## Konteks

Setiap gerbang yang dijalankan repositori ini hari ini — `Check (toko|berita|landing)`, `check-cms`, keempat leg `template-init-smoke`, ketiga leg `e2e`, dan `Analyze (javascript-typescript)` milik `codeql` — berjalan di runner Actions yang dihosting GitHub, didefinisikan di `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml`. Pemilik memutuskan memindahkan CI workspace ini dari GitHub Actions sepenuhnya: **nol GitHub Actions**, menjalankan pemeriksaan yang sama di infrastruktur yang dikontrol langsung oleh proyek ini.

Dinyatakan jujur, di awal: ini bukan keputusan biaya. Runner Actions yang dihosting GitHub gratis untuk repositori publik — `ahliweb/awcms-one` tidak punya kuota menit yang bisa terlampaui dan tidak ada tagihan yang dikurangi perubahan ini. Alasannya ada di tempat lain: menjalankan CI di infrastruktur yang dikontrol sendiri oleh proyek ini, bukan armada runner terhosting multi-tenant bersama, dan melaporkan hasil dengan presisi yang diberikan SHA komit eksak, bukan mempercayai gagasan sebuah run workflow sendiri tentang "komit mana ini."

Dua hal mengikuti langsung dari "nol Actions", dan ADR ini eksplisit tentang keduanya karena keduanya mudah dijadikan jalan tengah dan tidak satu pun dipilih di sini:

- **Bukan runner Actions self-hosted.** `actions/runner` yang didaftarkan ke repositori ini tetap berbentuk GitHub Actions — workflow yang didefinisikan di `.github/workflows/*.yml`, tunduk pada model trigger Actions sendiri, format log-nya sendiri, semantik required-check-nya sendiri — hanya *komputasi* yang berpindah. "Nol Actions" berarti berkas workflow itu sendiri hilang (PR ini mempertahankannya secara sengaja — lihat "Urutan migrasi" di bawah — tetapi mekanisme yang akan menggantikannya seluruhnya tidak berbentuk Actions sama sekali).
- **Bukan setara GHAS.** Code scanning milik GitHub Advanced Security, siklus hidup alert-nya sendiri (dismiss/reopen, auto-triage), otomasi pembuka-PR Dependabot sendiri, dan push protection secret-scanning adalah permukaan produk GitHub yang tidak direproduksi dan tidak diusahakan ulang oleh perubahan ini. Leg `security` di bawah sengaja dibatasi lingkupnya dan titik butanya dinyatakan, bukan disembunyikan.

## Keputusan

### D1 — `tools/ci/` adalah runner CI lokal/server; dua belas konteks `local-ci/*` (Opsi A)

Sebuah tool Bun/TypeScript baru, `tools/ci/`, mereproduksi persis apa yang dilakukan `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml` hari ini, leg demi leg, sebagai **pemetaan datar 1:1** antara apa yang dulunya status check Actions wajib dan sebuah konteks status komit `local-ci/*` (Opsi A, alternatif yang ditolak di bawah):

| Check wajib sebelumnya | Konteks `local-ci/*` |
| --- | --- |
| `Check (toko)` | `local-ci/check-toko` |
| `Check (berita)` | `local-ci/check-berita` |
| `Check (landing)` | `local-ci/check-landing` |
| `check-cms` | `local-ci/check-cms` |
| `template-init-smoke (toko)` | `local-ci/template-toko` |
| `template-init-smoke (berita)` | `local-ci/template-berita` |
| `template-init-smoke (landing)` | `local-ci/template-landing` |
| `template-init-smoke (root-suite)` | `local-ci/template-root` |
| `e2e (toko)` | `local-ci/e2e-toko` |
| `e2e (berita)` | `local-ci/e2e-berita` |
| `e2e (landing)` | `local-ci/e2e-landing` |
| `Analyze (javascript-typescript)` | `local-ci/security` |

Tabel ini hidup sekali, diekspor dari `tools/ci/legs.ts` (`LEGS`/`LEG_CONTEXTS`), sehingga migrasi branch-protection berikutnya dan dokumentasi repo ini sendiri membaca tabel itu, bukan mengetik ulang dua belas nama di tempat kedua.

### D2 — Pelaporan SHA-eksak: satu worktree sekali pakai per leg, tidak pernah checkout milik developer

`bun run ci` meresolusi komit HEAD checkout saat ini dan, untuk SETIAP leg, membuat **`git worktree` sekali pakainya sendiri** dari SHA eksak tersebut untuk dijalankan di dalamnya — tidak pernah mengubah working tree milik pemanggil, dan tidak pernah membiarkan perubahan satu leg bocor ke leg lain. Ini bukan detail kecil: sebuah run ujung-ke-ujung awal membagi satu worktree di antara kedua belas leg, dan begitu `local-ci/template-root` menjalankan `bun run template:init` sungguhan (yang menulis ulang `package.json`, menghapus fixture seed, dan mengubah merek pohon di tempat, secara sengaja), setiap leg yang berjalan sesudahnya di worktree yang sama itu berjalan terhadap kopi repositori yang sudah diubah-merek dan tidak lagi representatif — `git worktree add` cukup murah (berbagi object store repo ini sendiri) sehingga membayar biayanya sekali per leg bukan biaya nyata dibanding apa yang dilakukan satu leg sendiri. `bun run ci:pr -- <n>` melakukan hal yang sama setelah mengambil `refs/pull/<n>/head` dan meresolusi SHA *itu*. Setiap status komit diposting terhadap SHA tempat kode itu benar-benar berjalan, lewat `POST /repos/{owner}/{repo}/statuses/{sha}` — mekanisme yang sama yang dipakai GitHub App atau integrasi CI pihak ketiga mana pun, dan alasan "Opsi A" (daftar konteks datar) legibel bagi branch protection: UI required-status-check milik GitHub sendiri tidak pernah membedakan job Actions dari poster status API lainnya.

### D3 — Kredensial status

Personal access token fine-grained khusus atau token instalasi GitHub App, terbatas pada `statuses:write` (dan `security-events:write` hanya jika `--upload-sarif` dipakai), adalah kredensial yang direkomendasikan — `LOCAL_CI_GITHUB_TOKEN`. Fallback ke `gh auth token` (sesi CLI `gh` milik operator sendiri yang sudah login) didukung agar run pertama tidak butuh setup terpisah, tetapi ini bukan keadaan mapan yang direkomendasikan: token sesi `gh` pribadi terbatas pada segala yang bisa dilakukan akun itu, lebih luas dari kebutuhan CI lokal. Tidak pernah dicetak — `tools/ci/lib/statuses.ts` dan setiap modul lain di sini hanya menyebut kode status HTTP dan body respons saat gagal, dan helper redaksi bersama (`tools/ci/lib/redact.ts`) menghapus bearer token, password DSN, atau string berbentuk token GitHub apa pun dari setiap berkas log/evidence sebelum ditulis.

### D4 — Kebijakan PR fork: tolak secara default, `--allow-fork` untuk override

`bun run ci:pr` menolak menjalankan kode pull request ketika berasal dari fork, kecuali `--allow-fork` diberikan secara eksplisit. Ini risiko yang sama yang diperingatkan dokumentasi GitHub sendiri untuk runner Actions self-hosted, dinyatakan ulang untuk CI yang berjalan lokal: melakukan checkout dan menjalankan kode PR memberi kode itu shell di infrastruktur yang dikontrol proyek ini, dan PR fork menurut definisi adalah kode dari seseorang tanpa akses tulis. `--allow-fork` ada untuk maintainer yang sudah membaca diff dan menerima risiko untuk satu PR spesifik — tidak pernah menjadi setelan tetap.

### D5 — Pin Bun, ditegakkan fail-closed, bukan lewat langkah `setup-bun`

Actions mem-pin Bun untuk setiap job lewat `bun-version` milik `oven-sh/setup-bun`. CI lokal tidak punya langkah semacam itu — ia berjalan di Bun apa pun yang sudah ada di PATH host — sehingga `tools/ci/lib/bun-pin.ts` membaca pin eksak dari `packageManager` milik root `package.json` dan menolak menjalankan leg apa pun sama sekali ketika Bun yang benar-benar berjalan tidak cocok, dengan pesan yang menyebut kedua versi. Murni dan bebas efek samping menurut konstruksi, sehingga `tests/local-ci-bun-pin.test.mjs` mengujinya dengan string fixture hari ini, dan pembaruan `tests/versi-toolchain.test.mjs` di masa depan bisa mengarah ke fungsi yang sama bukan menduplikasi perbandingannya.

### D6 — Evidence, state, dan retensi hidup di luar repositori

Lock, hasil tercatat per-(repo, PR, SHA head, versi definisi-CI), dan evidence leg (log, SARIF, laporan/screenshot Playwright) hidup di bawah `${XDG_STATE_HOME:-~/.local/state}/awcms-one-ci/` — tidak pernah di dalam repositori, dan tidak pernah di dalam worktree sekali pakai milik leg mana pun (masing-masing dihapus begitu leg itu selesai, kecuali `--keep`). "Versi definisi-CI" adalah hash konten dari `tools/ci/**` ditambah `package.json`/`bun.lock` root — logika sebuah leg sendiri, atau apa yang diinstalnya, berubah membatalkan setiap hasil tercatat sebelumnya untuk sebuah komit, sehingga watcher (D8) tidak pernah mempercayai hasil yang diproduksi di bawah logika berbeda sebagai "sudah diperiksa."

### D7 — Lingkup leg security dan titik buta jujurnya

`local-ci/security` menjalankan CodeQL CLI langsung (`javascript-typescript`, `build-mode: none`, suite query `security-extended`, `.github/codeql/codeql-config.yml` milik repo ini sendiri yang sudah dikomit, dibiarkan tepat di tempatnya), gitleaks (image kontainer **dipin lewat digest**, tidak pernah tag yang bergerak, dikonfigurasi oleh `tools/ci/gitleaks.toml` — mekanisme allowlist native gitleaks sendiri, memperluas bukan menyempitkan rule set default-nya, dipakai untuk mengecualikan permukaan generated/fixture yang ditandai berulang oleh scan nyata repositori ini: fixture tes redaksi milik codebase ini sendiri, output machine-generated `graphify-out`, dump crawl-index legacy yang di-vendor, dan satu baris source benign yang disebut namanya), dan `bun audit`. Ia gagal tertutup pada error analisis/ekstraksi, dan gagal pada hasil SARIF apa pun dengan `security-severity >= 7.0` kecuali pasangan `(ruleId, path)` eksak itu terdaftar di baseline yang dikomit, `tools/ci/security-baseline.json` . Berkas ini disemai, bukan kosong: menjalankan CLI secara lokal sungguhan (langkah verifikasi PR ini sendiri) mereproduksi persis sembilan temuan `>= 7.0` yang sudah dibawa alert code-scanning GitHub #5–#11 milik repositori ini, masing-masing sudah `dismissed` di sana dengan alasan reviewer nyata (`false positive`, `won't fix`, atau `used in tests` — `gh api repos/ahliweb/awcms-one/code-scanning/alerts`). Baseline ini menyatakan ulang sembilan keputusan yang sudah ada itu, mengutip komentar dismissal masing-masing alert, bukan meminta maintainer men-triase ulang temuan yang sudah pernah ditutup repositori ini. Entri kesepuluh ditambahkan hari yang sama lewat proses yang sama untuk `tools/ci/lib/lock.ts` sendiri — `js/file-system-race` pada urutan `existsSync`/`unlinkSync`/`openSync` milik lock watch lintas-run, alasan "perkakas lokal satu-operator, tanpa batas kepercayaan antara pemeriksaan dan penulisan" yang persis sama yang sudah diterima untuk `tools/rilis.mjs`/`tools/knowledge-graph-update.mjs`, di-triase bukan dibisukan karena run nyata pertama leg ini sendiri memunculkannya sebagai temuan sungguhan (meski berbentuk familiar) di kode BARU. Baseline tumbuh lebih jauh hanya dengan cara ini — maintainer secara eksplisit men-triase temuan dan mencatat alasannya diterima, tidak pernah sebagai cara membisukan temuan yang belum pernah dilihat. `--upload-sarif` secara opsional memposting SARIF hasil ke endpoint code-scanning GitHub sendiri agar tab Security tetap berfungsi selama jendela migrasi; pass/fail leg itu sendiri tidak pernah bergantung pada berhasilnya upload itu.

Ini sengaja tidak setara GHAS, dan titik butanya disebut bukan dibiarkan implisit: berkas `.astro` tidak punya extractor CodeQL (batasan yang sama yang sudah dinyatakan `.github/workflows/codeql.yml`); penanganan path-exclusion mentah CLI tidak mereproduksi persis kompilasi filter path-suite-query milik `codeql-action` sendiri atas `paths-ignore` milik `codeql-config.yml`; dan siklus hidup alert tab Security sendiri (state dismiss/reopen) tidak punya ekuivalen lokal — `--upload-sarif` memberi makan permukaan itu tetapi leg ini tidak membacanya balik.

### D8 — `bun run ci:watch`, satu pass polling sekaligus

`bun run ci:watch` mendaftar PR terbuka, melewati yang mana pun (repo, PR, SHA head, versi definisi-CI)-nya sudah punya hasil tercatat (D6), dan menjalankan+melaporkan sisanya — memegang berkas lock O_EXCL selama seluruh pass-nya sehingga dua invokasi tidak pernah tumpang tindih. `tools/ci/systemd/awcms-one-ci-watch.{service,timer}` adalah berkas unit USER (tanpa root) yang dipasang operator secara manual untuk memicu ini setiap 10 menit; perubahan ini mendokumentasikan pemasangannya dan tidak memasangnya sendiri.

## Urutan migrasi

PR ini (#225 bagian 1) sengaja belum lengkap sendirian: `.github/workflows/*.yml` **tidak dihapus** di sini, dan branch protection **tidak disentuh** di sini. Urutannya, secara berurutan:

1. **PR ini** — `tools/ci/` ada, diuji unit, dan sudah dijalankan sungguhan (`bun run ci`) terhadap HEAD repositori ini sendiri, kedua belas leg hijau.
2. **PR susulan menukar branch protection** dari dua belas konteks GitHub Actions ke dua belas konteks `local-ci/*`, hanya setelah `bun run ci:watch` (atau `bun run ci:pr` yang dijalankan manual) memposting status nyata, hijau, terhadap SHA head PR nyata — langkah verifikasi PR ini sendiri melakukan persis itu, sekali, secara manual, sebagai bukti mekanismenya bekerja sebelum apa pun diwajibkan padanya.
3. **Hanya setelah branch protection menunjuk ke `local-ci/*`** sebuah PR berikutnya menghapus `.github/workflows/{ci,template-init-smoke,e2e,codeql}.yml` — menghapusnya lebih awal akan meninggalkan `main` tanpa check wajib yang menjawab selagi mekanisme baru masih dibuktikan.

`.github/workflows/images.yml` dan `release.yml` di luar lingkup migrasi ini; keduanya bukan status check wajib dan ADR ini tidak menyentuhnya.

## Konsekuensi

- CI kini berjalan di infrastruktur yang dikontrol proyek ini ujung ke ujung, dengan hasil yang bisa ditelusuri ke SHA komit eksak, bukan pembukuan sebuah run workflow sendiri.
- Kontributor tanpa akses ke host mana pun yang menjalankan `ci:watch` tidak bisa mendapat hasil `local-ci/*` di PR-nya sendiri tanpa maintainer (atau override `--allow-fork`) menjalankannya untuk mereka — ini biaya langsung dari kebijakan fork D4, diterima secara sengaja.
- Titik buta leg security (D7) nyata dan terdokumentasi, bukan kebetulan; iterasi mendatang bisa menutup celah path-exclusion tanpa meninjau ulang keputusan lain ADR ini.
- Evidence setiap leg hidup di luar repositori (D6), sehingga maintainer yang men-debug hasil `local-ci/*` merah butuh akses ke host yang menjalankannya, atau ke worktree yang dihasilkan `--keep`/`--report`, bukan URL log GitHub Actions yang bisa dibuka siapa pun berakses baca.
- Sampai langkah 2 urutan migrasi mendarat, `.github/workflows/*.yml` dan leg `tools/ci/` berjalan paralel, memeriksa komit yang sama dua kali — diterima sebagai biaya membuktikan penggantinya sebelum apa pun bergantung padanya secara eksklusif.

## Alternatif yang ditolak

- **Runner GitHub Actions self-hosted.** Tetap berbentuk Actions ujung ke ujung (berkas workflow, model trigger/log/required-check Actions sendiri) — hanya komputasi yang berpindah dari armada GitHub. Ditolak karena keputusan pemilik adalah "nol Actions," bukan "Actions lebih murah," dan repositori publik sudah menjalankan Actions terhosting GitHub gratis, sehingga runner self-hosted akan menambah permukaan operasional (mesin yang harus di-patch, diamankan, dan dijaga online) tanpa manfaat biaya dan tanpa kontrol yang justru diminta motivasi sebenarnya ADR ini.
- **Opsi B — satu konteks status agregat `local-ci`**, bukan dua belas. Ditolak: branch protection (dan manusia yang melihat sekilas PR) akan kehilangan visibilitas per-leg — konteks agregat merah menjawab "sesuatu gagal" tapi bukan yang mana dari dua belas check yang sangat berbeda (error tipe vs. screenshot e2e flaky vs. temuan CodeQL) tanpa membuka evidence yang harus diambil manusia dari direktori state dulu. Pemetaan datar per-leg (D1) tidak menambah biaya pelaporan dan mempertahankan ergonomi debugging yang sama seperti `Check (toko)` vs. `Check (berita)` yang dulu memberikannya sebagai dua job Actions terpisah.
- **Hanya Semgrep untuk leg security**, menggantikan CodeQL. Ditolak untuk perubahan ini: ruleset komunitas Semgrep tidak mencakup analisis dataflow taint-tracking yang sama yang sudah dibuktikan berguna suite `security-extended` CodeQL untuk repositori ini (bagian "CodeQL triage" milik SECURITY.md mendokumentasikan temuan nyata yang tertangkap olehnya), dan menukar analyzer yang mendasarinya secara diam-diam akan mengubah arti "security-severity >= 7.0" sendiri terhadap proses baseline yang sudah ada — keputusan yang tidak seharusnya dibuat perubahan migrasi ini sebagai efek samping dari memindahkan tempat CI berjalan.
