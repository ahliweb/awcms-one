🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0017-external-providers-are-commerce-owned-ports-with-env-credentials-and-token-addressed-webhooks.md)

<!-- i18n-source-hash: sha256:77f8a6ad37b7471adeef4399cee2e5e5b7255918f8cd2298b2bb0333d52f9c8c -->

# ADR-0017 — Provider eksternal adalah port milik `commerce`, dengan kredensial per-deployment dari env dan webhook beralamat token

- **Status:** Diterima
- **Tanggal:** 19 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0010](0010-manual-payment-and-alternative-courier-first-gateways-via-outbox.md), [ADR-0016](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md); `apps/cms`'s [ADR-0006](../../apps/cms/docs/adr/0006-offline-first-sync-outbox.md) (larangan memanggil provider di dalam transaksi DB), [awcms ADR-0074](../../apps/cms/docs/adr/0074-push-delivery-is-a-second-outbox.md) (kredensial per deployment, tidak pernah per tenant); issue #33, #106, #107–#118

## Konteks

ADR-0010 sudah menamai bentuknya tapi menunda substansinya: "RajaOngkir dan payment gateway adalah provider eksternal dan — sesuai aturan baku `apps/cms` — harus dipanggil lewat outbox, tidak pernah sinkron di jalur order; itu adalah #33, masing-masing dengan ADR-nya sendiri." ADR-0016 mengirimkan kontrak akun yang sekarang menjadi fondasi kanal WhatsApp #33 serta permukaan POS/laporan/kotak masuk/kampanye. ADR ini adalah wave 0 dari #33 (increment 5): mencatat sepuluh keputusan arsitektural (D1–D10) yang seluruh increment ini dikodekan terhadapnya, dan mengirimkan kontrak OpenAPI yang mengikuti dari keputusan itu dalam perubahan yang sama (issue #106) — setiap path didokumentasikan sebelum handler-nya ada, persis seperti ADR-0016 lakukan untuk #86, sehingga C1–C9 (issue #107–#118) dibangun di atas kontrak yang sudah diperdebatkan dan disepakati, bukan diputuskan ulang per issue.

Lima provider yang benar-benar berbeda masuk cakupan sekaligus (payment gateway, API tarif kurir, dua pengirim WhatsApp, dan — secara struktural — permukaan kotak masuk/kampanye yang agnostik provider tapi berbagi disiplin outbox yang sama). Memutuskan bentuknya lima kali terpisah akan menghasilkan lima jawaban yang sedikit berbeda untuk tiga pertanyaan yang sama: di mana kodenya hidup, bagaimana kredensial dipasok, dan bagaimana callback masuk menemukan tenant yang benar. ADR ini menjawab ketiganya sekali saja.

## Keputusan

### D1 — Pola integrasi: port + adapter di dalam `commerce`, mengikuti model `email`

Setiap provider eksternal yang ditambahkan increment ini adalah port + adapter **di dalam modul `commerce`** — bukan modul top-level baru, bukan dialihkan lewat `integration_hub`. Setiap keluarga provider memiliki tabel outbox dan job dispatcher-nya sendiri (bentuk CLAIM → CALL (di luar transaksi apa pun) → FINALIZE yang sama yang sudah dibuktikan tiga kali oleh `email-dispatch.ts`/`object-dispatch.ts` — lihat skill `awcms-integration`), mengirimkan adapter `log` untuk dev/CI berdampingan dengan adapter aslinya (aturan "provider mati tetap jalan" yang sama yang sudah diikuti `email`/`push_delivery`), membaca kredensialnya HANYA dari lingkungan, **satu set per deployment** (tidak pernah per tenant — alasan awcms ADR-0074 sendiri: kredensial dari tenant memungkinkan admin satu tenant membuat deployment ini bicara sebagai orang lain), membungkus setiap panggilan keluar dengan `withTimeout` dan `getProviderCircuitBreaker(providerKey)`, dan tidak pernah memanggil provider dari dalam transaksi DB (ADR-0006/ADR-0010).

| Dimensi | **Port + adapter di dalam `commerce` (dipilih)** | Menerima `integration_hub` lebih dulu | Kredensial per tenant |
| --- | --- | --- | --- |
| Keamanan | Tetap di dalam batas RLS/permission yang sudah dimiliki `commerce`; satu rahasia per deployment untuk dirotasi per provider, bukan satu per tenant | `integration_hub` adalah modul spesifikasi upstream yang belum diterima repo ini; menariknya masuk untuk lima provider sekaligus adalah permukaan yang jauh lebih besar dan kurang tereview untuk dipercaya dalam satu langkah | Admin tenant sendiri menjadi permukaan manajemen kredensial; kredensial tenant yang bocor atau jahat bisa dipakai mengirim sebagai deployment ini ke provider yang mempercayainya |
| Performa | Tidak ada panggilan lintas modul di jalur panas (checkout, OTP); pola dispatcher yang sudah ada memenuhi SLO outbox repo ini | ADR admisi, divergensi subtree, dan berminggu-minggu kerja integrasi sebelum adapter pertama jadi — murni latensi menuju pengiriman, bukan latensi runtime | Tidak ada beda saat waktu request; menambah langkah dekripsi-per-kredensial-tenant di setiap dispatch |
| Kemudahan pemeliharaan | Satu lagi instance dari pola yang sudah punya tiga contoh kerja di basis kode ini; tidak ada batas modul baru untuk dipikirkan | `integration_hub` adalah spesifikasi upstream sendiri; menerimanya di tengah increment berarti merekonsiliasi bentuknya dengan tabel outbox `commerce` yang sudah ada, menggandakan permukaan desain | Setiap provider butuh CRUD kredensial per tenant sendiri, validasi, dan UI penyamaran — lima kali lipat |
| Skalabilitas | Berskala dengan tabel-tabel `commerce` sendiri yang tenant-scoped, sama seperti outbox lain di sini | Tidak diketahui — belum ada review admisi, jadi properti skalanya di basis kode INI belum terbukti | Tabel kredensial berbasis tenant tumbuh linear dengan jumlah tenant terlepas dari tenant mana yang benar-benar memakai provider tertentu |
| Aksesibilitas | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| SEO | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| UI/UX | Merchant melihat satu layar pengaturan per fitur (D10), bukan wizard "hubungkan akun Midtrans Anda sendiri" terpisah yang belum pernah dibangun repo ini | Bergantung sepenuhnya pada bentuk permukaan admin `integration_hub` sendiri — belum direview | Setiap admin tenant harus memperoleh dan menempelkan rahasia provider mereka sendiri dengan benar — beban dukungan nyata yang belum pernah ditanggung basis kode ini |
| Kompatibilitas | Cocok dengan kata-kata ADR-0010 sendiri ("lewat outbox") dan preseden awcms ADR-0074 (kredensial per deployment) — ini adalah bab lanjutan preseden itu, bukan yang baru | Tidak ada yang di basis kode ini hari ini terintegrasi dengan `integration_hub` — tidak ada kisah kompatibilitas untuk diwarisi | BjekMart, deployment referensi, memakai SATU akun Midtrans/RajaOngkir/Fonnte untuk seluruh toko — memodelkan kredensial per tenant menjawab pertanyaan yang tak seorang pun tanyakan |
| Kompleksitas operasional | Lima keluarga provider, lima tabel outbox, lima job dispatcher — bentuk yang sama yang sudah dipahami ops cara menjalankan, mencoba ulang, dan memantaunya | Proses admisi modul baru, plus lima adapter dibangun mengikuti konvensi modul yang belum familiar | Rotasi kredensial kini jadi operasi per tenant, bukan per deployment; rahasia yang bocor memerlukan pemberitahuan dan rotasi untuk setiap tenant terdampak secara terpisah |
| Jangka panjang | Admisi `integration_hub` di masa depan (jika pernah terjadi) tetap bisa menyerap port ini nanti — antarmuka port tidak berubah tergantung modul mana yang mengimplementasikannya | Tidak menutup apa pun yang didapat hari ini; biayanya dibayar di muka untuk manfaat yang belum dibutuhkan | Mengunci seluruh increment ke model data (`tenant_id` di setiap baris kredensial) yang tidak dibutuhkan bentuk deployment BjekMart sendiri |

Ditolak: menerima `integration_hub` lebih dulu (modul spesifikasi upstream yang belum dibawa masuk repo ini, dan melakukannya di tengah increment untuk lima provider sekaligus persis jenis jalan memutar berminggu-minggu, memecah-subtree yang sudah diperingatkan ADR-0006 (root) untuk graf pengetahuan federasi — insting "jangan duplikasi/fork tree upstream sendiri" yang sama berlaku di sini); kredensial per tenant (BjekMart adalah satu-satunya deployment yang menjadi tujuan increment ini, dan awcms ADR-0074 sudah menyelesaikan pertanyaan "kredensial per DEPLOYMENT" untuk push — tidak ada alasan kredensial pembayaran/kurir/WhatsApp harus menjawabnya berbeda).

### D2 — Webhook masuk: beralamat token, diresolusi `SECURITY DEFINER`, terlindungi dari replay

Satu `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}` publik adalah SATU-SATUNYA permukaan masuk tempat setiap callback provider mendarat. Tenant diresolusi dari token endpoint opak per tenant (`awcms_commerce_webhook_endpoints`, token disimpan ter-hash, tidak pernah dalam bentuk teks jelas, mengikuti disiplin "nilai mentah disebut di satu berkas saja" yang sama yang dipakai awcms ADR-0074 untuk endpoint push), lewat fungsi bootstrap `SECURITY DEFINER` berbentuk seperti `awcms_resolve_tenant_domain_lookup` yang sudah ada (fungsi yang boleh membaca lintas tenant justru agar request yang belum terautentikasi, pra-tenant, bisa mengetahui tenant MANA miliknya, tanpa memberi role pemanggil `SELECT` lintas tenant yang luas). Tanda tangan provider sendiri diverifikasi timing-safe sebelum apa pun lain terjadi. Perlindungan replay adalah constraint UNIQUE pada `(tenant_id, provider, event_key)` di atas `awcms_commerce_payment_events` — bukan cache di memori, sehingga bertahan dari restart dan bekerja lintas berapa pun instance aplikasi yang berjalan. Body memiliki batas ukuran. Event yang terverifikasi lalu memanggil `markOrderPaidBySystem`, menambah edge `system` baru ke graf status order (`pending_payment → paid`) berdampingan dengan edge `customer`/`admin` yang sudah didefinisikan `order-status.ts`. Karena webhook bisa hilang (partisi jaringan, gangguan provider, deploy mendarat di tengah pengiriman), job rekonsiliasi terpisah `commerce:payments:reconcile` secara berkala melakukan polling sesi gateway yang masih pending — webhook adalah jalur cepat, bukan satu-satunya jalur.

| Dimensi | **Token opak per tenant di URL (dipilih)** | Tenant diresolusi dari payload webhook |
| --- | --- | --- |
| Keamanan | Token itu sendiri adalah kredensial; penyerang yang tidak memilikinya bahkan tidak bisa mencapai baris tenant tertentu, apalagi memalsukan tanda tangan untuknya | Field payload yang mengidentifikasi tenant (kode order, referensi merchant) persis jenis nilai yang dipasok pemanggil yang sudah ditolak penalaran "oracle enumerasi telepon" ADR-0009 — mempercayainya untuk memilih tenant berarti penyerang yang sekadar menebak kode order yang hidup bisa memeriksa tenant mana pemiliknya |
| Performa | Satu pencarian terindeks berdasarkan hash token, kelas biaya sama dengan pencarian `awcms_tenant_domains` sendiri | Biaya pencarian sama, tapi hanya setelah mengurai dan mempercayai field payload yang belum terverifikasi lebih dulu |
| Kemudahan pemeliharaan | Satu fungsi resolusi, dipakai ulang oleh setiap adapter provider (format token tidak berubah antar provider) | Setiap adapter butuh logika "field payload mana yang mengidentifikasi tenant" sendiri, dan masing-masing adalah oracle potensial jika pernah salah |
| Skalabilitas | Berskala identik dengan pola pencarian domain yang sudah dijalankan repo ini pada skala tenant | Tidak ada beda biaya skala, tapi biaya keamanan di atas berskala dengan berapa banyak tenant dan provider yang ditambahkan |
| Aksesibilitas | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| SEO | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| UI/UX | Admin menyalin satu URL (dengan token tertanam) ke dashboard provider sekali saja, lewat layar webhook-endpoints D10 | Tidak ada beda dari sisi merchant, tapi merchant tidak punya cara tahu tenant-nya dijadikan target oracle |
| Kompatibilitas | Cocok dengan preseden `awcms_resolve_tenant_domain_lookup` yang sudah dipercaya basis kode ini untuk "resolusikan tenant sebelum autentikasi ada" | Tidak ada apa pun di basis kode ini hari ini yang meresolusi tenant dari BODY request — bentuk resolusi baru yang belum direview |
| Kompleksitas operasional | Rotasi token adalah `DELETE` + `POST` ulang di layar webhook-endpoints (D10); token yang bocor berhenti bekerja begitu dihapus | Tidak ada kisah rotasi sama sekali — "kredensial"-nya sudah terpanggang di setiap payload yang pernah dikirim provider |
| Jangka panjang | Menambah provider kedua, ketiga, keempat memakai ulang fungsi resolusi token yang identik; biaya onboarding per provider baru adalah satu adapter, bukan satu strategi resolusi tenant baru | Setiap provider baru butuh jawaban teraudit sendiri untuk "field payload mana yang aman dipercaya", selamanya |

Ditolak: tenant dari payload (nilai yang dipasok pemanggil dan belum terverifikasi, dipakai memilih tenant, adalah oracle keberadaan lintas tenant, mode kegagalan yang sama yang sudah disingkirkan ADR-0009 untuk nomor telepon guest checkout).

### D3 — Payment gateway: port `PaymentGatewayProvider`, Midtrans Snap lebih dulu, alur storefront berbasis redirect

```
PaymentGatewayProvider = {
  createSession(order) -> { providerRef, redirectUrl, expiresAt },
  verifyWebhook(request, rawBody) -> { ok, eventKey, providerRef, status },
  fetchStatus(providerRef)
}
```

Adapter yang dikirim adalah **Midtrans Snap**: `createSession` adalah `POST /snap/v1/transactions` sisi server, mengembalikan `redirect_url` halaman hosted-nya; tanda tangan webhook adalah `sha512(order_id + status_code + gross_amount + ServerKey)`. Konfigurasi: `COMMERCE_PAYMENT_GATEWAY=midtrans|none`, `COMMERCE_MIDTRANS_SERVER_KEY`, `COMMERCE_MIDTRANS_IS_PRODUCTION`. Adapter `log` ada untuk dev/CI, sejalan dengan D1. Xendit adalah adapter lanjutan bernama di belakang port yang sama, tidak dibangun di sini.

Alur storefront bersifat **berbasis redirect**: `window.location` milik browser sendiri menavigasi ke halaman hosted Midtrans — tidak ada perubahan CSP `script-src`/`form-action`, karena tidak ada apa pun yang di-embed. `/pesanan?kode=` (halaman pelacakan order yang sudah ada) melakukan polling order setiap 5 detik selagi statusnya `pending_payment`, sehingga pembeli yang kembali dari halaman hosted (atau meninggalkannya dan kembali kemudian) melihat pembayaran mendarat tanpa refresh manual.

| Dimensi | **Redirect ke halaman hosted Midtrans (dipilih)** | Embed Snap.js (widget iframe/JS di `/checkout`) | Handoff form-POST ke gateway |
| --- | --- | --- | --- |
| Keamanan | Tidak ada skrip pihak ketiga yang pernah dieksekusi di halaman origin ini; CSP yang sudah dikirim repo ini (`worker-src` jatuh ke `default-src 'self'`, sesuai angka awcms ADR-0074 sendiri) tetap sesempit hari ini | Membutuhkan origin `script-src`/`frame-src` baru untuk Snap.js — jenis ekspansi origin pihak ketiga yang persis ingin dicegah kontrak "LAN/offline = nol origin pihak ketiga" awcms ADR-0029 | Membutuhkan `form-action` mencakup origin gateway, direktif CSP yang tidak dimiliki kebijakan enam-direktif, nol-origin-pihak-ketiga repo ini saat ini |
| Performa | Satu hop jaringan (redirect itu sendiri); tidak ada byte SDK yang dikirim ke browser sama sekali | Menambah bobot bundle Snap.js sendiri ke halaman checkout, di atas plafon byte per-berkas repo ini (angka gate build awcms ADR-0074 sendiri menunjukkan betapa ketatnya anggaran itu) | Sebanding dengan redirect, tapi handoff berbasis POST tidak bisa jadi `<a>`/`location.assign` biasa, jadi tetap butuh skrip pengiriman form kecil sendiri |
| Kemudahan pemeliharaan | Satu panggilan provider, satu handler webhook; target redirect sepenuhnya halaman milik Midtrans sendiri, jadi perubahan UI Snap di sisi mereka tidak pernah menyentuh basis kode ini | Perubahan UI/perilaku Snap.js apa pun di sisi Midtrans adalah potensi kerusakan di dalam halaman origin INI, baru ditemukan dengan menguji ulang checkout | Bentuk ketiga (target redirect vs widget embed vs target POST) untuk dipelihara berdampingan dengan dua metode pembayaran lain yang sudah didokumentasikan ADR-0010 |
| Skalabilitas | Tidak ada beda pada skala repo ini | Tidak ada beda pada skala repo ini | Tidak ada beda pada skala repo ini |
| Aksesibilitas | Halaman hosted adalah milik Midtrans sendiri, permukaan teraudit; halaman checkout repo ini tidak butuh pekerjaan aksesibilitas tambahan untuknya | Aksesibilitas iframe/widget yang di-embed sepenuhnya di luar kendali repo ini, dan pembaca layar yang melintasi batas iframe adalah titik kasar yang sudah dikenal | Tidak beda dari redirect begitu form auto-submit, tapi fallback JS-nonaktif tetap butuh halaman aksesibel sendiri |
| SEO | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| UI/UX | Handoff `window.location` dan halaman pelacakan polling adalah pola yang sudah dipahami pembeli dari metode pembayaran LAIN BjekMart (bank manual/QRIS juga secara konseptual meninggalkan halaman, untuk memeriksa aplikasi bank) | Menahan pembeli tetap di `/checkout`, bisa dibilang lebih mulus, dengan biaya trade-off CSP/bundle di atas | UX "meninggalkan halaman" sama dengan redirect, tanpa manfaat embed untuk mengimbangi biaya CSP-nya |
| Kompatibilitas | Bekerja identik terlepas dari adapter gateway masa depan (Xendit) apa pun yang ditambahkan di belakang port yang sama — setiap gateway halaman hosted mengekspos URL redirect | Mengikat markup halaman checkout ke API widget spesifik Midtrans; beralih ke Xendit nanti berarti embed berbeda, bukan adapter plug-and-play | Risiko kopling sama dengan opsi embed, untuk alasan berbeda (nama field form spesifik gateway) |
| Kompleksitas operasional | Tidak ada yang baru untuk dioperasikan di luar pola outbox/dispatcher yang sudah ada | Versi widget untuk dilacak dan diperbarui, plus pengecualian CSP untuk dipelihara dan dijustifikasi ulang di setiap tinjauan keamanan | URL target form untuk disinkronkan dengan versi API provider sendiri |
| Jangka panjang | Bentuk kembalian `createSession` port `PaymentGatewayProvider` (`redirectUrl`) agnostik provider — Xendit masuk tanpa menyentuh storefront sama sekali | Mengunci UI halaman checkout ke bentuk SDK satu provider, membatalkan justru portabilitas yang dirancang port ini | Mengunci field form halaman checkout ke bentuk API satu provider, untuk alasan yang sama |

Ditolak: embed Snap.js (origin CSP baru yang tidak dibutuhkan sikap nol-origin-pihak-ketiga repo ini saat ini); handoff form-POST (`form-action 'self'` harus diperluas tanpa manfaat dibanding redirect).

### D4 — Tarif kurir: port `ShippingRateProvider`, adapter RajaOngkir (Komerce API v2), tarif ter-cache 6 jam

```
ShippingRateProvider = {
  getRates({ originId, destinationId, weightGrams, couriers }) -> Rate[]
}
```

Adapter yang dikirim adalah **RajaOngkir**, khususnya bentuk Komerce API v2 (`COMMERCE_RAJAONGKIR_API_KEY`). Tarif di-cache di `awcms_commerce_shipping_rates`, dengan kunci `(tenant, origin, destination, bucket berat 100 g, kurir)`, TTL 6 jam — bentuk "panggilan provider bersifat opsional, jawabannya di-cache" yang sama yang dibutuhkan API tarif langsung ketika duduk di jalur panas yang dihadapi pelanggan. Resolusi tujuan lewat `awcms_commerce_courier_destinations`, memetakan kode distrik `idn_admin_regions` ke id tujuan provider sendiri; pemetaan itu diresolusi SEKALI, lewat pencarian nama terhadap daftar tujuan provider, dan di-cache — tidak diresolusi ulang di setiap quote. Request cart-quote menerima `destination: {districtCode}`; panggilan provider sendiri terjadi dari jalur quote **di luar transaksi apa pun** (ADR-0006), dan kegagalan provider menurunkan opsi kurir menjadi `available: false` dengan catatan, bukan menggagalkan seluruh quote. Pembuatan order memvalidasi `{courier, service, cost}` yang dipilih hanya terhadap cache — tidak pernah memanggil provider kedua kalinya di jalur tulis. Pengaturan toko mendapat `shipping.courier = {enabled, originDestinationId, couriers: string[]}`.

| Dimensi | **Cache 6 jam berbucket berat (dipilih)** | Tanpa cache — panggil provider di setiap quote |
| --- | --- | --- |
| Keamanan | Lebih sedikit panggilan keluar untuk diaudit dan dibatasi lajunya | Setiap request cart-quote menjadi panggilan keluar, memperlebar permukaan SSRF/penyalahgunaan yang sudah disebut daftar periksa skill `awcms-integration` |
| Performa | Cache hit adalah satu pencarian terindeks tunggal; jalur quote yang dihadapi pelanggan tetap cepat bahkan saat provider lambat | Setiap quote membayar latensi provider sendiri — tidak bisa diterima di jalur yang berulang kali disentuh pembeli saat menyesuaikan kuantitas |
| Kemudahan pemeliharaan | Satu tabel cache + satu kebijakan TTL untuk dipikirkan | Tidak ada logika caching, tapi permukaan kegagalan real-time yang jauh lebih besar untuk ditangani dengan baik di setiap request tunggal |
| Skalabilitas | Rasio cache hit membaik seiring makin banyak pembeli meng-quote rute serupa; volume panggilan provider relatif stabil terlepas dari volume quote | Volume panggilan provider berskala linear dengan volume quote — toko yang sibuk bisa menabrak batas laju provider sendiri |
| Aksesibilitas | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| SEO | Tidak berpengaruh di kedua sisi | Tidak berpengaruh di kedua sisi |
| UI/UX | Opsi kurir tampil secepat field quote lain mana pun; tarif basi paling lama 6 jam, jauh di dalam kadensi perubahan tarif tipikal RajaOngkir sendiri | Respons provider yang lambat membuat seluruh halaman cart-quote terasa lambat, persis UX yang sudah dihindari ADR-0010 dengan mengirim "manual + kurir flat lebih dulu" | 
| Kompatibilitas | Cocok dengan bentuk "panggilan provider di luar transaksi, degradasi anggun" milik D3 sendiri | Disiplin transaksional yang sama tetap dibutuhkan, hanya dijalankan di setiap request alih-alih saat cache-miss |
| Kompleksitas operasional | Satu tabel cache lagi dengan TTL terdokumentasi; baris cache yang macet/salah diperbaiki dengan menghapusnya | Gangguan provider mendegradasi SETIAP quote, bukan hanya sebagian yang meleset dari jendela cache 6 jam |
| Jangka panjang | Bentuk bucket-berat/TTL tergeneralisasi ke agregator kurir kedua di masa depan tanpa mengubah port | Tidak ada kisah skala tambahan yang didapat dengan melewati cache — hanya risiko yang ditambahkan |

Ditolak: tidak ada yang dipertimbangkan serius selain trade-off cache-vs-tanpa-cache di atas — tarif langsung di setiap ketikan tidak pernah layak mengingat aturan ADR-0006 "tidak ada panggilan provider di dalam transaksi, dan tidak ada alur kritis boleh bergantung padanya" serta kebutuhan responsivitas halaman checkout sendiri.

### D5 — WhatsApp: satu outbox, dua adapter (Fonnte, Meta Cloud API), dan adapter `CustomerOtpChannel` ketiga

`awcms_commerce_whatsapp_messages` + job `commerce:whatsapp:dispatch` adalah bentuk outbox yang sama dengan `email`/`push_delivery`. Dua adapter: **Fonnte** (`COMMERCE_WHATSAPP_PROVIDER=fonnte`, `COMMERCE_FONNTE_TOKEN`) dan **Meta Cloud API** (`meta`, `COMMERCE_META_WA_TOKEN`, `COMMERCE_META_WA_PHONE_NUMBER_ID`, plus nama template khusus untuk pesan OTP, karena API Meta sendiri mensyaratkan template pra-disetujui untuk percakapan yang diinisiasi bisnis). Adapter ketiga mengimplementasikan port `CustomerOtpChannel` milik ADR-0016 D2 sendiri (`domain/customer-otp-channel.ts`), sehingga pengiriman OTP memakai ulang port yang identik yang sudah diimplementasikan `email`/`log` — `OtpRequest` mendapat `via?: "email" | "whatsapp"` opsional (default `email`); `whatsapp` mensyaratkan `phone` pada request, dan login-lewat-telepon mencari akun lewat baris customer tertautnya (akun itu sendiri tetap tidak membawa kolom telepon-sebagai-kredensial — D1 ADR-0016 tidak berubah, ini hanya menambah alamat pengiriman kedua untuk OTP yang sama).

Ini adalah pengulangan berbentuk sama dari perbandingan D2 ADR-0016 sendiri (e-mail sekarang, WhatsApp sebagai lanjutan) — keputusan itu tidak diperdebatkan ulang di sini; D5 adalah lanjutan yang sudah dinamai ADR-0016, mendarat sesuai jadwal di bawah #33/#108.

### D6 — POS: metode pembayaran `cash`, `channel` order, dan satu permission baru

`payment_method` mendapat `cash`. `orders.channel` menjadi `'storefront' | 'pos'`. Permission baru `commerce.orders.create` — khusus POS, karena setiap jalur pembuatan order LAIN bersifat anonim (storefront) atau digerakkan provider (tidak ada yang membuat order di sisi server hari ini kecuali manusia di meja kasir). `POST /api/v1/commerce/pos/orders` membuat order `paid`, `self_pickup` untuk pelanggan walk-in atau teridentifikasi lewat telepon, dengan `admin` dicatat sebagai pihak yang bertindak di `order_events` (bukan `system`, dan bukan `customer` — staf-lah yang mengetiknya). Riwayat order POS hanyalah daftar order yang sudah ada, difilter `channel = pos` — tidak ada tabel order kedua, tidak ada model baca kedua.

### D7 — Laporan: tiga proyeksi `reporting`, disumbang oleh `commerce`

Tiga proyeksi lintas-modul mendarat di modul `reporting` (bukan `commerce` sendiri, mengikuti bagaimana `reporting` sudah menampung proyeksi yang disumbang modul lain): `commerce.sales_daily`, `commerce.sales_by_product`, `commerce.sales_by_category`. Strategi: `cursor_table` di atas `awcms_commerce_order_events` yang append-only — order yang mencapai `paid` MENAMBAH ke proyeksi, dan transisi `cancelled`/`refunded` berikutnya (selalu dicapai DARI `paid` atau setelahnya di graf status) MENGURANGI, sehingga proyeksi selalu berupa total berjalan yang benar tanpa pernah memindai ulang seluruh tabel order. Layar admin membaca proyeksi, plus ekspor terjadwal bawaan (bentuk yang sama yang sudah dipakai dashboard lain yang ditampung `reporting`).

### D8 — Kotak masuk: `awcms_commerce_conversations` + `awcms_commerce_messages`

Permukaan pesan akun pelanggan ↔ toko: `awcms_commerce_conversations` (satu per pelanggan, atau satu per pelanggan+subjek — keputusan skema untuk #111) dan `awcms_commerce_messages` (giliran-giliran individualnya). Endpoint bearer memungkinkan akun membaca dan membalas percakapannya sendiri; endpoint owner memungkinkan staf membaca, membalas, dan menutup/membuka ulang (`status: open|closed`). Balasan dari staf memicu notifikasi e-mail ke pelanggan (memakai ulang outbox `email`, bukan kanal baru) sehingga pelanggan tidak perlu membiarkan tab tetap terbuka untuk menyadari balasan.

Ditolak: memodelkannya seperti `comments` (permukaan komentar publik/dimoderasi, berjangkar-sumber-daya yang sudah ada) — percakapan kotak masuk bersifat privat antara satu pelanggan dan toko, tidak punya antrean moderasi, dan tidak berjangkar pada sumber daya terbit (produk, pos) sebagaimana komentar — memaksanya ke bentuk `comments` berarti menempelkan model privasi ke modul yang dirancang untuk kebalikannya.

### D9 — Kampanye: e-mail/WhatsApp massal bergerbang consent, disebar lewat outbox yang sudah ada

`awcms_commerce_campaigns` (`channel: email|whatsapp`, filter `audience` `{levels[], hasAccount, lastOrderSince}`, `subject`/`body`, `status: draft|scheduled|sending|sent|cancelled`) plus `awcms_commerce_campaign_recipients` (satu baris per penerima yang teresolusi, sehingga pengiriman parsial bisa dilanjutkan dan diaudit). Dispatcher `commerce:campaigns:dispatch` menyebar kampanye yang sedang mengirim ke outbox e-mail/WhatsApp yang SAMA yang sudah dipakai dispatch D5 dan `email`, secara berkelompok — tidak ada mekanisme pengiriman ketiga, tidak ada kisah rate-limit terpisah.

**Consent** bersifat krusial: `customer_accounts.marketing_consent_at` adalah timestamp yang bisa null, di-toggle pelanggan sendiri di `/akun`; resolusi audiens kampanye hanya pernah menyertakan akun dengan `marketing_consent_at` non-null — akun yang tidak pernah opt-in secara struktural tidak terjangkau kampanye, bukan sekadar tersaring oleh konvensi. Notifikasi push pelanggan secara eksplisit ditunda: `push_delivery` (awcms ADR-0074) berlangganan PERANGKAT, dan hari ini hanya perangkat staf yang dimodelkan — memperluasnya ke perangkat pelanggan sendiri adalah pertanyaan desain nyata (pelanggan tidak punya sesi berbentuk staf untuk menggantungkan langganan perangkat) yang ditinggalkan untuk increment berikutnya.

### D10 — Fitur & mitra: flag pengaturan modul, dan `customers.level` sebagai "Partners" milik BjekMart sendiri

Bahasa admin BjekMart sendiri menyebut sekumpulan kemampuan yang bisa di-toggle sebagai "Features" — dimodelkan di sini sebagai flag pengaturan modul `commerce` (`pos`, `inbox`, `campaigns`, `gateway`, `courier`) di dalam `awcms_module_settings` (mekanisme pengaturan per tenant, per modul yang sudah dimiliki setiap modul), dengan satu form pengaturan mencakup kelima-limanya. "Partners" milik BjekMart sendiri — hubungan harga bertingkat dengan pelanggan tertentu — adalah `customers.level`: admin mengatur level pelanggan, dan jalur cart-quote menerapkan `price_level_{n}` (kolom yang sudah dibawa `CommerceProduct`, sesuai catatan "Not built" milik `docs/api.md` sendiri di bawah increment 4) untuk pelanggan berautentikasi-bearer level `n`. Ini menutup butir yang secara eksplisit ditunda D6 ADR-0016 sendiri ("Harga bertingkat berdasarkan `level` saat quote"). Konsep "partners" milik ADR-0089 sendiri (dicatat di tempat lain) tidak berkaitan dengan ini dan disebut di sini hanya agar keduanya tidak tertukar sekadar karena nama.

### Di luar cakupan (ADR ini, increment ini)

Layar backup basis data (perhatian operasi, bukan perhatian `commerce`); notifikasi push yang dihadapi pelanggan (D9); pelacakan paket kurir (D4 mengirim TARIF, bukan pelacakan); adapter Xendit (D3 menamainya sebagai adapter masa depan di belakang port yang sama, tidak dibangun di sini).

## Opsi yang dipertimbangkan

Lihat tabel di bawah D1–D4 di atas untuk perbandingan dimensi-demi-dimensi yang lengkap; D5–D10 adalah keputusan struktural dengan satu bentuk terpilih masing-masing, dinalar dalam prosa. Ringkasan:

| Opsi | Mengapa tidak (atau mengapa dipilih) |
| --- | --- |
| **Port + adapter di dalam `commerce`, kredensial per deployment dari env, webhook beralamat token** (dipilih) | Memakai ulang pola outbox yang sudah dijalankan tiga kali basis kode ini, cocok dengan preseden "kredensial per deployment" awcms ADR-0074 sendiri, dan meresolusi tenant webhook dengan cara aman yang sama yang sudah dipakai `awcms_resolve_tenant_domain_lookup` |
| Menerima `integration_hub` lebih dulu | Modul spesifikasi upstream yang belum direview — berminggu-minggu kerja admisi dan risiko divergensi subtree yang tidak perlu ditanggung increment ini untuk mengirim lima adapter |
| Kredensial provider per tenant | BjekMart, deployment referensi, butuh persis satu akun per provider; kredensial per tenant menjawab pertanyaan yang tak seorang pun tanyakan dan menambah UI manajemen kredensial nyata yang tidak dibutuhkan increment ini |
| Tenant diresolusi dari payload webhook | Nilai yang dipasok pemanggil dan belum terverifikasi, dipakai memilih tenant, adalah oracle keberadaan lintas tenant, mode kegagalan yang sama yang sudah disingkirkan ADR-0009 untuk nomor telepon guest checkout |
| Embed Snap.js / handoff form-POST untuk gateway | Keduanya memperlebar CSP repo ini (origin script/frame/form-action baru) tanpa manfaat yang belum diberikan redirect, dan keduanya mengikat markup halaman checkout ke bentuk API spesifik satu provider |
| Tarif kurir langsung di setiap quote, tanpa cache | Membayar latensi dan batas laju provider sendiri di jalur panas yang dihadapi pelanggan yang sudah dilarang ADR-0006 untuk bergantung pada provider |
| Memodelkan kotak masuk seperti `comments` | Percakapan privat, tidak dimoderasi, tidak berjangkar sumber daya tidak cocok dengan modul yang dibangun untuk yang publik, dimoderasi, berjangkar sumber daya |

## Konsekuensi

- Kontrak OpenAPI yang mendarat dalam perubahan yang sama (issue #106) mendokumentasikan setiap path baru di bawah `/api/v1/commerce/{pos,conversations,campaigns,webhook-endpoints}`, `/api/v1/commerce/storefront/orders/{orderCode}/payment-gateway/sessions`, `/api/v1/commerce/storefront/account/conversations*`, `/api/v1/commerce/webhooks/{provider}/{endpointToken}`, dan `/api/v1/reports/commerce/sales-{daily,by-product,by-category}`, memakai `ROUTE_PARITY_EXEMPTIONS` di `apps/cms/scripts/api-spec-check.ts` karena belum ada berkas route untuk satu pun darinya — setiap exemption menamai issue anak (#107–#118) yang menghapusnya begitu handler-nya sendiri mendarat, dan set itu wajib kosong lagi begitu increment ini selesai.
- `customerBearer` (ADR-0016 D3) kini juga mengautentikasi endpoint kotak masuk milik storefront sendiri dan request sesi payment-gateway ketika pembeli yang sudah login yang menempatkannya — jalur anonim, teridentifikasi-telepon tetap tersedia untuk guest persis seperti yang sudah ditetapkan ADR-0009 untuk order dan review.
- Hanya DUA operasi baru yang mendeklarasikan `security: []` dan bergabung ke `ALLOWED_PUBLIC_OPERATIONS`: intake webhook payment-gateway (callback provider tidak punya sesi untuk dipresentasikan, menurut definisi) dan endpoint pembuatan-sesi payment-gateway (guest teridentifikasi-telepon, cocok dengan model kepercayaan permukaan storefront anonim lainnya) — setiap endpoint baru lain mensyaratkan `customerBearer` atau `bearerAuth` staf owner plus permission `commerce.*`.
- `payment_method` sudah membawa nilai enum `gateway` (ditambahkan lebih dulu, sesuai catatan "aditif" ADR-0010 sendiri) dan `shipping` sudah membawa metode `courier` — D3/D4 tidak butuh migrasi enum, hanya adapter yang bekerja di belakang masing-masing.
- Belum ada handler untuk endpoint D2–D10 mana pun; ADR ini dan kontrak OpenAPI-nya adalah target yang sudah direview yang menjadi dasar C1–C9 (issue #107–#118) dibangun, bukan deskripsi kode yang sedang berjalan.

## Status — 19 September 2026: semua keputusan terimplementasi, `ROUTE_PARITY_EXEMPTIONS` kosong

Setiap issue anak mendarat dan setiap entri `ROUTE_PARITY_EXEMPTIONS` yang dibutuhkan kontrak ini sudah dihapus — set itu kosong di `main`, sesuai yang disyaratkan ADR ini di atas.

| Keputusan | Status | Dikirim oleh |
| --- | --- | --- |
| D1 — port penyedia di dalam `commerce`, kredensial env | Terimplementasi — `ShippingRateProvider`, `PaymentGatewayProvider`, `WhatsappProvider`, masing-masing dengan adapter `log` dev/CI, `withTimeout` + `getProviderCircuitBreaker`, dipanggil di luar transaksi DB apa pun | #107, #108, #110 |
| D2 — webhook publik beralamat token, perlindungan replay | Terimplementasi — `POST /api/v1/commerce/webhooks/{provider}/{endpointToken}`, `awcms_resolve_commerce_webhook_endpoint` (`SECURITY DEFINER`), `UNIQUE (tenant_id, provider, event_key)` pada `awcms_commerce_payment_events`, backstop `commerce:payments:reconcile` | #110, #113 |
| D3 — payment gateway Midtrans Snap | Terimplementasi — checkout berbasis redirect, polling `/pesanan` tiap 5 detik, `COMMERCE_PAYMENT_GATEWAY=midtrans\|none`. Xendit tetap follow-up bernama, belum dibangun | #110, #112, #113 |
| D4 — ongkos kurir RajaOngkir, di-cache | Terimplementasi — `awcms_commerce_shipping_rates`/`_courier_destinations` (`sql/924`), TTL 6 jam, weight-bucketed, tidak pernah dipanggil dari dalam transaksi pesanan. Pelacakan kurir tetap follow-up bernama, belum dibangun | #107, #109 |
| D5 — outbox WhatsApp + kanal OTP | Terimplementasi — adapter Fonnte + Meta Cloud API, outbox `awcms_commerce_whatsapp_messages` (`sql/925`), `otp/request via: "whatsapp"` (hanya login) | #108, #115 |
| D6 — POS | Terimplementasi — `orders.channel`, `payment_method = 'cash'` (`sql/931`), `commerce.pos.create`, `/admin/commerce-pos` | #116 |
| D7 — laporan penjualan | Terimplementasi — tiga proyeksi `reporting` `cursor_table`/`dimensional` (`commerce.sales_daily`/`_by_product`/`_by_category`, `sql/933`), `/admin/commerce-reports` | #117 |
| D8 — inbox | Terimplementasi — `awcms_commerce_conversations`/`_messages` (`sql/927`/`928`), rute storefront ber-bearer, `/admin/commerce-inbox` | #111 |
| D9 — kampanye, consent | Terimplementasi — `awcms_commerce_campaigns`/`_campaign_recipients` (`sql/929`/`930`), `marketing_consent_at`, `commerce:campaigns:dispatch` | #114 |
| D10 — sakelar fitur, harga bertingkat | Terimplementasi — pengaturan modul `commerce` `{pos, inbox, campaigns, gateway, courier}`, `price_level_{n}` saat quote lewat `customerLevel` | #118 |

Di luar cakupan sejak ADR ini ditulis dan masih di luar cakupan: layar admin backup basis data (urusan operasi — lihat [`docs/deployment.md`](../deployment.id.md)), notifikasi push customer-facing, pelacakan paket kurir, dan adapter payment-gateway Xendit (keduanya dicatat di atas sebagai follow-up di belakang port yang sudah dibangun increment ini).
