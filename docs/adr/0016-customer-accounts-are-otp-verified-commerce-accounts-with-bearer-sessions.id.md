🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](0016-customer-accounts-are-otp-verified-commerce-accounts-with-bearer-sessions.md)

<!-- i18n-source-hash: sha256:13d91f2b61719b544cf639fbf5b083d7a76ab8fbfc6f705b0f0b92269df4c891 -->

# ADR-0016 — Akun pelanggan adalah akun `commerce` terverifikasi OTP dengan sesi bearer

- **Status:** Diterima
- **Tanggal:** 19 September 2026
- **Pengambil keputusan:** ahliweb
- **Terkait:** [ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md), [ADR-0009](0009-guest-checkout-by-order-code-and-phone.id.md); issue #32, #86, #87–#93

## Konteks

`apps/storefront` sepenuhnya statis ([ADR-0007](0007-cart-and-checkout-stay-static-the-browser-calls-anonymous-commerce-endpoints.id.md)): browser memanggil `apps/cms` langsung dan `apps/storefront/server/penyaji.mjs` tidak menyimpan sesi apa pun. `awcms_principals` milik `apps/cms` adalah penyimpan kredensial **staf** — global, bebas RLS, dijaga `identity:principal-access:check` — tidak pernah dimaksudkan untuk mengautentikasi pembeli anonim. Belum ada kanal WhatsApp/SMS di basis kode ini hari ini; `email` sudah ada. Checkout tamu ([ADR-0009](0009-guest-checkout-by-order-code-and-phone.id.md)) sudah mengunci `awcms_commerce_customers` dengan nomor telepon, tanpa kredensial sama sekali — pelacakan memakai kode pesanan + telepon.

Issue #32 (akun pelanggan, wishlist/alamat/ulasan yang tersinkron, program afiliasi) butuh identitas nyata, login nyata, dan sesi nyata, di atas tabel yang sama itu, tanpa mewarisi asumsi apa pun dari permukaan staf (e-mail wajib di setiap baris, kata sandi yang bisa direset, kebijakan lockout yang dibagi dengan seorang administrator). ADR ini adalah gelombang 0 dari #32: mencatat empat keputusan arsitektur (D1–D4), bentuk program afiliasi (D5), dan apa yang sengaja di luar cakupan (D6) — kontrak OpenAPI yang mengikutinya dikirim dalam perubahan yang sama (issue #86), didokumentasikan sebelum handler-nya ada supaya C2–C4 (issue #87–#93) menulis kode terhadap kontrak yang sudah diperdebatkan dan disepakati.

## Keputusan

### D1 — Identitas: baris `commerce`, bukan `awcms_principals`

Akun pelanggan adalah baris di modul `commerce` (`awcms_commerce_customer_accounts`, terlingkup tenant, `FORCE ROW LEVEL SECURITY`), terikat 1:1 ke `awcms_commerce_customers`. **Tanpa kata sandi, selamanya** — tidak ada penyimpan kata sandi kedua, dan tidak ada tautan ke `awcms_principals`.

| Dimensi | **Baris `commerce`, tanpa tautan principal (dipilih)** | Tautkan ke `awcms_principals` |
| --- | --- | --- |
| Keamanan | Permukaan baru tetap di dalam batas RLS milik `commerce` sendiri; kompromi pada permukaan pelanggan anonim tidak bisa menjangkau baris kredensial staf | Membuka penyimpan kredensial staf — global, bebas RLS — ke permukaan anonim; bug di jalur pelanggan menjadi bug kredensial staf |
| Performa | Satu join (`customer_accounts` → `customers`) yang sudah ada di jalur checkout tersibuk | Join tambahan ke tabel global yang tidak diindeks untuk tujuan ini pada setiap permintaan pelanggan |
| Keterawatan | `commerce` memiliki siklus hidupnya sendiri dari ujung ke ujung; tanpa keterkaitan lintas modul yang perlu dipikirkan | Setiap perubahan auth staf (lockout, MFA, SSO) harus diaudit ulang apakah "berdampak ke pelanggan juga" |
| Skalabilitas | Berskala mengikuti tabel `commerce` sendiri yang terlingkup tenant | `awcms_principals` sengaja bersifat global; pertumbuhan satu basis pelanggan menekan tabel yang dipakai bersama semua tenant |
| Aksesibilitas | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi |
| SEO | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi |
| UI/UX | Pelanggan tidak pernah melihat login berbentuk staf (prompt MFA, pengalih sesi-tenant) | Konsep UI staf (pindah tenant, pendaftaran MFA) bocor ke login pembeli kecuali ditekan secara khusus di mana-mana |
| Kompatibilitas | Sejalan dengan baris ADR-0009 sendiri (`awcms_commerce_customers`) — ini adalah babak berikut baris itu, bukan identitas paralel | Tidak ada padanan principal di situs lama untuk ditautkan pada identitas pelanggan |
| Kompleksitas operasional | Satu tabel tambahan, dimiliki dan dimigrasikan oleh `commerce` sendiri | Butuh pengecualian yang dirangkai lewat setiap gerbang identitas upstream (`identity:principal-access:check` dan sejenisnya) agar pelanggan anonim tidak diperlakukan sebagai staf |
| Jangka panjang | Pelanggan tidak pernah butuh e-mail untuk ada (tindak lanjut WA di D2 tetap terbuka) | Memaksa e-mail pada setiap pelanggan hari ini, menutup kemungkinan akun berbasis telepon saja nanti |

### D2 — Kanal: OTP e-mail sekarang, WhatsApp sebagai tindak lanjut

Autentikasi memakai **OTP e-mail 6 digit** (di-hash, TTL 10 menit, 5 percobaan, sekali pakai) dikirim lewat outbox modul `email` di bawah kategori templat turunan baru `derived.commerce_customer_otp`. Port `CustomerOtpChannel` mendefinisikan adapter `email` dan `log`; adapter WhatsApp adalah tindak lanjut di bawah #33.

| Dimensi | **OTP e-mail sekarang (dipilih)** | OTP WhatsApp/SMS sekarang | Kata sandi (gaya reset ADR-0009) |
| --- | --- | --- | --- |
| Keamanan | Memakai ulang outbox, templat, dan penanganan gagal-kirim modul `email` yang sudah ada — satu permukaan baru lebih sedikit untuk diaudit | Kredensial vendor (WA Business API / gateway SMS) adalah rahasia baru yang harus dirotasi dan tempat baru untuk bocor | Membuka kembali seluruh permukaan reset/lupa/lockout yang sengaja dihindari ADR-0009 untuk checkout tamu |
| Performa | Latensi pengiriman dibatasi SLO outbox yang sudah ada dan sudah terukur | Belum terukur di basis kode ini; latensi dan perilaku retry vendor baru tidak diketahui sampai diintegrasikan | Tanpa latensi pengiriman, tapi menambah biaya hashing kata sandi (bcrypt/argon2) di setiap login |
| Keterawatan | Satu port (`CustomerOtpChannel`), satu adapter yang dikirim (`email`), adapter `log` untuk tes/CI | Adapter kedua dikirim sebelum bisa diuji ujung-ke-ujung di CI (tidak ada sandbox vendor tersedia di sini) | Mesin status siklus-hidup kredensial paralel kedua untuk dirawat di samping sesi D3 |
| Skalabilitas | `email` sudah berskala sesuai volume tenant yang di-seed repo ini | Batas laju penyedia belum diketahui dan belum diuji pada skala repo ini | Berskala baik, tapi permukaan yang dibuka kembali (token reset, lockout) menskalakan beban operasional, bukan throughput |
| Aksesibilitas | Kode yang diumumkan pembaca layar dengan bersih dari kotak masuk; tanpa widget klien baru | Sama, jika kotak masuk WA/SMS tersedia; tidak semua orang punya itu saat checkout | Bidang kata sandi adalah pola aksesibel yang dikenal, tapi menambah alur "lupa kata sandi" dengan permukaan aksesibilitasnya sendiri |
| SEO | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi |
| UI/UX | Satu langkah "masukkan kode 6 digit" yang familiar, sudah diharapkan pembeli BjekMart dari alat berbasis e-mail | Sejalan dengan cara sebagian besar pembeli BjekMart benar-benar berkomunikasi (WhatsApp), kerugian UX nyata yang ditunda ke #33 | Bidang tambahan untuk diingat, dan alur "lupa kata sandi" yang selama ini dihindari seluruh basis kode |
| Kompatibilitas | `email` sudah ada di basis kode ini; tidak ada yang baru untuk disediakan | Belum ada apa pun di basis kode ini yang bicara ke penyedia WA/SMS | Sejalan dengan login situs lama, tapi mengimpor kembali persis permukaan yang ditolak ADR-0009 untuk checkout tamu |
| Kompleksitas operasional | Nol hubungan vendor baru | Akun vendor baru, kredensial, dan celah CI (tak teruji tanpa rahasia langsung) | Kotak dukungan untuk "saya lupa kata sandi" sejak hari pertama |
| Jangka panjang | Port `CustomerOtpChannel` membuat adapter WA nanti bersifat aditif, bukan penulisan ulang | Mengirim tujuan UX hari ini, dengan biaya di atas, sebelum bisa diverifikasi di CI | Setiap keputusan mendatang (akun, sesi) mewarisi kasus tepi reset-kata-sandi selamanya |

### D3 — Transport sesi: token bearer opaque, `localStorage`, TTL geser 30 hari

Sesi memakai **token bearer opaque** (`cs_` + 32 byte acak base64url; hanya `sha256:` yang disimpan di `awcms_commerce_customer_sessions`), dikirim sebagai `Authorization: Bearer`, disimpan di `localStorage`, TTL geser 30 hari, dicabut saat logout. CORS: `Authorization` bergabung ke `Access-Control-Allow-Headers`; **tetap tanpa `Access-Control-Allow-Credentials`**.

| Dimensi | **Token bearer di `localStorage` (dipilih)** | Cookie `SameSite=None` di origin CMS |
| --- | --- | --- |
| Keamanan | Tidak pernah terkirim implisit lintas situs (tanpa otoritas ambien), jadi tidak ada permukaan CSRF baru; pencurian token (XSS) adalah risiko residual yang dibawa skema bearer mana pun | Butuh `Access-Control-Allow-Credentials` plus skema token CSRF di setiap rute yang menulis — permukaan lebih besar ditambahkan ke kontrak yang hari ini tidak punya sama sekali |
| Performa | Satu header `Authorization`, tanpa preflight tambahan di luar yang sudah diwajibkan `X-AWCMS-Tenant-ID`/tipe konten JSON | Jar cookie menambah overhead per permintaan dan berinteraksi dengan cache partisi browser dengan cara yang tidak dilakukan header |
| Keterawatan | Simetris dengan cara kerja `bearerAuth` yang sudah ada untuk sesi staf — tanpa bentuk jalur kode autentikasi kedua untuk dirawat, hanya instans skema kedua (`customerBearer`) | Alur berbasis cookie butuh middleware CSRF sendiri, matriks SameSite/Secure/HttpOnly sendiri per lingkungan, dan cerita dev-lokal sendiri (`localhost` vs domain nyata) |
| Skalabilitas | Tanpa status untuk diverifikasi per permintaan di luar satu pencarian terindeks pada `token_hash` | Biaya pencarian sama, plus asumsi afinitas sesi yang kadang diundang cookie di lapisan infra |
| Aksesibilitas | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi |
| SEO | Tidak berpengaruh pada kedua opsi | Tidak berpengaruh pada kedua opsi |
| UI/UX | Bertahan lewat reload halaman persis seperti keranjang tamu yang sudah ada (mekanisme penyimpanan yang sama yang sudah menyimpan state di browser pembeli) | Pemblokiran cookie pihak ketiga (sudah berjalan di browser nyata) diam-diam mengeluarkan pembeli setiap kali CMS dan storefront berbeda origin — bentuk yang sudah dikomit ADR-0007 sebagai kasus normal |
| Kompatibilitas | Bekerja identik baik `apps/storefront` dan `apps/cms` berbagi domain atau tidak — persis bentuk lintas-origin yang sudah dikomit ADR-0007 | Rusak khusus pada kasus lintas-origin yang dipilih ADR-0007; akan membutuhkan penempatan same-site sebagai prasyarat tak terdokumentasi |
| Kompleksitas operasional | Tanpa `Access-Control-Allow-Credentials`, jadi postur CORS allowlist-Origin yang sudah ada tidak berubah | Menyalakan CORS berkredensial, yang menghilangkan kemampuan menjawab preflight dengan pemeriksaan allowlist/wildcard sederhana dan memaksa echo Origin per permintaan di mana-mana |
| Jangka panjang | Klien mobile native atau storefront SSR mendatang bisa memakai ulang skema bearer yang identik tanpa asumsi jar-cookie apa pun | Mengunci klien non-browser mendatang mana pun (aplikasi mobile, klien SSR mendatang) ke semantik jar-cookie yang tidak ada di sana |

### D4 — Registrasi terikat ke baris tamu yang ada hanya jika e-mail juga cocok

Registrasi membutuhkan nama + telepon + e-mail. Jika telepon sudah ada sebagai pelanggan tamu (`awcms_commerce_customers`, ADR-0009), akun terikat ke baris itu, tapi `history_from` = `created_at` baris itu **hanya jika** e-mail baris tamu sama dengan e-mail yang terverifikasi; jika tidak, `history_from` = sekarang, dan pesanan lama tetap terjangkau lewat kode + telepon saja.

Ditolak: klaim bebas hanya lewat telepon (penyerang yang sekadar mengetahui nomor telepon bisa melihat alamat/riwayat pesanannya — kebocoran alamat/riwayat); menolak binding sama sekali (`409` yang membedakan "telepon ini sudah pernah pesan" dari "belum pernah" adalah oracle enumerasi telepon itu sendiri). Jalan tengah yang dipilih (ikat secara diam-diam, tapi gerbang pengungkapan riwayat pada faktor kedua yang sudah terbukti — e-mail terverifikasi) memberi akun kesinambungannya saat benar-benar layak didapat dan menurun ke "pesanan dari hari ini dan seterusnya" — tidak pernah kebocoran — saat tidak.

### D5 — Program afiliasi, dirancang dari awal

Kolom lama tidak pernah tercatat, jadi `awcms_commerce_affiliates` dan `awcms_commerce_affiliate_commissions` adalah tabel baru. `?ref=` ditangkap storefront dan dikirim saat pembuatan pesanan; baris komisi dibuat saat pesanan mencapai `completed`; referral diri sendiri tidak menghasilkan apa pun; staf menyetujui/membayar.

### D6 — Sengaja di luar cakupan (tindak lanjut)

Harga bertingkat berdasarkan `level` saat quote, verifikasi telepon, OTP WhatsApp (tindak lanjut D2), dan ubah e-mail/telepon pada akun yang sudah ada. Tidak satu pun dari ini menghalangi kontrak gelombang 0; masing-masing adalah tambahan murni terhadapnya nanti.

## Opsi yang dipertimbangkan

Lihat tiga tabel di bawah D1–D3 di atas untuk perbandingan dimensi-demi-dimensi lengkap. Ringkasnya:

| Opsi | Kenapa tidak (atau kenapa dipilih) |
| --- | --- |
| **Akun milik `commerce`, OTP e-mail, token bearer** (dipilih) | Tetap di dalam batas modul yang sudah dipercaya basis kode ini untuk lalu lintas anonim (ADR-0007/0009), memakai ulang outbox `email` yang sudah ada, dan tidak butuh postur kredensial CORS baru |
| Tautkan akun ke `awcms_principals` | Memaksa e-mail pada setiap pelanggan, membuka tabel kredensial staf global ke permukaan anonim, dan butuh pengecualian khusus di setiap gerbang identitas upstream |
| OTP WhatsApp/SMS sekarang | Kredensial vendor yang tidak bisa disediakan atau diuji repo ini di CI saat ini — ditunda ke #33 alih-alih dikirim tanpa bisa diuji |
| Kata sandi + reset/lupa | Membuka kembali persis permukaan yang dipilih ADR-0009 untuk dihindari checkout tamu, dan tidak berbagi satu pun manfaat token-nirstat D3 |
| Cookie sesi `SameSite=None` | Rusak di bawah pemblokiran cookie pihak ketiga setiap kali CMS dan toko berbeda origin, yang sudah dikomit ADR-0007 sebagai kasus normal, dan membuka permukaan CSRF yang tidak dimiliki kontrak ini sebelumnya |
| Klaim akun bebas berbasis telepon (D4) | Kebocoran alamat/riwayat pesanan ke siapa pun yang sekadar tahu nomor telepon |
| Tolak binding berbasis telepon sama sekali (D4) | Mengubah endpoint registrasi menjadi oracle enumerasi telepon |

## Konsekuensi

- Kontrak OpenAPI yang dikirim dalam perubahan yang sama (issue #86) mendokumentasikan setiap jalur di bawah `/api/v1/commerce/storefront/account/*` plus rute sisi staf `/api/v1/commerce/affiliates*`, memakai `ROUTE_PARITY_EXEMPTIONS` di `apps/cms/scripts/api-spec-check.ts` karena belum ada berkas rute — setiap pengecualian dihapus begitu handler-nya sendiri mendarat (C2–C4, issue #87–#93).
- `customerBearer` adalah skema keamanan yang sengaja terpisah dari skema `bearerAuth`/sesi milik staf: token pelanggan ditolak di mana pun `bearerAuth` diwajibkan, dan sebaliknya, sehingga dua ruang kredensial itu tidak pernah bisa tertukar oleh pemanggil atau kontributor mendatang yang membaca spek.
- `POST /storefront/orders` dan `POST /storefront/reviews` (endpoint anonim milik ADR-0009 sendiri) mendapat bearer *opsional* dan, untuk pesanan, `affiliateCode` opsional — hanya bidang aditif, sehingga snapshot kontrak konsumen `awcms-astro` yang dibekukan dan snapshot pra-migrasi keduanya tetap terpenuhi.
- Tamu yang tidak pernah mendaftar tidak kehilangan apa pun: setiap jalur anonim yang dikirim ADR-0009 tidak berubah, dan aturan binding D4 hanya pernah menambah kesinambungan, tidak pernah menghapus akses ke pesanan yang sudah bisa dijangkau tamu lewat kode + telepon.
- `store_settings.affiliate_commission_rate` bernilai `null` adalah saklar mati program afiliasi sendiri (`409 AFFILIATE_PROGRAM_DISABLED` saat pendaftaran) — tenant yang tidak pernah mengaturnya tidak pernah membuka permukaan afiliasi ke pembeli, sejalan dengan cara permukaan pemasaran `commerce` opsional lain (voucher, flash sale) sudah bisa dikonfigurasi per tenant.
- Belum ada handler untuk salah satu endpoint D1–D5; ADR ini dan kontrak OpenAPI-nya adalah target yang sudah ditinjau tempat C2 (akun/OTP/sesi), C3 (alamat/wishlist/pesanan/ulasan) dan C4 (afiliasi) membangun, bukan deskripsi kode yang sudah berjalan.

**Sebagaimana dibangun (C2–C4, issue #87/#89/#91/#92 — setiap entri `ROUTE_PARITY_EXEMPTIONS` yang dibutuhkan kontrak ini kini dihapus):** dua tempat di mana perilaku yang dikirim adalah keputusan nyata yang tidak dijelaskan rinci teks kontrak di atas. Pertama, `POST account/otp/verify` dengan `purpose: "register"` untuk e-mail yang sudah memiliki akun tidak gagal — pemilik kotak surat sudah membuktikan kendalinya dengan menerima dan memasukkan kode, sehingga pemanggil di-login ke akun yang sudah ada (menjaga nama/telepon aslinya) alih-alih membentur indeks unik `awcms_commerce_customer_accounts.email_normalized` yang jika tidak begitu akan memicu `500`. Kedua, template e-mail turunan `derived.commerce_customer_otp` men-seed dirinya sendiri secara otomatis begitu pertama kali tenant ditemukan tanpa satu pun — `sql/919` men-seed setiap tenant yang ada saat migrasi berjalan, tapi tenant yang di-provision setelahnya jika tidak begitu akan membuat setiap OTP diam-diam ditelan ke `202` netral tanpa apa pun di outbox; adapter `email` kini memanggil `seedDefaultEmailTemplates` yang sama yang dipakai seeding per-tenant milik modul `email` sendiri, saat pertama kali hilang, dan mencoba ulang sekali.

**Tindak lanjut WhatsApp dari D2, telah dibangun (Issue #108, kontrak #106/ADR-0017 D5):** `CustomerOtpChannel` mendapat adapter ketiga, `whatsapp` (provider Fonnte/Meta Cloud API, adapter `log` miliknya sendiri, outbox `awcms_commerce_whatsapp_messages` — `sql/925`). Cakupannya lebih sempit dari yang dibayangkan kerangka jangka panjang D2 sendiri ("pelanggan tidak pernah perlu e-mail untuk ada"): `via: "whatsapp"` pada `otp/request` hanya pernah mendukung `purpose: "login"`, diselesaikan terhadap akun yang SUDAH ADA lewat telepon baris pelanggannya (`findAccountByPhone`) — pendaftaran tetap hanya OTP e-mail, sehingga kunci akun tetap selalu alamat e-mail. Akun yang benar-benar hanya-telepon (tanpa e-mail sama sekali) tetap terbuka, dicatat di sini alih-alih dibuka kembali sebagai keputusan baru: begitu itu dibangun, `awcms_commerce_customer_accounts.email_normalized` perlu menjadi nullable dengan cara yang sama seperti `awcms_commerce_customer_otps.email_normalized` sudah lakukan untuk baris OTP issue ini (CHECK yang mensyaratkan minimal satu identifier, bukan `NOT NULL` per kolom). `otp/verify` menerima `phone` sebagai alternatif `email` (saling eksklusif, tidak pernah keduanya), dan `awcms_commerce_customer_otps` mendapat kolom `phone_normalized` nullable justru untuk itu. `via: "whatsapp"` saat kanal nonaktif/tidak dikonfigurasi menjawab `409 CHANNEL_UNAVAILABLE` — fakta konfigurasi, bukan oracle enumerasi baru, karena tidak bergantung pada apakah telepon yang diberikan benar-benar punya akun.

**Status — 2026-09-19 (tindak lanjut D6 soal harga bertingkat saat quote, ditutup oleh Issue #118, kontrak #106/ADR-0017 D10):** `quoteCart` milik `domain/cart-quote.ts` kini menerima `customerLevel` opsional (1–4) dan memberi harga baris pada `price_level_{n}` (jatuh kembali ke `price` saat tidak diatur), di-resolve dari bearer OPSIONAL pada `POST .../storefront/cart/quote` dan diterapkan ulang, dari akun yang SAMA, di dalam re-quote milik `POST .../orders` sendiri — lihat [`docs/cms.md`](../cms.id.md#toggle-fitur-dan-harga-bertingkat-issue-118-epik-33-c9-kontrak-106-d10-adr-0016-d6) dan bagian "Toggle fitur & harga bertingkat" milik `apps/cms/src/modules/commerce/README.id.md` untuk desain lengkapnya. Dua tindak lanjut D6 yang tersisa — verifikasi telepon dan ubah e-mail/telepon pada akun yang sudah ada — masih terbuka; OTP WhatsApp dan harga bertingkat sudah ditutup di atas (Issue #108 dan #118).
