🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:b72283839a3faf5782b2e090267d0152df2c18579c93b9c6afcc2fbf13a8db3e -->

# Changesets

Satu berkas per perubahan, ditulis di iterasi yang sama dengan perubahannya sendiri. Tujuannya sederhana: saat sebuah rilis diberi versi, catatannya sudah ada, ditulis oleh orang yang paling memahami konteksnya — bukan direkonstruksi dari `git log` berbulan-bulan kemudian.

## Kapan sebuah changeset dibutuhkan

Perubahan yang memengaruhi perilaku publik, struktur workspace, dependency, atau deployment. Perbaikan typo tanpa perubahan makna tidak membutuhkannya.

## Format

Nama berkas: `YYYY-MM-DD-ringkasan-dalam-kebab-case.md`.

```markdown
---
bump: major | minor | patch
type: content | structure | fix | dependency | docs
impact: public | internal
---

# Judul singkat

Apa yang berubah dan **kenapa**. "Kenapa" adalah separuh yang berharga —
"apa" bisa dibaca dari diff, "kenapa" tidak bisa.

- Sebuah titik perubahan yang akan disadari pembaca atau operator.
- Sebuah titik perubahan yang hanya terasa saat mengembangkan.
```

## `bump` yang menentukan versi

Inilah field yang dibaca rilis. Versi berikutnya adalah `bump` **terbesar** di antara changeset yang menunggu: satu `minor` di antara sembilan entri `patch` membuat seluruh rilis menjadi `minor`.

| `bump` | Di repo ini, artinya | Contoh |
| ------- | ----------------------- | -------- |
| `major` | sebuah kontrak publik rusak — bentuk ekspor sebuah paket yang terbit, API publik sebuah workspace, sebuah flag CLI yang terdokumentasi | kontrak exit-code sebuah gerbang berubah |
| `minor` | sesuatu bertambah: gerbang baru, skrip baru, workspace baru, kemampuan baru | `packages/kontrak` mendarat |
| `patch` | perbaikan yang tidak mengubah bentuk apa pun | typo, kenaikan dependency, pesan gerbang yang dikoreksi |

Pilih **saat menulis perubahannya**, satu-satunya momen semua orang benar-benar tahu jawabannya. Tingkat yang diputuskan belakangan, oleh siapa pun yang kebetulan menjalankan skrip rilis, adalah tingkat yang diputuskan dari daftar nama berkas alih-alih dari perubahannya sendiri — persis kegagalan yang konvensi ini ada untuk dihindari.

Dua aturan mengikuti dari `bump` yang krusial ini, keduanya ditegakkan `tests/versi-changeset.test.mjs`:

- **Changeset tanpa `bump` yang sah menggagalkan gerbang.** Bukan karena field ini sekadar administrasi, melainkan karena kegagalan yang dicegahnya tidak terlihat: changeset yang tidak bisa dibaca rilis berhenti menyumbang ke versi dan tidak ada yang tampak salah.
- **`bun run release` boleh diberi tahu sebuah tingkat, dan hanya boleh yang LEBIH BESAR.** Seorang perilis yang tahu perubahannya lebih besar dari yang diakui changeset-nya boleh menyatakannya; yang lebih kecil ditolak, karena itu menerbitkan perubahan yang merusak sesuatu di balik angka yang menjanjikan tidak ada yang rusak.

Versi berbentuk `MAJOR.MINOR.PATCH`, ditandai `vX.Y.Z`. Repo ini masih `0.x`, di mana semver sendiri tidak membuat janji kompatibilitas apa pun — `bump` mencatat niat sekarang supaya catatannya sudah benar saat `1.0.0` menjadikannya mengikat.

## Backlog punya dua batas

`bump` menentukan seberapa besar sebuah rilis; ia tidak pernah menentukan **kapan**. `bun run audit:rilis` membatasi backlog yang menunggu di direktori ini dan berjalan di CI bersebelahan dengan gerbang lain:

| Batas | Nilai |
| --- | --- |
| Berkas menunggu | **20** |
| Usia yang tertua | **14 hari** |

Batas jumlah semula 10, sampai increment 3 (PR #76): satu increment menumpuk delapan belas changeset sebelum rilisnya sendiri, sehingga 10 memerahkan setiap PR di paruh kedua tanpa ada yang bisa dilakukan kontributor. 20 adalah ukuran terukur satu rilis increment ditambah ruang lega — masih cukup rendah agar tumpukan yang tidak dirilis siapa pun tetap terlihat. Batas umur tetap 14 hari; umurlah, bukan jumlah, yang menangkap tumpukan yang tak terawasi (lihat docblock `packages/gerbang/audit-rilis.mjs` sendiri).

Nama berkas adalah yang membawa usianya, jadi `YYYY-MM-DD-` **wajib, bukan sekadar didokumentasikan**: nama yang tidak bisa ditanggali gerbang ini tidak pernah menua, dan ia akan duduk di sini tak terlihat oleh satu-satunya pemeriksa yang dibangun untuk melihatnya. Tanggal yang tidak dimiliki kalender (`2026-02-31`) ditolak, begitu juga yang lebih dari satu hari di depan mesin yang memeriksanya — satu hari kelonggaran, karena penulis menamai berkasnya di zona waktunya sendiri dan CI memegang UTC.

Melewati sebuah batas bukan kesalahan yang perlu dimintakan maaf — itu sinyal bahwa `bun run release --apply` sudah jatuh tempo. Skrip rilis tidak menjalankan gerbang ini, karena melipat changeset itulah yang justru membersihkannya.

## Catatan

Berkas di sini dilipat ke [`CHANGELOG.md`](../CHANGELOG.md) oleh `bun run release`, lalu dihapus. Judulnya diturunkan dua tingkat agar bersarang rapi di bawah heading versi.

**Tautan relatif ditulis dari sudut pandang `.changesets/`.** Skrip rilis menulis ulang jalur itu ke sudut pandang akar repo saat melipatnya — `../docs/x.md` menjadi `docs/x.md`. `bun run audit:dokumen` meresolusi setiap tautan dari lokasi berkas yang memuatnya, jadi aturan yang sama diperiksa tanpa pengecualian khusus untuk direktori ini.

Changeset sendiri **tidak** dicerminkan ke Bahasa Indonesia, berbeda dari dokumen lain di sini: ia efemeral karena rancangannya — dilipat ke changelog dan dihapus saat rilis — jadi sebuah cermin akan bertahan lebih lama dari sumbernya tepat satu rilis. README ini adalah dokumen seperti yang lain, dan dicerminkan.
