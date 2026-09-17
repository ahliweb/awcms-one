🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

# Skill root awcms-one

Panduan praktis untuk pekerjaan milik repositori ini sendiri, milik root — bukan skill milik `apps/cms` sendiri (`apps/cms/.claude/skills/`, konvensi milik `ahliweb/awcms` sendiri, dibawa oleh subtree embed dan di luar cakupan indeks ini).

| Skill | Gunakan saat |
| --- | --- |
| [`awcms-one-storefront`](awcms-one-storefront/SKILL.md) | Menambah atau mengubah halaman/rute di `apps/storefront` — pemisahan statis/runtime, build berbasis stub, CSP yang diturunkan |
| [`awcms-one-commerce`](awcms-one-commerce/SKILL.md) | Menambah tabel, endpoint, atau layar admin ke modul `commerce` milik `apps/cms` — satu modul bukan tiga, RLS, dua keanehan `Bun.SQL`, pemisahan API anonim-vs-owner |

Keduanya ditulis untuk issue #31 (penyegaran dokumentasi increment-2) terhadap tree sebagaimana tergabung setelah issue #22–#30 — lihat [`docs/arsitektur.md`](../../docs/arsitektur.id.md) dan [`docs/adr/`](../../docs/adr/README.id.md) untuk keputusan yang diasumsikan masing-masing.
