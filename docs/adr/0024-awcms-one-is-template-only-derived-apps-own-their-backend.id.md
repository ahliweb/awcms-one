🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)

<!-- i18n-source-hash: sha256:ec2f100f7f1473ba96e31c3bc9b274c38308f4f52852aa260fa292a885b74c03 -->

# ADR-0024 — awcms-one hanya template; aplikasi turunan memiliki backend dan runtime sendiri

- **Status:** Accepted
- **Tanggal:** 3 Oktober 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.id.md); issue [#297](https://github.com/ahliweb/awcms-one/issues/297)

## Konteks

`awcms-one` adalah reference deployment yang berfungsi sekaligus template GitHub. Produk turunan dapat tergoda menaruh frontend di repo lain tetapi tetap mengarahkan trafik produksi ke `apps/cms` hidup milik repo ini. Pola tersebut mengubah template menjadi backend aplikasi bersama, mencampur lifecycle serta data consumer ke reference deployment, dan membuat issue produk diimplementasikan pada repo yang bukan pemilik produk tersebut.

IRMbyDUS memperlihatkan masalah ini secara konkret: repo produknya memiliki PRD, UX, privacy, dan pekerjaan frontend, sementara beberapa issue backend spesifik IRM ditempatkan di `awcms-one`. Improvement generik seperti commerce entitlement dan private-media delivery layak menjadi capability template; siklus praktik IRM, program 21 hari, jurnal privat IRM, dan semantik mentoring IRM adalah concern domain produk.

## Keputusan

### D1 — Template bukan shared backend service

Aplikasi yang dibuat dari atau berbasis `awcms-one` WAJIB memiliki dan mengoperasikan backend instance sendiri dalam boundary repo/deployment miliknya sendiri. Ia memiliki basis data, migrasi, environment/secret, domain, kredensial provider, jobs, data produk, backup, observability, dan lifecycle rilis sendiri.

Aplikasi turunan TIDAK BOLEH memakai reference deployment `ahliweb/awcms-one/apps/cms` sebagai system of record produksinya hanya karena API yang dibutuhkan sudah tersedia di sini.

### D2 — Penempatan issue mengikuti kepemilikan kode

Issue backend spesifik produk berada di repo produk yang akan menyimpan implementasinya. Requirement produk, UX, UAT, legal/compliance, operasi, dan deployment juga tetap di repo produk tersebut.

Issue hanya berada di `awcms-one` bila implementasinya memang dimaksudkan menjadi capability template netral dan reusable.

### D3 — Kebutuhan consumer boleh mempromosikan capability reusable, bukan domain consumer

Capability yang belum tersedia dan ditemukan oleh consumer harus diklasifikasikan:

- **Consumer-specific:** tetap di repo consumer.
- **Reusable template capability:** boleh diusulkan ke sini setelah nama produk, konten, asumsi workflow sekali-pakai, dan konfigurasi deployment spesifik dihilangkan serta reuse dibuktikan melalui kontrak/tes netral.
- **AWCMS-owned foundation:** masuk ke `ahliweb/awcms` terlebih dahulu, lalu tiba di sini melalui subtree sync yang sudah ditetapkan.

Fakta bahwa saat ini hanya satu consumer membutuhkan suatu fitur adalah alasan untuk memeriksa generalitasnya, bukan izin untuk memasukkan domain model consumer ke template.

### D4 — Tidak ada tenancy produksi atau secret consumer di reference deployment

Jangan provision tenant produksi, verifikasi domain, API token, secret, konten privat pelanggan, queue/job spesifik produk, atau state operasional produk turunan di reference deployment repo ini.

Reference deployment boleh mempunyai fixture development/test netral untuk membuktikan perilaku template, tetapi fixture itu tidak boleh menjadi dependency produksi consumer.

### D5 — Repo turunan boleh mengadopsi rilis template kemudian secara sengaja

Repo turunan boleh mengimpor/sync/cherry-pick capability template yang telah disetujui sesuai migration dan regression plan miliknya sendiri. Ini adalah hubungan **evolusi source**, bukan dependency runtime service.

Availability template tidak boleh pernah berada pada jalur availability produksi produk turunan.

### D6 — Improvement generik yang dipicu IRM tetap; domain IRM dipindahkan

Capability generik yang sudah merged selama pembangunan IRMbyDUS — seperti jenis produk commerce tambahan yang generik, commerce entitlements, dan signed download private-media — tetap berada di `awcms-one` karena merupakan capability baseline yang reusable.

Pekerjaan domain IRM yang masih terbuka (practice, program, journal, progress, mentoring, dan provisioning deployment IRM) dipindahkan ke `ahliweb/web-irmbydus.com`. Generic booking/scheduling atau capability lain yang ditemukan oleh produk tersebut dapat dipromosikan kemudian secara terpisah menurut D3.

## Konsekuensi

- Aplikasi turunan dapat dideploy dan dipulihkan secara independen.
- Data produk dan secret tetap berada di boundary operasional produk.
- `awcms-one` tetap reusable dan tidak menumpuk modul vertikal sekali-pakai.
- Beberapa improvement berguna mungkin untuk sementara diimplementasikan dua tahap: pertama sebagai kebutuhan produk, lalu diekstrak/dipromosikan ke template. Duplikasi sementara ini lebih baik daripada mengikat availability produk pada shared reference deployment.
- Kontrak lintas-repo menjadi urusan adopsi versi/template, bukan dependency layanan hidup.
- Agen baru wajib mengklasifikasikan ownership sebelum membuka issue atau mengubah kode.

## Verifikasi

Untuk setiap feature request baru yang berasal dari aplikasi turunan, PR/issue wajib menyebut:

1. repo pemilik kode akhir;
2. pemilik runtime/deployment;
3. apakah fitur consumer-specific, reusable template capability, atau AWCMS-owned foundation;
4. migration/compatibility path bila consumer kelak mengadopsi implementasi template yang telah dipromosikan.

Review gagal Definition of Ready bila empat jawaban tersebut tidak ada.
