🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0020-omes-control-center-is-an-isolated-module-over-pinned-contracts-and-a-pull-worker-transport.md)

<!-- i18n-source-hash: sha256:c7274e93945b793a8f1ab0228908eb39e023486b3abf0b13e031b3e372f00e56 -->

# ADR-0020 — OMES Control Center adalah modul terisolasi, di atas kontrak yang dipin dan transport pull-worker

- **Status:** Diterima
- **Tanggal:** 21 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) (preseden satu-modul-per-domain yang tidak diganggu ADR ini — `commerce` tetap hanya untuk commerce), [ADR-0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) (konvensi rentang migrasi yang diperluas ADR ini ke modul kedua), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) dan [ADR-0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) (primitif outbox/port/idempotensi/audit yang dipakai ulang ADR ini, bukan ditemukan lagi); disiplin admisi modul milik `apps/cms` sendiri (`apps/cms/AGENTS.md`); issue [#146](https://github.com/ahliweb/awcms-one/issues/146) (epic: OMES Control Center), issue [#151](https://github.com/ahliweb/awcms-one/issues/151) (ADR ini), issue [#150](https://github.com/ahliweb/awcms-one/issues/150) (topologi produksi — ADR saudara, bukan ADR ini); `AGENTS.md`, *docs/control-center-foundation.md*, *docs/control-center-contracts.md*, *docs/jobs.md*, `contracts/README.md`, dan `contracts/control-center/v1/**` milik upstream `ahliweb/omes`; `ahliweb/omes#192` (issue transport pendamping, masih terbuka saat ADR ini ditulis)

## Konteks

Epic #146 meminta awcms-one menjadi GUI web dan bidang kendali (control plane) untuk host yang dikelola OMES, tanpa memindahkan eksekusi host, semantik runtime Hermes, atau akses shell sembarangan ke dalam CMS ini. OMES sendiri sudah menjawab separuh pertanyaan ini dari sisinya: *docs/control-center-contracts.md* milik `ahliweb/omes` sudah menetapkan matriks kepemilikan dan kontrak kabel (wire contract) berversi (`contracts/control-center/v1/**`) persis untuk batas ini, dan *docs/jobs.md* menetapkan bentuk mesin-status/job yang dideskripsikan kontrak-kontrak itu. Yang secara eksplisit masih dibiarkan terbuka oleh dokumen-dokumen OMES sendiri, dengan kata-katanya sendiri, adalah segala sesuatu di sisi repositori ini dari garis batas itu: GUI web, tabel tenant/RBAC/ABAC/RLS, primitif persetujuan-alur-kerja dan audit, dan — satu bagian yang benar-benar belum diputuskan di mana pun — transport yang dipakai bidang kendali berhadapan-browser untuk menjangkau armada host yang tidak boleh pernah ia panggil langsung.

ADR ini adalah wave 0 dari epic #146: mencatat batas kepercayaan dan kepemilikan, mem-pin kontrak yang menjadi dasar pembangunan repositori ini, membekukan bentuk modul yang menjadi acuan kode setiap issue turunan (#152–#158), dan menyatakan dengan jelas bahwa transport-nya sendiri belum bisa dibangun — `ahliweb/omes#192`, issue yang akan mendefinisikan protokol pull-worker sisi OMES, masih **terbuka**. Tidak ada apa pun di sini yang merupakan kode berjalan; #152 menambahkan baris pertama modul `omes_control` itu sendiri.

Dua ADR yang berkaitan sedang berjalan bersamaan dan sengaja dijaga terpisah: ADR ini (#151) menetapkan admisi — kepemilikan, kontrak, bentuk transport, batas modul, kapabilitas hanya-dari-bukti, keselarasan standar, non-tujuan. ADR saudara (issue #150, ditulis bersamaan, diperkirakan bernomor `docs/adr/0019-*.md` begitu digabungkan) menetapkan topologi produksi deployment ini sendiri untuk menjalankan bidang kendali yang menghadap OMES sama sekali. Di titik yang berpotensi tumpang tindih, ADR ini mengalah pada apa pun yang diputuskan ADR milik issue #150 soal topologi dan mengutipnya begitu ADR itu ada di `main`; ADR ini sendiri tidak memutuskan topologi.

## Keputusan

### D1 — Matriks kepemilikan: direproduksi verbatim dari batas milik `ahliweb/omes` sendiri, per entitas

*docs/control-center-contracts.md* §1 milik `ahliweb/omes` sudah menjawab "siapa memiliki apa" cukup presisi sehingga menurunkannya ulang di sini hanya akan berisiko membuat salinan kedua yang bisa melenceng. ADR ini mengadopsinya verbatim, per entitas:

| Entitas / status | AWCMS-one (Control Center) | OMES | Hermes |
| --- | --- | --- | --- |
| Tenant, user, izin (RBAC/ABAC) | **memiliki** | membaca identitas tenant/aktor hanya pada request masuk | tidak tahu apa-apa |
| Inventaris server/deployment (host mana ada, tenant mana memilikinya) | menyimpan salinan untuk UI/billing, direkonsiliasi dari OMES | **memiliki kebenaran yang hidup** (`omes status`, state file) | tidak tahu apa-apa |
| Bukti preflight/kompatibilitas host | menampilkannya | **memiliki** (`omes check`) | tidak tahu apa-apa |
| Eksekusi install/configure/start/stop/restart/update | memintanya lewat job | **memiliki** (mengeksekusi; satu-satunya pihak yang menjalankan perintah host) | hanya konfigurasi khusus Hermes, diterapkan oleh OMES |
| Antrean job, mesin status, log audit | membaca status job lewat API | **memiliki** (`lib/omes/py/jobs/`) | tidak tahu apa-apa |
| Backup/restore/rollback | meminta dan menampilkan status | **memiliki** (`omes backup`/`restore`) | tidak tahu apa-apa |
| Bukti health/readiness | menampilkannya | **memiliki** (memakai ulang `lib/omes/py/health/model.py`) | Hermes melaporkan sinyal runtime-nya sendiri yang dibaca lapisan health OMES, tidak pernah sebaliknya |
| Penalaran agent, sesi, memori, skill, channel, perutean model/provider | tidak tahu apa-apa | tidak tahu apa-apa (tidak pernah mengimplementasi ulang ini) | **memiliki** |
| Persetujuan untuk operasi destruktif | mencatat keputusan persetujuan dan aktornya | menegakkan gerbang persetujuan sebelum mengeksekusi | tidak tahu apa-apa |
| Rahasia (token, password, kredensial) | tidak pernah menyimpan nilai mentah; hanya menyimpan pointer `secret_ref` | me-resolve `secret_ref` secara lokal; tidak pernah mengembalikan nilai mentah | me-resolve rahasianya sendiri dari `.env` miliknya sendiri, tidak berkaitan dengan rahasia Control Center |

**Control Center hanya menyimpan status desired/observed/proyeksi dan bukti rekonsiliasi.** Ia tidak pernah menyimpan kunci SSH mentah, token API provider, kredensial Hermes, perintah shell, atau isi filesystem host — aturan yang sama yang ditegakkan kontrak OMES sendiri di level skema (§D2 di bawah) dan ditegakkan tabel `omes_control` milik repositori ini sebagai pengaman kedua yang independen, dengan tidak pernah mendefinisikan kolom berbentuk untuk menampungnya.

Setiap layar operasional yang disebutkan epic #146 (Overview, Servers, Deployments, Operations, Jobs, Health & readiness, Backups/recovery, Audit, Orchestration visibility) adalah model baca atau formulir pengajuan-request di atas matriks ini — tak satu pun mengharuskan repositori ini tahu apa pun yang sudah dimiliki OMES atau Hermes di atas.

### D2 — Pin kontrak: `contracts/control-center/v1/**` divendor pada commit bernama, divalidasi fail-closed, versi tak dikenal ditolak

`contracts/control-center/v1/**` milik `ahliweb/omes` divendor ke `apps/cms/src/modules/omes-control/contracts/v1/` pada commit **`e4e94ea92067df91b04b08d987a106c8ee977e79`** (`main` milik `ahliweb/omes`, 21 September 2026) — disiplin "salin pada commit bernama, vendor ulang secara sengaja" yang sama yang sudah dipakai repositori ini untuk `apps/cms` sendiri (ADR-0001), diperkecil skalanya dari sebuah pohon (tree) menjadi sebuah direktori karena aturan kompatibilitas OMES sendiri (`contracts/README.md`: "sebuah direktori `v<major>`, begitu dirujuk oleh PR yang sudah digabungkan di luar repositori ini, tidak pernah diganti nama atau dihapus; hanya perubahan aditif yang masuk ke dalamnya") sudah memberi salinan yang divendor stabilitas yang sama seperti subtree memberi stabilitas ke `apps/cms`.

Setiap kontrak yang dikonsumsi adapter sisi server repositori ini adalah anggota kumpulan itu: `server-registration.request/response`, `preflight.request/response`, `deployment.request`, `deployment-view`, `operation-request`, `job-status.response`, `health-readiness.response`, `backup-status.response`, `rollback.request`, dan `entitlement.schema.json` (dikonsumsi hanya-baca, lihat di bawah). Direktori `v1` yang sama juga membawa keluarga kontrak catalog/subscription/invoice/payment-gateway/webhook (issue #92–#95 milik upstream) untuk permukaan billing SaaS OMES sendiri; tidak ada apa pun dalam cakupan epic #146 yang membaca atau menulis itu, dan tidak ada issue turunan #151–#158 yang berwenang mulai mengonsumsinya tanpa ADR baru — vendor seluruh direktori adalah kemudahan kompatibilitas (satu commit, satu salinan), bukan lisensi untuk memperbesar permukaan modul ini secara diam-diam.

Validasi bersifat **fail-closed**, mengikuti persis subset validator `contracts/README.md` sendiri alih-alih memakai pustaka JSON Schema umum yang tidak menjadi dependensi repositori ini:

- kumpulan keyword yang didukung adalah `type, required, properties, additionalProperties, enum, const, pattern, minimum, maximum, minLength, maxLength, minItems, maxItems, items, oneOf, anyOf` ditambah anotasi yang diizinkan `$schema, $id, title, description`;
- keyword apa pun di luar itu (`$ref`, `format`, `if`/`then`/`else`, `allOf`, `not`, `uniqueItems`, `patternProperties`, …) yang muncul di skema yang divendor adalah error **saat build**, bukan batasan yang diam-diam diabaikan — sikap fail-closed yang sama yang diambil *scripts/check-contracts.py* milik OMES sendiri, sehingga skema yang divendor di masa depan yang belum ditinjau kompatibilitas-subset-validatornya tidak bisa lolos tanpa ditegakkan;
- `additionalProperties: false` dihormati di mana pun skema yang divendor menetapkannya — request operasi dengan field `command`, `args`, `shell`, atau field lain yang tidak disebutkan skema `deployment.request` dan `operation-request` milik OMES ditolak oleh skema itu sendiri, sebelum kode handler modul ini pernah berjalan;
- pemindaian rahasia-mentah tanpa syarat berjalan pada setiap request/response yang diserialisasi atau dideserialisasi modul ini terhadap kontrak yang divendor — pemeriksaan dua-bagian yang sama yang dijalankan validator OMES sendiri (pemeriksaan nama-kunci untuk field berbentuk `token|password|secret|credential|api_key|passphrase|cookie|authorization`, dan pemeriksaan berbasis pola untuk bentuk nilai-rahasia yang sudah dikenal terlepas dari nama field) — diimplementasi ulang di sini alih-alih dibagikan sebagai dependensi, karena modul ini tidak punya alasan lain untuk bergantung pada runtime Python OMES, tetapi diuji terhadap bentuk fixture yang sama yang divendor OMES (`fixtures/operation-request/invalid-permission-denied-with-command-field.json`, `fixtures/deployment-view/invalid-raw-secret-in-error-evidence.json`) sehingga kedua implementasi tidak bisa diam-diam melenceng soal apa yang dihitung sebagai kebocoran;
- `contract_version` apa pun yang tidak dikenali modul ini — klien yang menyajikan versi di luar kumpulan `v1` yang divendor, atau heartbeat worker OMES yang mengklaim `contract_version` yang tidak punya skema di validator modul ini — adalah penolakan bertipe (`UNSUPPORTED_CONTRACT_VERSION`), tidak pernah diurai seadanya. Fail closed pada versi tak dikenal, bukan fail open pada "kelihatannya cukup dekat."

**Tidak ada evaluator sisi browser yang menduplikasi logika job atau entitlement milik OMES sendiri.** `evaluate(entitlement, action, resource_policy)` milik `lib/omes/py/jobs/entitlement.py` dan penurunan ulang allowlist/persetujuan milik job runner sendiri dikonsumsi sebagai **bukti yang sudah dihitung dan dilaporkan balik oleh OMES** (`job-status.response`, `deployment-view.observed_state`, digest registry-kapabilitas dari heartbeat) — modul ini tidak pernah mengimplementasi ulang aritmatika allow/deny `evaluate()` dalam TypeScript, di browser, atau di mana pun di `apps/cms`. UI yang perlu tahu apakah suatu operasi sedang diizinkan membaca kapabilitas yang dilaporkan OMES, sesuai D5; ia tidak menghitung kapabilitasnya sendiri yang bisa berbeda dari kebenaran host sendiri.

### D3 — Transport: browser tidak pernah bicara ke host; server mengonsumsi transport pull-worker keluar milik OMES

Satu-satunya target jaringan browser adalah API repositori ini sendiri (`apps/cms`) — tidak pernah host OMES, langsung maupun tidak langsung. Sisi server modul ini adalah **konsumen** transport pull-worker keluar yang akan didefinisikan `ahliweb/omes#192`, bukan implementasi kedua atasnya:

```text
Browser
  -> API terautentikasi AWCMS-one (RBAC/ABAC/RLS + persetujuan + outbox)
  -> operasi berizin yang tertunda, diantrekan sebagai baris job omes_control
  <- pull HTTPS oleh worker OMES yang terdaftar (diinisiasi worker, hanya keluar)
  -> verifikasi skema/scope/kapabilitas lokal di worker
  -> submit/approve/run job omes (allowlist milik OMES sendiri, diturunkan ulang, tidak pernah hanya memercayai keputusan modul ini)
  -> verifikasi baca-ulang
  -> hasil bertanda tangan/redaksi + bukti health/proyeksi, di koneksi keluar yang sama
  -> model baca proyeksi/rekonsiliasi AWCMS-one
```

Bentuk ini — **pull keluar, tanpa listener privileged publik** — adalah satu keputusan arsitektural yang sudah dikomit body issue `ahliweb/omes#192` sendiri sebelum kriteria penerimaannya terpenuhi: "tanpa listener privileged publik di host OMES; tanpa SSH masuk sebagai jalur eksekusi normal; tanpa shell jarak jauh sembarangan; tanpa kepercayaan browser-ke-host." ADR ini tidak memperdebatkan ulang pilihan itu; ia mencatat bahwa sisi server repositori ini dibangun untuk mengonsumsi persis bentuk itu, dan tidak ada apa pun dalam desain `omes_control` sendiri yang mengharuskan OMES memaparkan listener masuk sebagai gantinya. Jika `ahliweb/omes#192` akhirnya mendaratkan bentuk transport yang secara material berbeda dari sketsa pull-worker di atas, adapter pengonsumsi di `apps/cms/src/modules/omes-control/` berubah; batas modul, matriks kepemilikan, dan disiplin RLS/persetujuan/audit di D1/D4 tidak berubah.

**Enrollment** mengikuti bentuk tanpa-membawa-rahasia yang sama yang diusulkan `ahliweb/omes#192`: operator membuat catatan server tertunda di modul ini yang tidak membawa kredensial sama sekali; Control Center menerbitkan tantangan (challenge) enrollment sekali-pakai dan berumur pendek; host OMES membangkitkan materi kunci worker-nya sendiri secara lokal dan tidak pernah mengirimkannya; worker menukar tantangan dengan identitas worker yang di-scope; **modul ini hanya menyimpan metadata identitas/kredensial publik** — id kunci, sidik jari kunci publik atau sertifikat, pointer berbentuk `secret_ref` jika ada resolusi yang diperlukan — tidak pernah kunci SSH mentah, token provider, atau kredensial Hermes. Rotasi dan pencabutan adalah mutasi eksplisit yang diatribusikan ke aktor, diaudit persis seperti tindakan `omes_control` berisiko-tinggi lainnya (D4).

### D4 — Admisi modul: `omes_control`, modul domain terisolasi, bukan di dalam `commerce`

`omes_control` diadmisi sebagai modul tingkat-atasnya sendiri di `apps/cms/src/modules/omes-control/`, mengikuti disiplin admisi modul milik `apps/cms` sendiri (`apps/cms/AGENTS.md`) persis seperti `commerce` — **bukan** sebagai area keempat di dalam `commerce`. ADR-0008 memutuskan "satu modul `commerce` membawa seluruh toko, bukan tiga" karena catalog/marketing/orders adalah satu domain terbatas (jalur pembelian pembeli) yang berbagi satu set tabel atau tidak sama sekali. Armada operasional OMES — server, deployment, job, snapshot health, backup, enrollment, proyeksi audit — tidak berbagi skema, izin, model baca, atau domain event apa pun dengan keranjang belanja pembeli; memaksanya ke dalam `commerce` akan mengulang persis kesalahan yang coba dihindari ADR-0008, dalam arah sebaliknya (menempelkan domain tak terkait ke modul yang sudah punya batas jelas), dan akan membuat setiap `git subtree pull` `apps/cms` di masa depan (bagian subtree AGENTS.md sendiri) menyentuh pohon `commerce` untuk alasan yang tidak ada hubungannya dengan commerce.

`omes_control` memakai ulang setiap primitif yang sudah dimiliki basis kode ini alih-alih menemukan yang paralel:

- **`withTenant` + `authorizeInTransaction`** pada setiap mutasi dan setiap pembacaan ber-scope tenant — pola yang sama yang sudah dipakai `commerce` dan setiap modul teradmisi lainnya; tidak ada tabel `omes_control` yang pernah di-query di luar transaksi ber-scope tenant.
- **`ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`** pada setiap tabel ber-scope tenant (`omes_servers`, `omes_deployments`, `omes_operation_requests`, `omes_jobs`, `omes_health_snapshots`, `omes_backup_snapshots`, `omes_audit_projection`, `omes_enrollments`), sesuai model data minimum yang disebut epic sendiri.
- **`Idempotency-Key`** pada setiap endpoint pengajuan-operasi dan penerimaan-hasil-worker — pengajuan duplikat (request browser yang diulang, hasil worker yang dikirim ulang) tidak pernah dieksekusi dua kali, disiplin yang sama yang sudah diharuskan endpoint sesi-bearer dan webhook milik ADR-0016/ADR-0017 sendiri.
- **Event audit** untuk setiap tindakan berisiko-tinggi (registrasi server, enrollment, request operasi lifecycle apa pun, keputusan persetujuan, restore/rollback backup) — memakai ulang primitif audit yang sudah ditulisi `commerce` dan modul lain, bukan tabel audit kedua yang ditemukan modul ini sendiri.
- **Outbox domain-event** untuk pekerjaan asinkron (job yang diantrekan menjadi terlihat oleh transport pull-worker, hasil job yang selesai memberi umpan balik ke proyeksi) — bentuk CLAIM → kerjakan di luar transaksi apa pun → FINALIZE yang sama yang sudah dibuktikan D1 ADR-0017 tiga kali lipat untuk `email`/`push_delivery`/outbox provider; antrean job berhadapan-worker persis bentuk ini sekali lagi, bukan yang baru.
- **`workflow_approval`** yang menggerbangi operasi destruktif (`rollback`, `restore`, `stop`, dan `update` di mana kebijakan mengharuskan) sebelum job pernah diantrekan untuk ditarik worker — disiplin persetujuan-eksplisit yang sama yang secara langsung disebut epic #146 dan sudah diasumsikan desain webhook/rekonsiliasi ADR-0017 sendiri untuk apa pun yang tidak bisa dibalik.

**Migrasi melanjutkan rentang `9xx` yang direservasi repositori ini, setelah nomor `commerce` sendiri.** Sesuai ADR-0015, `commerce` menempati `901`–`934` dengan nomor `commerce` bebas berikutnya `935`; migrasi `omes_control` sendiri dinomori maju dari mana pun prefiks tertinggi `apps/cms/sql/9*.sql` yang ada saat #152 mendarat (`935` saat ADR ini ditulis — `apps/cms/tests/commerce-migrations-range.test.ts` saat ini hanya menegaskan "migrasi commerce adalah 900–999, semua yang lain di bawah 900," sehingga test itu **diperluas di #152**, bukan di sini, agar juga mengenali migrasi bernama `awcms_omes_control_*` sebagai milik pita 9xx yang direservasi alih-alih gagal pada asersi "migrasi non-commerce tetap di bawah 900"-nya). Tidak ada migrasi `omes_control` yang pernah menomori ulang migrasi yang dibawa `git subtree pull` dari upstream, sesuai aturan AGENTS.md yang sudah ada untuk `commerce`.

Izin mengikuti permukaan yang disebut epic sendiri: `omes.servers.read`/`.register`, `omes.deployments.read`/`.operate`, `omes.jobs.read`/`.approve`, `omes.backups.read`/`.restore`/`.rollback`, `omes.audit.read` — default-deny, hak-istimewa-terkecil, didefinisikan sekali #152 mendaratkan kerangka modul.

### D5 — Kapabilitas hanya berasal dari bukti OMES; data basi dirender sebagai basi, tidak pernah sebagai sehat

UI tidak pernah menge-hardcode "operasi ini tersedia" dari asumsinya sendiri soal apa yang bisa dilakukan OMES atau Hermes. Setiap operasi yang dirender layar sebagai bisa dieksekusi digerbangi oleh digest registry-kapabilitas yang dilaporkan heartbeat worker yang terdaftar sendiri — sikap hanya-dari-bukti yang sama yang sudah diterapkan D2 pada `evaluate()`. Operasi yang tidak didukung baseline OMES saat ini tidak pernah dirender sebagai tindakan yang bisa diklik; ia entah tidak ada atau ditampilkan secara eksplisit sebagai tidak didukung, tidak pernah diabu-abukan-tapi-secara-teknis-bisa-diklik di balik pemeriksaan sisi klien yang bisa dilewati.

Kebasian (staleness) adalah properti kelas satu yang selalu terlihat, bukan yang disimpulkan: `last_reconciled_at` milik `deployment-view` sendiri dan usia heartbeat worker sendiri dibaca dan ditampilkan langsung. Data yang lebih tua dari jendela kesegaran yang didefinisikan modul ini dirender **sebagai basi** — status visual/tekstual yang berbeda, tidak pernah diam-diam diciutkan menjadi "sehat" atau "tidak diketahui-tapi-mungkin-baik-baik-saja." Worker yang berhenti mengirim heartbeat ditampilkan sebagai offline/basi sejak jendela heartbeat-nya lewat, bukan sejak seorang manusia menyadarinya.

### D6 — Keselarasan standar: praktik rekayasa, bukan sertifikasi

Desain dan bukti untuk `omes_control` diharapkan selaras dengan praktik rekayasa di balik ISO/IEC 27001, 27002, 27005, 27017, 27018, 27701; ISO/IEC 20000-1; ISO 22301; prinsip ISO/IEC 15408; OWASP ASVS dan OWASP API Security; NIST SP 800-53 dan SP 800-207 (zero trust); benchmark CIS; dan praktik rantai pasok SLSA/OpenSSF — daftar yang sama yang secara langsung disebut epic #146, diadopsi di sini sebagai acuan kerja modul ini sendiri. **Tidak ada sertifikasi terhadap standar mana pun ini yang diklaim ADR ini, repositori ini, atau dokumentasi `omes_control` di masa depan mana pun** — ini dikutip sebagai disiplin rekayasa yang menjadi acuan model ancaman modul ini (di bawah) dan pilihan RLS/persetujuan/audit/idempotensi-nya (D4) dibangun untuk memenuhi semangatnya, bukan sebagai pernyataan kepatuhan yang bisa diandalkan pelanggan atau auditor sebagai bukti sertifikasi resmi.

### D7 — Non-tujuan eksplisit

`omes_control` **tidak** membangun, dan tidak ada issue turunan #151–#158 yang berwenang membangun tanpa ADR baru:

- runtime Hermes kedua, atau implementasi ulang apa pun dari semantik penalaran/sesi/memori/skill/channel/perutean-model milik Hermes sendiri;
- endpoint shell atau SSH dalam bentuk apa pun, di mana pun dalam permukaan API modul ini sendiri;
- pembacaan filesystem host dalam bentuk apa pun — bukan tail log, bukan pratinjau file konfigurasi, tidak ada apa pun yang mengembalikan isi file host mentah ke browser;
- permukaan inspeksi database privat ke dalam status Hermes sendiri;
- jalan keluar "jalankan perintah ini di host" generik, dengan nama apa pun — setiap operasi yang bisa diminta modul ini adalah anggota enum `operation` tertutup milik OMES sendiri (`preflight, install, configure, start, stop, restart, update, status, backup, restore, rollback` milik `deployment.request`, atau enum `operation-request` yang lebih sempit untuk layar berbentuk issue #91), tidak pernah field bebas-bentuk.

## Model ancaman dan dampak privasi (ringkasan)

**Aset:** inventaris tenant/server/deployment dan barisnya yang ber-scope RLS; catatan operation-request dan job (termasuk keputusan `permission`/persetujuan yang tercatat); bukti health/backup/rekonsiliasi; metadata identitas enrollment/worker (kunci publik, id kunci, sidik jari — tidak pernah kunci privat atau rahasia host mentah); log audit itu sendiri.

**Aktor:**

| Aktor | Tingkat kepercayaan | Apa yang bisa mereka lakukan |
| --- | --- | --- |
| Operator tenant | Terautentikasi, ber-scope RBAC/ABAC ke tenant mereka sendiri | Membaca server/deployment/job/health/backup/audit tenant mereka; mengajukan request operasi berizin yang diizinkan izin mereka; menyetujui operasi destruktif jika peran mereka membawa hak persetujuan |
| Pemilik platform | Terautentikasi, admin lintas-tenant | Mendaftarkan server, mengelola enrollment, membaca/menyetujui lintas tenant yang mereka administrasi |
| Worker OMES terdaftar | Identitas ber-scope, terikat tenant/server, yang dibentuk sekali lewat tantangan enrollment sekali-pakai | Menarik job yang diantrekan hanya untuk tenant/server-nya sendiri; mengirim hasil/heartbeat hanya untuk identitasnya sendiri; tidak bisa bertindak sebagai server atau tenant lain |
| Internet tak terautentikasi | Tidak ada | Hanya bisa menjangkau permukaan publik modul ini, jika ada (endpoint tantangan-enrollment yang terikat ke catatan server pra-dibuat, tanpa-rahasia); setiap endpoint lain memerlukan sesi terautentikasi atau identitas worker terdaftar |
| Host yang dikompromikan | Memegang materi kunci satu worker itu sendiri, tidak ada yang lain | Bisa bertindak hanya sebagai satu server/tenant itu saja, dan hanya dalam allowlist operasi dan gerbang persetujuan yang diturunkan ulang secara independen oleh job runner OMES sendiri — ia tidak bisa memalsukan identitas tenant lain, dan ia tidak pernah memegang kredensial database repositori ini sendiri atau rahasia tenant lain mana pun |

**Batas kepercayaan:** browser ↔ API `apps/cms` (sesi/bearer + RLS); `apps/cms` ↔ transport pull-worker (diinisiasi worker, hanya keluar, sesuai D3 — repositori ini tidak pernah memanggil host); `apps/cms` ↔ PostgreSQL-nya sendiri (ditegakkan RLS per tenant); `omes_control` ↔ bagian lain `apps/cms` (batas modul, D4 — tidak ada tabel bersama dengan `commerce` atau modul mana pun lainnya).

**Kasus penyalahgunaan utama dan kontrolnya:**

| Kasus penyalahgunaan | Kontrol |
| --- | --- |
| Pembacaan lintas-tenant (tenant A melihat server/job/audit milik tenant B) | `ENABLE`/`FORCE ROW LEVEL SECURITY` pada setiap tabel ber-scope tenant (D4); `additionalProperties: false` pada `target` di skema `operation-request` yang divendor juga menolak identitas tenant kedua yang diselundupkan di level skema (D2) — pemeriksaan kedua yang independen di balik RLS, bukan penggantinya |
| Penyelundupan rahasia dalam bukti (token/kredensial mentah menumpang dalam field string yang secara skema sah, mis. di dalam `error_evidence.message`) | Pemindaian rahasia-mentah nama-kunci + berbasis-pola tanpa syarat (D2) berjalan pada setiap kontrak yang diserialisasi atau dideserialisasi modul ini, menolak payload sebelum disimpan atau dirender |
| Hasil yang diputar ulang (worker atau penyerang mengirim ulang hasil job yang sudah diproses) | `Idempotency-Key` pada setiap endpoint penerimaan-hasil (D4); kunci yang diputar ulang mengembalikan hasil asli, tidak pernah mengeksekusi atau mencatat efek kedua ulang |
| Data basi dirender sebagai sehat | Rendering kebasian eksplisit D5 dari `last_reconciled_at`/usia heartbeat — tidak pernah disimpulkan, tidak pernah diam-diam diciutkan menjadi "OK" |
| Operasi tak didukung dirender sebagai bisa dieksekusi | Penggerbangan kapabilitas hanya-dari-bukti D5 — operasi yang tidak ada di digest registry-kapabilitas heartbeat saat ini tidak pernah ditampilkan sebagai bisa diklik |
| Request yang ditolak tetap menyelundupkan field berbentuk perintah | `additionalProperties: false` pada skema `deployment.request`/`operation-request` yang divendor menolak field `command`, `args`, atau `shell` apa pun secara langsung, terlepas dari nilai `permission.granted` yang juga dibawa request (D2) |
| Penggunaan ulang atau replay tantangan enrollment | Tantangan sekali-pakai, berumur pendek (D3); tantangan yang sudah dipakai atau kedaluwarsa tidak bisa ditukar kedua kalinya |

**Data pribadi yang ada:** identitas aktor yang tercatat pada setiap baris audit dan setiap keputusan persetujuan (id pengguna operator, teratribusi sesuai persyaratan audit D4) adalah data pribadi dalam pengertian biasa yang sudah ditangani repositori ini untuk jejak audit setiap modul lain. Ia tidak membawa kategori khusus data apa pun di luar itu. **Retensi** mengikuti mekanisme `data_lifecycle` yang sudah ada di repositori ini — baris audit dan riwayat-job `omes_control` tunduk pada disiplin kebijakan retensi/purge yang sama yang sudah dipakai tabel teraudit modul lain; #152 mendaftarkan tabel `omes_control` ke situ alih-alih menemukan mekanisme retensi kedua.

## Pengiriman

Turunan epic #146, sesuai admisi ADR ini sendiri:

| Issue | Cakupan | Status |
| --- | --- | --- |
| #151 | ADR ini (admisi: kepemilikan, kontrak, transport, bentuk modul, kapabilitas hanya-dari-bukti, keselarasan standar, non-tujuan, model ancaman) | Perubahan ini |
| #152 | Kerangka modul `omes_control` — skema (delapan tabel D4), izin, migrasi melanjutkan rentang 9xx yang direservasi, `commerce-migrations-range.test.ts` diperluas untuk mengenalinya |
| #153 | Registrasi server dan enrollment (D3) — catatan server tertunda, penerbitan tantangan sekali-pakai, penyimpanan identitas worker (hanya metadata publik) |
| #154 | Model baca deployment/job dan layar Overview/Servers/Deployments/Jobs (matriks kepemilikan D1 dirender sebagai UI, kapabilitas hanya-dari-bukti dan tampilan kebasian D5) |
| #155 | Pengajuan operasi dan penerimaan hasil-worker lewat transport pull-worker — **terblokir pada `ahliweb/omes#192`**, masih terbuka saat ADR ini ditulis; sisi konsumen repositori ini sendiri tidak bisa dibangun terhadap kontrak transport yang belum ada |
| #156 | Layar backup/recovery, restore/rollback tergerbangi persetujuan (persyaratan `workflow_approval` D4) |
| #157 | Layar audit dan pendaftaran `data_lifecycle` |
| #158 | Visibilitas orkestrasi (tampilan hanya-baca profil/status native-Hermes lewat adapter OMES/Hermes yang didukung), sapuan dokumentasi, dan penutupan epic |

## Opsi yang dipertimbangkan

| Opsi | Mengapa tidak (atau mengapa dipilih) |
| --- | --- |
| **Modul `omes_control` terisolasi, kontrak `v1` OMES yang di-pin, transport pull-worker yang dikonsumsi, kapabilitas hanya-dari-bukti** (dipilih) | Memakai ulang setiap primitif yang sudah dimiliki basis kode ini (RLS, outbox, persetujuan, audit, idempotensi) untuk domain tanpa tumpang tindih skema/izin/model-baca dengan `commerce`, dan tidak menduplikasi evaluator job/entitlement milik OMES sendiri atau menemukan desain transport kedua sebelum `ahliweb/omes#192` |
| Melipat operasi OMES ke dalam `commerce` sebagai area keempat | Mengulang bentuk yang ditolak ADR-0008 sendiri dalam arah sebaliknya — domain tak terkait (operasi armada host) ditempelkan ke modul yang batasnya (jalur pembelian pembeli) tidak ada hubungannya sama sekali, dan membuat setiap subtree pull `apps/cms` di masa depan menyentuh `commerce` untuk alasan yang tidak terkait |
| Mengimplementasi ulang evaluator job/entitlement OMES di modul ini (atau di browser) demi UI yang lebih cepat | Menciptakan sumber kebenaran kedua yang independen dan bisa melenceng untuk keputusan allow/deny yang sudah diturunkan ulang dan ditegakkan job runner OMES sendiri; evaluator sisi-UI yang tidak sepakat dengan keputusan host sendiri adalah moda kegagalan yang lebih buruk daripada menunggu bukti OMES sendiri |
| Mendesain dan membangun transport khusus sekarang, sebelum `ahliweb/omes#192` | Repositori ini tidak memiliki worker sisi-host; membangun implementasi transport sisi browser/API terhadap protokol yang belum ditetapkan OMES berisiko membangun hal yang salah dua kali — #155 secara eksplisit terblokir pada issue itu mendarat lebih dulu |
| Listener masuk di setiap host OMES, terjangkau dari API repositori ini | Persis "listener privileged publik OMES" yang ditolak baik epic #146 maupun `ahliweb/omes#192` — membalik batas kepercayaan yang ADR ini ditulis untuk melindunginya |
| Mengklaim sertifikasi resmi terhadap standar yang dikutip | Tidak ada proses sertifikasi yang pernah dijalani; mengutip standar sebagai keselarasan praktik-rekayasa sambil secara eksplisit menyangkal sertifikasi (D6) jujur soal apa yang sebenarnya dikomitmenkan ADR ini |

## Konsekuensi

- `apps/cms/src/modules/omes-control/` belum ada saat ADR ini ditulis; #152 membuatnya. Tidak ada apa pun dalam perubahan ini yang menyentuh `apps/cms/**`.
- `docs/arsitektur.md` mendapat subbagian penunjuk singkat ke ADR ini (di bawah), menyatakan dengan jelas bahwa belum ada kode yang ada.
- `apps/cms/tests/commerce-migrations-range.test.ts` perlu diperluas (di #152, bukan di sini) untuk mengenali migrasi berprefiks `awcms_omes_control_*` sebagai juga termasuk dalam rentang 9xx yang direservasi, di samping milik `commerce` sendiri.
- #155 (pengajuan operasi / penerimaan hasil-worker) tidak bisa dimulai sampai `ahliweb/omes#192` mendaratkan kontrak transport yang konkret; setiap issue turunan lain bisa berjalan begitu skema #152 ada, karena batas kepemilikan/kontrak D1–D2 tidak bergantung pada bentuk akhir transport.
- ADR baru (atau amandemen di sini) diperlukan sebelum `omes_control` mengonsumsi kontrak apa pun dari keluarga catalog/subscription/invoice/payment-gateway di direktori `v1` yang divendor sama — D2 mem-vendor seluruh direktori demi kemudahan kompatibilitas, bukan sebagai lisensi untuk memakai semuanya.

## Status — 21 September 2026: admisi diputuskan, belum ada implementasi

ADR ini menetapkan batas kepercayaan, pin kontrak, bentuk konsumsi transport, batas modul, dan non-tujuan yang menjadi acuan kode setiap issue turunan epic #146. `apps/cms/src/modules/omes-control/` belum ada; #152 adalah issue pertama yang menambahkan kode berjalan. #155 tetap terblokir pada `ahliweb/omes#192`, yang masih terbuka saat ADR ini ditulis.
