🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](AGENTS.md)

<!-- i18n-source-hash: sha256:84bb78988217d29f679b2add1c83c5778afc125086f4172cc4b511c4ebf5b3aa -->

# AGENTS.md — kontrak kerja awcms-one

Berlaku untuk manusia maupun agen AI yang bekerja di repo ini. Baca ini sebelum melakukan apa pun yang lain. Bila sebuah aturan di sini berbenturan dengan kebiasaan yang terasa alami, aturan di sinilah yang menang — setiap butir ada karena melanggarnya sudah, atau akan, menyebabkan cacat yang tidak terlihat sampai seseorang bertindak atas asumsi yang salah.

## Apa repo ini

**awcms-one** me-re-platform toko komersial borneojek-mart — PHP/Laravel/MySQL/React-Inertia — ke stack AWCMS: Bun, Astro, dan PostgreSQL di bawah row-level security. Ini adalah **re-platform, bukan refactor**: tidak ada kode Laravel yang dibawa. Skema sumber dibaca dari basis data MySQL `commerce_bj_mart` yang hidup dan diekspresikan ulang sebagai tabel modul AWCMS di bawah RLS PostgreSQL. Kerangka lengkap: [issue #1](https://github.com/ahliweb/awcms-one/issues/1).

Pendekatannya scaffold dulu, lalu satu vertical slice tipis (daftar katalog + detail produk) untuk membuktikan stack-nya bekerja dari ujung ke ujung sebelum pembangunan commerce penuh. **Increment 1 — epic ini — adalah fondasi plus slice yang ditulis tangan itu, tanpa basis data hidup.** Semuanya type-check dan setiap gerbang yang tidak butuh PostgreSQL berjalan hijau; memigrasi dan mengisi instans Postgres sungguhan adalah increment 2.

Tata letak workspace, mekanisme gerbang, dan konvensi changeset dokumen ini diadaptasi dari [`ahliweb/media-lenterakalteng`](https://github.com/ahliweb/media-lenterakalteng). Di mana sebuah aturan di bawah diwarisi dari pelajaran mahal repo itu sendiri alih-alih ditemukan sendiri oleh repo ini, itu dinyatakan.

## Yang ada hari ini, dan yang tidak

Sejujurnya, per dokumen ini mendarat:

- **Ada:** akar workspace dan governance-nya, `packages/config`, `packages/gerbang`, `tools/`, dan `apps/cms` (`ahliweb/awcms` v10.3.0, disematkan lewat `git subtree` dengan riwayat penuh — closes [issue #2](https://github.com/ahliweb/awcms-one/issues/2)).
- **Belum ada:** `apps/storefront` (storefront Astro publik — [issue #5](https://github.com/ahliweb/awcms-one/issues/5)), `packages/kontrak` (kontrak DTO bertipe-saja di antara keduanya plus gerbang arah-impornya — [issue #6](https://github.com/ahliweb/awcms-one/issues/6)), modul `commerce` di dalam `apps/cms` ([issue #4](https://github.com/ahliweb/awcms-one/issues/4)), dan dokumentasi arsitektur formal ([issue #7](https://github.com/ahliweb/awcms-one/issues/7)).

Jangan menulis kode, gerbang, atau dokumentasi yang mengasumsikan salah satu dari butir "belum ada" itu sudah ada. Jalur yang dikutip dalam backtick yang tidak ada di repo ini akan tertangkap pemeriksaan jalur bertanda `bun run audit:dokumen`, kecuali terdaftar di `EXCLUDED_PATHS` gerbang itu, beserta alasannya.

## Penyematan subtree

`apps/cms` adalah `ahliweb/awcms` yang disematkan utuh lewat `git subtree`, bukan dependency atau salinan. Ini menjaga riwayat commit upstream tetap utuh di dalam repo ini dan memungkinkan perbaikan mengalir di kedua arah.

| | |
| --- | --- |
| Remote upstream | `awcms` → `https://github.com/ahliweb/awcms.git`, fetch refspec dipersempit ke `+refs/heads/main:refs/remotes/awcms/main` |
| Titik sematan | `ahliweb/awcms` v10.3.0, commit `749404d4963af1dfaf8a5cf8b229299b29556ce2` |
| Perintah sinkron | `git subtree pull --prefix=apps/cms awcms main` |

**Kenapa fetch remote-nya dipersempit hanya ke `main`:** menambahkan remote tanpa mempersempit refspec-nya menyeret setiap branch upstream, termasuk branch dependabot — tujuh di antaranya, saat remote ini pertama kali ditambahkan di sini. Sinkronisasi subtree hanya pernah butuh `main`.

### Satu aturan yang melindungi setiap sinkronisasi di masa depan

**Pull request yang menyinkronkan `apps/cms/` dari upstream (`git subtree pull`) wajib di-merge dengan MERGE COMMIT — tidak pernah di-squash, tidak pernah di-rebase.**

Ini bukan preferensi gaya; ini jebakan mekanis. `git subtree pull` bekerja dengan menemukan merge base antara riwayat repo ini dan riwayat upstream, lalu memutar ulang commit upstream di atasnya. Meng-squash sinkronisasi itu melipat setiap commit upstream tadi menjadi satu commit sintetis yang tidak dibuat git lewat merge — yang merusak merge base yang dibutuhkan `git subtree pull` *berikutnya* untuk ditemukan. Setiap sinkronisasi berikutnya setelah itu kemudian bentrok melawan riwayat yang tidak bisa lagi diselaraskan git, dan kerusakannya tidak terlihat saat itu juga: PR yang di-squash tadi merge dengan bersih, CI hijau, dan kerusakannya baru muncul saat seseorang mencoba menarik dari upstream berikutnya, jauh dari commit yang menyebabkannya.

**Tidak ada apa pun yang mencegah ini secara mekanis hari ini.** Pengaturan merge repo ini saat ini mengizinkan squash merge, rebase merge, dan merge commit sekaligus, dan `main` belum punya branch protection (PR dokumen ini sendiri yang memperkenalkan CI; branch protection adalah langkah terpisah yang belum diambil). Satu-satunya penjaga adalah paragraf ini, dibaca sebelum tombol merge diklik. Bila branch protection dikonfigurasi nanti, membatasi PR yang menyentuh `apps/cms` hanya boleh merge commit adalah versi mekanis dari aturan ini dan seharusnya menggantikan sistem kehormatan di atasnya — tetapi sampai saat itu, baca ini dulu.

Setiap PR lain di repo ini boleh di-merge dengan cara apa pun yang disukai reviewer; `delete_branch_on_merge` aktif di seluruh repo, jadi branch yang sudah di-merge dibersihkan otomatis apa pun strategi merge-nya.

### Apa yang boleh, dan tidak boleh, disunting repo ini

Sumber `apps/cms` sendiri adalah pohon milik upstream, dibawa ke sini untuk alasan yang ada di [`README.md`](README.md#kenapa-appscms-menyematkan-awcms-utuh). Perubahan yang seharusnya milik upstream — perbaikan pada infrastruktur bersama `awcms`, perubahan pada modul yang dimiliki `awcms` sendiri — sebaiknya dibuat di sana dan ditarik masuk lewat sinkronisasi di atas, bukan ditambal lokal dengan cara yang akan bentrok dengan atau diam-diam ditimpa `git subtree pull` berikutnya. Pekerjaan yang spesifik untuk platform ini (modul `commerce`, issue #4) bersifat aditif di dalam direktori modul `apps/cms` sendiri, mengikuti disiplin admission modulnya sendiri (`apps/cms/AGENTS.md`).

## Batas workspace

Ini adalah workspace Bun (`workspaces: ["apps/*", "packages/*"]`); setiap direktori di bawah `apps/` dan `packages/` adalah concern terpisah, dan sebuah perubahan sebaiknya tetap di dalam workspace yang benar-benar dibahasnya. Secara konkret:

- Tidak ada yang di luar `apps/cms/` seharusnya bergantung pada **internal**-nya — hanya API publiknya, begitu `apps/storefront` ada untuk memanggilnya.
- Perkakas tingkat akar (`packages/gerbang/`, `tools/`, `tests/`) mengatur seluruh repo dan sebaiknya tetap agnostik-workspace: pemeriksaan yang hanya masuk akal untuk satu workspace masuk ke rangkaian gerbang workspace itu sendiri (skrip `check` di `apps/cms/package.json`, dan nanti punya `apps/storefront` sendiri), bukan ditempel ke rangkaian akar.
- Perubahan yang menyentuh `apps/cms/` karena alasan tidak terkait sinkronisasi subtree sebaiknya menyatakannya terus terang di PR-nya — aturan merge commit di atas berlaku khusus untuk sinkronisasi subtree, bukan setiap PR yang kebetulan menyentuh direktori itu.

## Gerbang

`bun test` plus tiga skrip `audit:*`, semuanya diadaptasi dari `packages/gerbang` milik `ahliweb/media-lenterakalteng`. Tidak satu pun butuh build, jaringan, atau `apps/cms`, jadi semuanya berjalan tanpa syarat di setiap push (`.github/workflows/ci.yml`).

| Gerbang | Apa yang ditangkapnya |
| --- | --- |
| `bun run audit:dokumen` | Tautan relatif mati di markdown; indeks ADR yang tidak lengkap di salah satu arah atau memuat baris ganda (begitu `docs/adr/` ada — ia melewati dirinya sendiri sampai saat itu); jalur berkas yang disebut dalam backtick yang tidak ada di repo ini; kutipan `ADR-NNNN` yang tidak resolve ke mana pun; angka yang dieja yang tidak sesuai dengan himpunan yang diklaimnya dihitung, di dalam blok yang ditandai eksplisit |
| `bun run audit:rilis` | Backlog `.changesets/` yang menunggu melewati batasnya — 10 berkas atau 14 hari, keduanya asumsi awal sampai ada riwayat rilis sungguhan (lihat docblock gerbang itu sendiri) |
| `bun run audit:translation` | Cermin Indonesia (`<nama>.id.md`) yang hash sumber tercatatnya sudah tidak cocok lagi dengan sumber Inggrisnya, atau dokumen governance tanpa cermin sama sekali |
| `bun test` | Rangkaian tes gerbang akar — `tests/*.test.mjs` — plus, begitu ada, tes `apps/storefront` sendiri. `apps/cms/**` dikecualikan lewat `pathIgnorePatterns` di `bunfig.toml`, bukan lewat flag di skrip `test` (lihat komentar berkas itu sendiri untuk kenapa perbedaannya krusial: CI memanggil `bun test` telanjang, dan flag di `bun run test` akan diam-diam tidak berlaku) |

**Sengaja tidak diporting**, dan alasannya bukan sekadar "belum dibangun" — melainkan masing-masing menjaga permukaan yang belum dimiliki repo ini: `audit:konten` (memeriksa keluaran HTML/build yang terbit), `audit:aset` (anggaran byte pembaca atas keluaran yang sama), `audit:graf` (kebersihan atas korpus artefak `graphify-out/`), `audit:serapan` (keputusan ADR `awcms` upstream mana yang belum dibaca siapa pun di sini — log keputusan yang tidak dipelihara repo ini). Memporting salah satunya sekarang akan menghasilkan gerbang yang lulus secara trivial selamanya, yang lebih buruk daripada ketiadaan: pemeriksaan hijau yang tidak memeriksa apa pun tidak bisa dibedakan, dari luar, dari yang memeriksa sesuatu dan menemukannya bersih. Tambahkan masing-masing kembali di perubahan yang benar-benar menciptakan permukaan yang akan dijaganya.

### Aturan yang diikuti skrip gerbang itu sendiri

Ditegakkan oleh `tests/standar-skrip.test.mjs`, dan layak dinyatakan di sini karena mudah dilanggar tanpa ada yang gagal sampai tes ini:

- **git tidak pernah dicapai lewat shell.** Setiap skrip yang butuh git melewati `packages/gerbang/lib/git.mjs`, yang memanggil argv array. `execSync` dengan string ter-interpolasi adalah risiko injeksi sungguhan, bukan hipotetis — nama ref git bisa memuat `$`, backtick, `;`, `&`, dan `|`, dan `execSync` menjalankan argumennya lewat `/bin/sh`.
- **Satu apparatus finding/report.** Kedua gerbang audit membangun laporannya lewat `createReporter` milik `packages/gerbang/lib/reporter.mjs`, bukan printer buatan tangan kedua.
- **Modul `packages/gerbang/lib/` bebas efek samping.** Mengimpor salah satunya harus tidak menjalankan apa pun dan tidak mencetak apa pun — modul yang bisa exit atau menulis ke stdout saat diimpor adalah keputusan yang tidak dibuat pemanggilnya.
- **Sebuah helper dideklarasikan sekali.** `stripTrailingCommas`, `readFileIfPresent`, dan sejenisnya tidak dideklarasikan ulang di dalam gerbang atau tool yang bisa mengimpornya.

## Konfigurasi dan toolchain

- **Bun adalah runtime dan package manager repo ini.** Versinya dipin di **tiga tempat yang wajib bergerak bersama**: `packageManager` dan `engines.bun` di `package.json` akar, dan `bun-version` di setiap job `.github/workflows/ci.yml`. Menaikkan salah satu tanpa yang lain membuat instalasi lokal, CI, dan image container mana pun nanti berperilaku berbeda — diam-diam. `packageManager` (`bun@1.4.2`) milik `apps/cms/package.json` sendiri adalah sisa dari saat ia masih repo mandiri sebelum sematan subtree; ia tidak mengatur workspace ini dan bukan bagian dari pin ini (`bun install` berjalan sekali, di akar, untuk seluruh workspace).
- **`bun.lock` harus menjadi pernyataan yang benar tentang repo ini.** `bun run check:lockfile` memeriksanya sebelum install, untuk akar dan setiap anggota workspace sungguhan: nama workspace harus milik repo ini (lockfile yang disalin dari tempat lain bisa dikenali persis di sini) dan setiap blok dependency harus cocok persis dengan `package.json`-nya. Regenerasi utuh dengan `rm -rf node_modules bun.lock && bun install`; jangan pernah menyunting `bun.lock` dengan tangan.
- **GitHub Actions dipin ke SHA commit, bukan tag**, dengan komentar `# vX.Y.Z` yang dibaca Dependabot agar keduanya tetap selaras. Tag bisa berpindah; SHA tidak, dan sebuah action berjalan dengan akses ke token workflow dan seluruh checkout.
- **`bun test` telanjang dari akar tidak boleh pernah mengeksekusi `apps/cms/**`.** Pengecualiannya hidup di `[test] pathIgnorePatterns` milik `bunfig.toml`, yang dibaca `bun test` bagaimanapun ia dipanggil — bukan sebagai flag di skrip `test` di `package.json`, yang akan diam-diam terlewat oleh `bun test` telanjang di CI.
- **Setiap variabel env yang dibaca skrip tingkat akar masuk ke `.env.example`**, beserta konsekuensi membiarkannya kosong. `apps/cms` memelihara `.env.example` sendiri untuk konfigurasi runtime-nya sendiri; berkas akar repo ini tidak menduplikasinya.

## Changeset dan rilis

Perubahan yang memengaruhi perilaku publik, struktur workspace, dependency, atau deployment mendapat berkas di `.changesets/` di perubahan yang sama yang menyebabkannya — lihat [`.changesets/README.md`](.changesets/README.md) untuk formatnya. `bump` adalah field yang penting: versi rilis berikutnya adalah `bump` **terbesar** di antara changeset yang menunggu saat `bun run release --apply` berjalan, jadi besar sebuah rilis adalah konsekuensi dari apa yang masuk ke dalamnya, bukan penilaian yang dibuat saat rilis dari daftar nama berkas.

`bun run audit:rilis` mengawasi backlog yang menunggu dan memerah begitu melewati 10 berkas atau 14 hari — sinyal bahwa rilis sudah jatuh tempo, bukan kesalahan yang perlu diminta maaf. Seorang maintainer lalu menjalankan `bun run release`, yang melipat changeset yang menunggu ke `CHANGELOG.md`, menaikkan `package.json`, dan (dengan `--commit`) menandai tag `vX.Y.Z`.

## Definition of Done

- [ ] Perubahan terbatas pada satu workspace (atau secara eksplisit, sengaja, lebih dari satu) — lihat "Batas workspace" di atas.
- [ ] `bun install` meresolusi dengan bersih.
- [ ] `bun test` dari akar hijau, dan — bila perubahan menyentuh `apps/cms/` — `bun run check:cms` juga hijau.
- [ ] `bun run audit:dokumen`, `bun run audit:rilis`, dan `bun run audit:translation` hijau.
- [ ] Dokumen governance baru, atau perubahan pada yang sudah ada, mengirim cermin Indonesianya di perubahan yang sama (`bun run docs:i18n:stamp` menulis banner dan penanda hash-nya).
- [ ] Sebuah changeset ditulis saat perubahan memengaruhi perilaku publik, struktur workspace, dependency, atau deployment.
- [ ] Variabel env baru yang dibaca skrip tingkat akar didokumentasikan di `.env.example`.
- [ ] PR yang menyinkronkan `apps/cms/` dari upstream di-merge dengan merge commit — lihat "Penyematan subtree" di atas.
- [ ] Dokumentasi yang menjelaskan perilaku yang berubah diperbarui di perubahan yang sama — di repo ini, dokumentasi adalah bagian dari deliverable, bukan susulan.

## Bahasa

Bahasa Inggris di jalur telanjang adalah sumber otoritatif; Bahasa Indonesia di `<nama>.id.md` adalah cerminnya, mencatat hash dari bahasa Inggris yang diterjemahkannya. Cermin dokumen ini adalah [`AGENTS.id.md`](AGENTS.id.md).

Kode repo ini sendiri — `packages/gerbang/`, `tools/`, `tests/`, beserta identifier, komentar, dan pesan gerbang/tesnya — ditulis dalam **Bahasa Inggris** sepenuhnya. Ini pilihan yang disengaja untuk kode baru repo ini sendiri, dibuat karena tidak ada konvensi yang sudah ada di sini untuk diikuti dan Bahasa Inggris adalah bawaan yang lebih aman untuk perkakas yang dibaca langsung oleh CI, Dependabot, dan editor kontributor mana pun di masa depan. `apps/cms` membawa konvensinya sendiri yang terpisah sebagai kode `ahliweb/awcms` yang disematkan; repo ini tidak mengatur atau mengubahnya.
