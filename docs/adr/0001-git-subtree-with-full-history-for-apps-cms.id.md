🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0001-git-subtree-with-full-history-for-apps-cms.md)

<!-- i18n-source-hash: sha256:04ac23689037e84896f8b7357443d56267023dd09f9fa16f2af4e114440b186b -->

# ADR-0001 — `apps/cms` adalah `ahliweb/awcms`, di-embed lewat `git subtree` dengan riwayat lengkap

- **Status:** Diterima
- **Tanggal:** 15 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [issue #1](https://github.com/ahliweb/awcms-one/issues/1) (epik re-platform); [issue #2](https://github.com/ahliweb/awcms-one/issues/2) (embed ini); [`AGENTS.md`](../../AGENTS.md#the-subtree-embed) (mekanisme sinkronisasi dan satu aturan yang melindunginya); [`knowledge/curated/ownership-boundaries.md`](../../knowledge/curated/ownership-boundaries.md)

## Konteks

`commerce` — modul yang benar-benar dibutuhkan platform ini (issue #4) — bergantung pada infrastruktur bersama `awcms` yang tidak punya paket mandiri: `withTenant` (konteks tenant RLS), `authorizeInTransaction` (RBAC/ABAC), `appendDomainEvent` (outbox transaksional), `recordAuditEvent`, `defineModule` milik `_shared/module-contract`, `getDatabaseClient`, migration runner SQL, dan `_shared/api-response`. Tidak satu pun dipublikasikan sebagai paket. `commerce` tidak bisa berdiri sendiri tanpa menciptakan ulang semua itu — persis seperti yang sudah dilakukan `ahliweb/media-lenterakalteng` (model yang menjadi acuan tata letak workspace dan gate repositori ini) dengan meng-embed `awcms` utuh alih-alih menggantungkannya sebagai paket.

Tiga cara membawa tree itu ke repositori ini dipertimbangkan:

| | riwayat lengkap (`git subtree`) | `--squash` | salinan vendored |
| --- | --- | --- | --- |
| Ukuran repo | +~70 MB terpaket (1.530 commit dibawa sebagai ancestry) | hanya working tree | hanya working tree |
| `git blame` ke `apps/cms` | lengkap | hilang | hilang |
| Sinkronisasi `git subtree pull` masa depan | merge base nyata, gesekan rendah | merge base sintetis, rawan konflik | diff manual selamanya |
| Cocok dengan `media-lenterakalteng` | ya (`.git` repo itu sendiri 123 MB) | tidak | tidak |

`apps/cms` adalah kode yang aktif ditambal dan di-debug tim ini ke depannya — `commerce` sendiri sudah menyentuh 29 berkasnya (lihat Consequences) — jadi kehilangan `git blame` di sana adalah biaya pemeliharaan nyata dan berkelanjutan, bukan ketidaknyamanan sekali pakai. Dan kesetiaan sinkronisasi upstream adalah keseluruhan alasan memilih "embed" ketimbang "bergantung pada paket" sejak awal; `--squash` atau salinan vendored masing-masing akan membeli kembali keputusan itu dengan diskon yang terkikis pada sinkronisasi pertama.

## Keputusan

`apps/cms` adalah `ahliweb/awcms` v10.3.0 (commit `749404d4963af1dfaf8a5cf8b229299b29556ce2`), di-embed utuh lewat `git subtree add --prefix=apps/cms`, **tanpa `--squash`** — riwayat commit upstream lengkap dipertahankan sebagai ancestry. Remote upstream bernama `awcms`, hanya mengambil `main` (`+refs/heads/main:refs/remotes/awcms/main` — menambahkannya tanpa dipersempit menarik tujuh branch Dependabot pada percobaan pertama, persis kekacauan yang tidak pernah dibutuhkan sinkronisasi subtree). Sinkronisasi ke depan adalah `git subtree pull --prefix=apps/cms awcms main`.

**Satu aturan yang melindungi setiap sinkronisasi masa depan: PR yang menjalankan `git subtree pull` harus digabung dengan merge commit, tidak pernah di-squash, tidak pernah di-rebase.** `git subtree pull` bekerja dengan mencari merge base antara riwayat repo ini dan upstream lalu memutar ulang commit upstream di atasnya. Men-squash pull itu meruntuhkan setiap commit yang diputar ulang menjadi satu commit sintetis yang tidak dibuat git lewat merge, yang menghancurkan merge base yang dibutuhkan pull *berikutnya* — dan kerusakannya tak kasatmata saat itu: PR yang di-squash tetap tergabung mulus, CI hijau, dan kerusakan baru muncul saat sinkronisasi berikutnya dicoba, jauh dari commit yang menyebabkannya. Tidak ada apa pun di branch protection repositori ini yang mencegah ini secara mekanis hari ini (required check GitHub bernama `Check`, bukan pembatasan strategi merge — lihat [`docs/alur-kerja-pengembangan.md`](../alur-kerja-pengembangan.md)); penjaganya adalah paragraf ini, dibaca sebelum tombol merge ditekan, dicatat di tiga tempat (`AGENTS.md`, ADR ini, dan [`knowledge/curated/ownership-boundaries.md`](../../knowledge/curated/ownership-boundaries.md)) justru karena belum ditegakkan oleh tempat keempat.

Sumber `apps/cms` sendiri tetap tree milik upstream. Pekerjaan yang spesifik untuk platform ini — modul `commerce` — bersifat aditif di dalam direktori modul `apps/cms` sendiri, mengikuti disiplin pengadopsian-modulnya sendiri (`apps/cms/AGENTS.md`), tidak pernah menjadi tambalan lokal pada kode yang akan dikonflikkan atau ditimpa diam-diam oleh `git subtree pull` berikutnya.

**Pembaruan status (2026-09-21, issue #149):** paragraf di atas mencatat keputusan sebagaimana berlaku pada 15 September 2026, ketika tidak ada apa pun di pengaturan repositori ini yang mencegah squash atau rebase merge secara mekanis. Celah itu kini ditutup: pengaturan merge repositori adalah `allow_merge_commit=true`, `allow_squash_merge=false`, `allow_rebase_merge=false` (diverifikasi lewat `gh api repos/ahliweb/awcms-one`), jadi merge commit adalah satu-satunya metode yang ditawarkan tombol merge GitHub, untuk kelas PR ini maupun semua PR lain. Required linear history tetap dinonaktifkan dengan sengaja, karena akan berbenturan dengan model subtree riwayat-lengkap yang dipilih ADR ini. Lihat [`AGENTS.md`](../../AGENTS.id.md#penyematan-subtree) dan [`docs/alur-kerja-pengembangan.md`](../alur-kerja-pengembangan.id.md) untuk keadaan saat ini.

## Konsekuensi

- **Mengadopsi `commerce` saja mengubah 29 berkas di luar direktori modulnya sendiri** (diverifikasi: `git show --numstat 733ee996 -- apps/cms/`, disaring ke jalur di luar `src/modules/commerce/`, `sql/153`–`155`, rute API modulnya sendiri, fragmen OpenAPI-nya, layar admin-nya, dan tes domainnya sendiri). Tiga kelompok: **registry** yang harus diikuti modul baru (`apps/cms/src/modules/index.ts`, `domain-event-runtime/domain/event-type-registry.ts`, `module-management/domain/sidebar-menu.ts`, `apps/cms/scripts/admin-screen-coverage-ledger.ts`, `apps/cms/scripts/security-readiness.ts`, `asyncapi/awcms-domain-events.asyncapi.yaml`, `openapi/awcms-public-api.src.yaml`); **inventori hasil-generate** yang diturunkan ulang dari sumber (`openapi/awcms-public-api.openapi.yaml`, `apps/cms/docs/awcms/api-reference.md`, `apps/cms/docs/awcms/repo-inventory.md`, `apps/cms/docs/awcms/module-composition-inventory.json`, `apps/cms/docs/awcms/work-class-registry.generated.json`, `apps/cms/docs/PROJECT_STATE.md`, `locales/en.po`/`id.po`, `apps/cms/src/lib/i18n/catalogs/id.generated.ts`); dan kenaikan kecil **jumlah-modul** dalam dokumentasi prosa (`apps/cms/docs/ARCHITECTURE.md`, `apps/cms/docs/awcms/13_final_master_index_traceability.md`, `apps/cms/docs/awcms/alur-pengembangan-mini-first.md`, `.claude/skills/README.md`, `.claude/skills/awcms-new-module/SKILL.md`, plus mirror `.id.md`-nya) serta `apps/cms/tests/openapi-bundle.test.ts`.
- **Setelah setiap sinkronisasi subtree, generator harus dijalankan ulang** (`bun run check` di dalam `apps/cms` menamai masing-masing) alih-alih digabung dengan tangan — berkas hasil-generate di atas persis kelas berkas yang paling mudah salah ditangani sebagai resolusi konflik dengan cara diedit, bukan digenerate ulang.
- **Meng-upstream-kan `commerce` ke `ahliweb/awcms` sendiri, sehingga ia tiba di sini lewat sinkronisasi biasa alih-alih hidup sebagai tambahan lokal, adalah keputusan tingkat keluarga-platform yang belum diambil.** Itu akan menghilangkan biaya pengadopsian 29-berkas untuk setiap modul *masa depan* yang ditambahkan platform ini, dengan biaya `commerce` menjadi modul `awcms` generik yang bisa dipakai ulang, bukan milik platform ini sendiri. Dicatat di sini agar tidak diam-diam diasumsikan ke arah mana pun.
- `.git` bertambah besar untuk menampung 1.530 commit upstream dan 2.591 berkas dalam satu commit embedding — harga yang disebutkan di muka demi tetap tersedianya `git subtree pull`.
