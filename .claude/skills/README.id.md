🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

# Skill root awcms-one

Panduan praktis untuk pekerjaan milik repositori ini sendiri, milik root — bukan skill milik `apps/cms` sendiri (`apps/cms/.claude/skills/`, konvensi milik `ahliweb/awcms` sendiri, dibawa oleh subtree embed dan di luar cakupan indeks ini).

| Skill | Gunakan saat |
| --- | --- |
| [`awcms-one-storefront`](awcms-one-storefront/SKILL.md) | Menambah atau mengubah halaman/rute di `apps/storefront` — pemisahan statis/runtime, build berbasis stub, CSP yang diturunkan, dan (sejak increment 6) group profil build mana yang cocok untuk sebuah halaman |
| [`awcms-one-commerce`](awcms-one-commerce/SKILL.md) | Menambah tabel, endpoint, atau layar admin ke modul `commerce` milik `apps/cms` — satu modul bukan tiga, RLS, dua keanehan `Bun.SQL`, pemisahan API anonim-vs-owner |
| [`awcms-one-template`](awcms-one-template/SKILL.md) | Memulai aplikasi baru dari repositori ini sebagai template GitHub — memilih profil build, menjalankan `bun run template:init`, menyemainya, dan apa yang diperiksa sesudahnya |

`awcms-one-storefront` dan `awcms-one-commerce` ditulis untuk issue #31 (penyegaran dokumentasi increment-2) terhadap tree sebagaimana tergabung setelah issue #22–#30, dan diperbarui untuk profil build increment 6; `awcms-one-template` ditambahkan oleh increment 6 (epic [#135](https://github.com/ahliweb/awcms-one/issues/135)). Lihat [`docs/arsitektur.md`](../../docs/arsitektur.id.md) dan [`docs/adr/`](../../docs/adr/README.id.md) untuk keputusan yang diasumsikan masing-masing.
