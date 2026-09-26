🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](README.md)

<!-- i18n-source-hash: sha256:8226532a599100f817af3dd2633715ce3918ba91040976233852bd888dd54e73 -->

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
| [0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.md) | Keranjang, checkout, dan pelacakan pesanan tetap statis; browser memanggil endpoint commerce anonim milik CMS langsung | Diterima |
| [0008](0008-one-commerce-module-carries-the-whole-store-not-three.md) | Satu modul `commerce` membawa seluruh toko, bukan tiga | Diterima |
| [0009](0009-guest-checkout-by-order-code-and-phone.md) | Checkout tamu, dialamatkan lewat kode pesanan + telepon; akun pelanggan menyusul kemudian | Diterima |
| [0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md) | Pembayaran manual dan kurir alternatif lebih dulu; gateway dan agregator datang lewat outbox | Diterima |
| [0011](0011-storefront-media-resolves-through-the-media-objects-endpoint.md) | Storefront me-resolve media lewat `GET /api/v1/media/objects`, dan CSP-nya diturunkan dari apa yang benar-benar ter-resolve | Diterima |
| [0012](0012-first-party-visitor-analytics-with-an-opt-in-ga4-switch.md) | Analitik pengunjung bersifat first-party secara bawaan; GA4 adalah sakelar opt-in | Diterima |
| [0013](0013-rule-based-legacy-redirects-beside-the-row-based-map.md) | Pengalihan lawas berbasis aturan berdampingan dengan peta berbasis baris, dan baris selalu menang | Diterima |
| [0014](0014-the-institution-owns-the-emblem-not-the-post.md) | Lembaga yang memiliki lambangnya; sebuah pos tidak pernah membawa satu pun | Diterima |
| [0015](0015-commerce-migrations-live-in-the-reserved-9xx-range.md) | Migrasi commerce hidup di rentang cadangan `9xx` | Diterima |
| [0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md) | Akun pelanggan adalah akun `commerce` terverifikasi OTP dengan sesi bearer | Diterima |
| [0017](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md) | Provider eksternal adalah port milik `commerce`, dengan kredensial per-deployment dari env dan webhook beralamat token | Diterima |
| [0018](0018-awcms-one-is-a-template-with-build-profiles-and-an-idempotent-init.md) | awcms-one adalah sebuah template, dengan profil build dan `template:init` yang idempoten | Diterima |
| [0019](0019-production-topology-two-images-a-jobs-sidecar-and-a-fail-closed-preflight.md) | Topologi produksi: dua image, satu sidecar jobs, dan preflight fail-closed | Diterima |
| [0020](0020-publish-only-the-cms-images-to-ghcr-with-sbom-and-provenance.md) | Hanya image CMS yang dipublikasikan ke GHCR, dengan SBOM dan provenance | Diterima |
| [0021](0021-zero-github-actions-local-ci-with-exact-sha-statuses.md) | Nol GitHub Actions: CI lokal dengan status komit ber-SHA-eksak | Diterima |
| [0022](0022-production-deployment-is-server-side-and-explicit.md) | Deployment produksi bersifat server-side dan eksplisit | Diterima |
| [0023](0023-release-images-are-built-signed-and-published-from-a-trusted-release-host.md) | Image rilis dibangun, ditandatangani, dan dipublikasikan dari release host tepercaya | Diterima |

## Mengapa penomoran dimulai dari 0001

Berbeda dari `ahliweb/media-lenterakalteng` (yang korpus ADR-nya melanjutkan penomoran template referensi dari 0014), korpus ADR repositori ini adalah miliknya sendiri sejak awal — `apps/cms` membawa penomoran ADR milik `ahliweb/awcms` sendiri, terpisah, di bawah `apps/cms/docs/adr/`, untuk tree-nya sendiri; itu bukan milik indeks ini untuk dilanjutkan atau dikutip dengan nomor telanjang (kutipan atas salah satu ADR milik `apps/cms` sendiri ditulis dengan penanda — `awcms`, "reference repo", atau tautan GitHub — persis agar [`bun run audit:dokumen`](../../AGENTS.md#the-gates) bisa membedakan dua ruang penomoran itu).

## Tabel ini dijaga

`bun run audit:dokumen` mensyaratkannya lengkap di dua arah — setiap berkas ADR di direktori ini tercatat di sini, setiap baris menunjuk ke berkas yang ada — tanpa baris duplikat, dan mensyaratkan kolom Status sepakat dengan baris `- **Status:**` di dalam berkas ADR itu sendiri. Ia berjalan di CI pada setiap push, tidak butuh build dan tidak butuh jaringan, dan — per koreksi yang dicatat riwayat salinan gate ini sendiri milik `media-lenterakalteng` — persyaratan yang sama berlaku untuk berkas mirror ini sendiri, bukan hanya sumber Inggrisnya, [`README.md`](README.md): hash gate terjemahan menjaga mirror ini seusia dengan sumbernya, bukan benar terhadap isi direktori ini yang sebenarnya, jadi `audit:dokumen` memeriksa tabel di berkas ini juga, secara independen dari sumbernya.
