🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](CONTRIBUTING.md)

<!-- i18n-source-hash: sha256:0b4fd47eb06cc8061630ca6b9309c6bf156398ba345b9d405b4b4619db4abe54 -->

# Panduan Kontribusi

Terima kasih atas niat Anda untuk membantu. Sebelum yang lain: repo ini me-re-platform toko komersial borneojek-mart ke stack AWCMS ([issue #1](https://github.com/ahliweb/awcms-one/issues/1)), dan menyematkan `ahliweb/awcms` utuh sebagai `apps/cms` lewat `git subtree`. Baca [`AGENTS.md`](AGENTS.md) sebelum menyentuh apa pun — ia adalah kontrak kerja yang mengikat, bukan ringkasan, dan memuat satu aturan (syarat merge commit untuk subtree) yang mudah dilanggar karena kebiasaan dan mahal untuk dipulihkan.

Kontributor agen AI: `AGENTS.md` ditulis untuk Anda sama seriusnya dengan untuk manusia. Baca dulu, sampai tuntas.

## Menyiapkan lingkungan

```bash
bun --version          # >= 1.3.0, sesuai engines.bun
cp .env.example .env
bun install
bun test                # rangkaian gerbang akar
```

| Perintah | Kegunaan |
| --- | --- |
| `bun install` | Meresolusi seluruh workspace |
| `bun test` | Rangkaian gerbang akar (mengecualikan `apps/cms/**`, yang butuh PostgreSQL hidup — lihat `bunfig.toml`) |
| `bun run check:lockfile` | Membuktikan `bun.lock` cocok dengan `package.json` setiap workspace |
| `bun run audit:dokumen` | Tautan mati, indeks ADR, jalur yang disebut, kutipan ADR, hitungan tertaut di seluruh markdown repo ini |
| `bun run audit:rilis` | Backlog changeset yang menunggu |
| `bun run audit:translation` | Cermin Indonesia yang basi atau hilang |
| `bun run docs:i18n:stamp` | Menulis banner bahasa + penanda hash sumber pada cermin sebuah dokumen |
| `bun run check:cms` | Rangkaian gerbang penuh `apps/cms` sendiri — lihat `apps/cms/AGENTS.md` |
| `bun audit` | Kerentanan rantai dependency |
| `bun run release` | Memotong rilis bertag dari changeset yang menunggu (tindakan maintainer) |

Skrip akar `dev`/`build`/`check`/`serve` mendelegasikan ke `apps/storefront` (`cd apps/storefront && bun run <skrip>`) — workspace itu sudah membawa seluruh situs publik dan rangkaian gerbangnya sendiri sejak increment 2 ([issue #5](https://github.com/ahliweb/awcms-one/issues/5)).

## Alur kontribusi

1. **Mulai dari sebuah issue** dengan cakupan yang jelas — pilih yang paling sesuai di antara [formulir issue](.github/ISSUE_TEMPLATE/): **Bug report**, **Feature request**, atau **Upstream sync (apps/cms)**. Issue kosong tetap tersedia untuk apa pun yang tidak cocok dengan salah satu dari ketiganya, misalnya sebuah epic yang mencakup beberapa child issue.
2. **Branch dari `main` sebelum menyentuh berkas apa pun.** Jangan commit langsung ke `main`.
3. **Satu iterasi = satu cakupan atomik**, terbatas pada satu workspace kecuali perubahannya memang tentang lebih dari satu — lihat "Workspace boundaries" di `AGENTS.md`. Selesaikan dan validasi sebelum berpindah.
4. **Perbarui dokumentasi** di iterasi yang sama saat perilaku, alur kerja, struktur, atau konfigurasi berubah. Dokumen governance ikut mengirim cermin Indonesianya di perubahan yang sama (`bun run docs:i18n:stamp`).
5. **Tulis sebuah changeset** di [`.changesets/`](.changesets/README.md) di iterasi yang sama, bukan dikumpulkan di akhir.
6. **Jalankan `bun test`** (dan `bun run check:cms` bila perubahan menyentuh `apps/cms/`); keduanya harus bersih.
7. **Buka Pull Request** dengan `Closes #<issue>`, mengisi [`.github/pull_request_template.md`](.github/pull_request_template.md) — GitHub sudah mengisinya lebih dulu, dan daftar periksanya mengulang Definition of Done dari bagian ini. Merge setelah review dan CI hijau.
8. **Bila PR menyinkronkan `apps/cms/` dari upstream** (`git subtree pull`), ia **wajib** di-merge dengan merge commit — jangan pernah di-squash, jangan pernah di-rebase. "The subtree embed" di `AGENTS.md` menjelaskan alasannya. Ini kini juga berlaku secara mekanis untuk setiap PR di repositori ini: squash dan rebase merge dinonaktifkan di seluruh repositori (issue #149), jadi merge commit adalah satu-satunya metode yang ditawarkan tombol merge GitHub.
9. **Saat backlog changeset yang menunggu jatuh tempo** (`bun run audit:rilis` memerah melewati 20 berkas atau 14 hari), seorang maintainer menjalankan `bun run release`, yang melipat backlog ke `CHANGELOG.md` dan menandai tag `vX.Y.Z`.

### Penamaan branch

`feat/<slug>`, `fix/<slug>`, `docs/<topik>`, `chore/<slug>`, `translation/<locale>-<slug>`.

### Konvensi commit

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <ringkasan>`.

| Type | Untuk |
| --- | --- |
| `feat` | Kemampuan baru |
| `fix` | Mengoreksi perilaku yang salah |
| `translation` | Mengisi atau menyunting cermin locale |
| `docs` | Dokumentasi |
| `chore` | Dependency, konfigurasi, perkakas |
| `refactor` | Perubahan bentuk kode tanpa perubahan perilaku |

Isi commit menjelaskan **kenapa**, bukan mengulang diff.

## Kepemilikan kode

[`.github/CODEOWNERS`](.github/CODEOWNERS) menetapkan `@ahliweb` sebagai pemilik default untuk seluruh repo, ditambah baris rute eksplisit untuk `apps/cms/` (pekerjaan subtree upstream), `.github/`, `packages/gerbang/`, `tools/`, dan `docs/adr/`. Repo ini punya satu maintainer, dan branch protection tidak mewajibkan review dari code owner sebelum merge — berkas ini bersifat advisory, menggerakkan rute permintaan review milik GitHub sendiri dan daftar "Code owners" di UI PR, bukan gerbang merge.

## Aturan yang tidak bisa ditawar

Rincian lengkap dan alasannya: [`AGENTS.md`](AGENTS.md). Yang paling sering dilanggar tanpa disadari — karena melanggarnya tidak pernah menggagalkan build dengan sendirinya:

- **PR `git subtree pull` di-merge dengan merge commit, tidak pernah di-squash atau di-rebase.**
- **Tidak ada yang di luar `apps/cms/` bergantung pada internalnya** — hanya API publiknya, yang dipanggil `apps/storefront`.
- **Sebuah gerbang di akar tetap agnostik-workspace.** Pemeriksaan yang spesifik untuk satu workspace masuk ke rangkaian gerbang workspace itu sendiri.
- **`bun.lock` diregenerasi utuh**, tidak pernah disunting tangan: `rm -rf node_modules bun.lock && bun install`.

## Terjemahan

Dokumen governance repo ini mengikuti sumber-Inggris, cermin-Indonesia: jalur telanjang (`README.md`) adalah otoritatif, `<nama>.id.md` adalah cerminnya, dan `bun run audit:translation` gagal saat hash tercatat sebuah cermin tidak lagi cocok dengan sumbernya. `bun run docs:i18n:stamp` menulis banner dan penandanya setelah Anda menerjemahkan dengan tangan — ia tidak menerjemahkan untuk Anda.

Kode repo ini sendiri (`packages/gerbang/`, `tools/`, `tests/`) ditulis dalam bahasa Inggris dan tidak dicerminkan; lihat bagian "Language" di `AGENTS.md`. `apps/cms` membawa konvensi terjemahannya sendiri yang terpisah sebagai kode `ahliweb/awcms` yang disematkan.

## Definition of Done

Daftar lengkap dan mengikat ada di [`AGENTS.md`](AGENTS.md#definition-of-done). Ringkasnya:

- [ ] Cakupan atomiknya terpenuhi; tidak ada perubahan tak terkait yang ikut menumpang.
- [ ] `bun test` hijau (dan `bun run check:cms` juga, bila `apps/cms/` disentuh).
- [ ] `bun run audit:dokumen`, `bun run audit:rilis`, dan `bun run audit:translation` hijau.
- [ ] Sebuah changeset ditulis saat perubahan memengaruhi perilaku publik, struktur, dependency, atau deployment.
- [ ] Dokumentasi yang menjelaskan perilaku yang berubah diperbarui bersamanya, termasuk cerminnya.

## Melaporkan masalah

- Kerentanan keamanan: [`SECURITY.md`](SECURITY.md) — jangan buka issue publik.
- Bug dan pertanyaan: [`SUPPORT.md`](SUPPORT.md).
- Perilaku kontributor: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
