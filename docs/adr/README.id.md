🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:71ee8472d3e81956d469719cf447b99954d3ae4d864dac7b19880d82308abef9 -->

# Architecture Decision Records

Catatan keputusan dan penalaran di baliknya — ditulis agar usulan yang sudah diargumentasikan dan diselesaikan tidak muncul lagi enam bulan kemudian tanpa ada yang ingat mengapa itu berakhir seperti itu.

Perubahan di repositori ini butuh ADR ketika ia:

- mengubah bentuk output (statis ↔ server, bentuk URL);
- mengubah postur keamanan (kredensial runtime baru, RLS, CSP);
- menambah dependensi runtime atau layanan pihak ketiga;
- membalikkan salah satu keputusan di bawah ini;
- memutuskan arah impor, representasi data, atau strategi embedding yang kemudian dijadikan asumsi oleh seluruh basis kode.

Yang **tidak** butuh ADR: menambah field dalam skema yang sudah diputuskan, kenaikan dependensi rutin, tes, penyuntingan salinan.

| # | Keputusan | Status |
| --- | --- | --- |
| [0001](0001-git-subtree-with-full-history-for-apps-cms.md) | `apps/cms` adalah `ahliweb/awcms`, di-embed lewat `git subtree` dengan riwayat lengkap | Diterima |
| [0002](0002-static-output-with-build-time-fetch-for-the-storefront.md) | Storefront adalah `output: "static"`, mengambil katalog saat build | Diterima |
| [0003](0003-money-is-numeric-14-2-and-crosses-the-wire-as-a-string.md) | Uang adalah `numeric(14,2)`, dan melintasi jaringan sebagai string | Diterima |
| [0004](0004-a-type-only-contract-package-with-an-import-direction-gate.md) | `packages/kontrak` adalah kontrak type-only, dengan gate yang menjaga arah impor satu jalur | Diterima |
| [0005](0005-product-urls-match-the-live-sites-shape.md) | URL produk mengikuti bentuk situs live: `/product/{slug}`, tanpa trailing slash, `/products` dialihkan | Diterima |
| [0006](0006-a-federated-knowledge-graph-that-never-duplicates-the-subtree.md) | Graf pengetahuan federasi: dimiliki root, code-only, tidak pernah menduplikasi milik `apps/cms` | Diterima |

## Mengapa penomoran dimulai dari 0001

Berbeda dari `ahliweb/media-lenterakalteng` (yang korpus ADR-nya melanjutkan penomoran template referensi dari 0014), korpus ADR repositori ini adalah miliknya sendiri sejak awal — `apps/cms` membawa penomoran ADR milik `ahliweb/awcms` sendiri, terpisah, di bawah `apps/cms/docs/adr/`, untuk tree-nya sendiri; itu bukan milik indeks ini untuk dilanjutkan atau dikutip dengan nomor telanjang (kutipan atas salah satu ADR milik `apps/cms` sendiri ditulis dengan penanda — `awcms`, "reference repo", atau tautan GitHub — persis agar [`bun run audit:dokumen`](../../AGENTS.md#the-gates) bisa membedakan dua ruang penomoran itu).

## Tabel ini dijaga

`bun run audit:dokumen` mensyaratkannya lengkap di dua arah — setiap berkas ADR di direktori ini tercatat di sini, setiap baris menunjuk ke berkas yang ada — tanpa baris duplikat, dan mensyaratkan kolom Status sepakat dengan baris `- **Status:**` di dalam berkas ADR itu sendiri. Ia berjalan di CI pada setiap push, tidak butuh build dan tidak butuh jaringan, dan — per koreksi yang dicatat riwayat salinan gate ini sendiri milik `media-lenterakalteng` — persyaratan yang sama berlaku untuk berkas mirror ini sendiri, bukan hanya sumber Inggrisnya, [`README.md`](README.md): hash gate terjemahan menjaga mirror ini seusia dengan sumbernya, bukan benar terhadap isi direktori ini yang sebenarnya, jadi `audit:dokumen` memeriksa tabel di berkas ini juga, secara independen dari sumbernya.
