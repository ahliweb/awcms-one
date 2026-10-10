🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](aw-business-platform-metrics.md)

<!-- i18n-source-hash: sha256:4b55c1ed3390446a55cfe2de3f8648d9958fb2bb8b290ed15b984b7ca0c07198 -->

# AW Business Platform — kontrak metrik

Artefak DoR 6 (bagian analitik) dari epik [#280](https://github.com/ahliweb/awcms-one/issues/280), dikerjakan oleh [#337](https://github.com/ahliweb/awcms-one/issues/337) (Wave A, A7). Pelacak: [`aw-business-platform-dor.md`](aw-business-platform-dor.md). Penempatan: [ADR-0040](adr/0040-aw-business-platform-capability-ownership-and-boundaries.md).

**Ini spesifikasi, bukan implementasi.** Tidak ada modul, migrasi, path OpenAPI, kanal AsyncAPI, atau DDL yang dibuat atau diisyaratkan (ADR-0040 D7). Nama tabel, counter, dan proyeksi di bawah bersifat konseptual; baru menjadi nyata saat sebuah isu build mendaratkannya. PRD platform dan model ancaman adalah artefak DoR terpisah yang dibuat paralel; halaman ini menyebutnya dengan kata biasa dan tidak bergantung padanya.

## 1. Mengapa kontrak metrik didahulukan

Angka di dasbor hanya sepercaya definisinya. "Okupansi" bisa berarti tiga hal tergantung apakah hold dihitung, dan "pendapatan" bisa berarti empat. Proyeksi yang dibangun sebelum definisi ditetapkan mengunci satu tebakan, dan koreksi pertama adalah rebuild yang mengubah riwayat. Paket desain booking menyatakannya sendiri: counter dipilih lebih dulu karena itulah masukan setiap definisi kandidat, dan definisinya adalah keputusan pemilik O8 ([`awcms/booking.md`](https://github.com/ahliweb/awcms/blob/main/docs/awcms/booking.md), §7.2). O8 kini sudah dijawab; halaman ini menuliskan jawabannya cukup tepat untuk dibangun dan diuji.

### 1.1 Aturan yang berlaku untuk setiap KPI

1. **Satu penyimpanan analitik: engine `reporting` (ADR-0040 D5.2).** Setiap KPI adalah deskriptor proyeksi pada engine `reporting` yang ada, dimiliki modul upstream pemilik event sumbernya, atau proyeksi lintas-domain yang dimiliki di sini. Tidak ada data warehouse, tidak ada basis data metrik kedua, tidak ada spreadsheet sebagai catatan resmi. Angka yang tidak bisa dinyatakan sebagai proyeksi ditambah kueri rinci yang hidup dan diotorisasi ulang tidak dirilis.
2. **Counter hanya naik.** Engine membatasi penurunan di nol (README `reporting`, "Projections"), sehingga metrik adalah kumpulan counter monotonik di atas event append-only, dan setiap rasio atau angka bersih dihitung saat dibaca. Rebuild dari aliran event menghasilkan angka yang sama; sifat itu adalah uji penerimaan setiap proyeksi ("rebuild sama dengan live", sifat yang sudah dimiliki `commerce.sales_daily`).
3. **Jendela hari adalah `Asia/Jakarta` (O8).** "Hari" adalah interval setengah-terbuka `[00:00, 24:00)` di `Asia/Jakarta`, yaitu UTC+7 tanpa waktu musim panas. Instan disimpan dan dipertukarkan dalam UTC (RFC 3339); hanya label bucket yang lokal. Laporan penjualan yang ada sudah begitu dengan konstanta kode (`SALES_REPORT_TIME_ZONE`); deployment di tempat lain mengubah konstanta dan melakukan rebuild. Angka berbasis malam (bagian 8) memakai kalender **properti**, yang hanya `Asia/Jakarta` untuk properti di WIB; lihat Q3.
4. **Uang adalah sen bilangan bulat secara internal, `numeric(14,2)` di penyimpanan, string di wire** (ADR-0003). Pembulatan dilakukan sekali, di baris, tidak pernah pada jumlah, dan tidak pernah dengan float. Persentase dihitung saat dibaca dari dua counter bilangan bulat dan ditampilkan satu desimal dengan pembulatan half-up; counter tersimpan tidak pernah dibulatkan.
5. **Event terlambat menyatakan ulang hari asal secara default.** Event kompensasi (refund, pembatalan, amandemen) membawa referensi ke fakta yang dikompensasinya dan mendarat di **hari atribusi fakta itu**, sehingga bersih harian adalah bersih sungguhan dan rebuild cocok. Tampilan terpisah "menurut hari event" hanya ada bila pembaca berorientasi kas membutuhkannya (pendapatan, bagian 3.6), dan diberi label demikian. Konsekuensi: periode yang sudah **ditutup** dapat berubah. Lihat bagian 1.2.
6. **Rincian bersifat live dan diotorisasi ulang; proyeksi hanya angka dasbor.** Proyeksi tidak pernah membawa nama pelanggan, kontak, catatan, atau teks bebas (event booking sudah melarangnya). Menelusuri "resource mana, hari apa, pelanggan siapa" adalah kueri live yang memeriksa ulang izin dan cakupan pemanggil.
7. **Setiap KPI menyebut pemiliknya.** Proyeksi "upstream" dispesifikasikan di `ahliweb/awcms` dan tiba lewat subtree sync; proyeksi "di sini" bersifat lintas-domain (menggabungkan fakta dari dua modul atau lebih, atau dari `commerce`) dan dispesifikasikan di repositori ini ([ADR-0024](adr/0024-awcms-one-is-template-only-derived-apps-own-their-backend.md)). Proyeksi lintas-domain membaca modul lain hanya lewat event dan port, tidak pernah tabelnya (ADR-0040).

### 1.2 Penutupan periode dan penyajian ulang

Periode pelaporan tidak dikunci oleh spesifikasi ini (buku besar dan penutupan periode adalah non-tujuan, O9). Sebagai gantinya:

- Setiap kartu KPI menampilkan cap waktu **kesegaran** (engine sudah menyediakan sinyal basi).
- Hari yang lebih tua dari **jendela penyajian ulang** (usulan: 35 hari; lihat Q1) ditandai "restated" di UI bila event terlambat mengubahnya setelah jendela lewat. Angka tetap dikoreksi, tidak pernah dibekukan, sebab pembekuan membuat dasbor berbeda dari ledger asalnya.
- Ekspor membawa instan `as_of`. Pembaca keuangan yang butuh angka yang tak bergerak mengambil ekspor, bukan kartu live.

## 2. Asal-usul keputusan

| Keputusan                                                                                                                                                 | Sumber                                                                                                     | Status                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------ |
| Okupansi tidak menghitung hold; hold adalah angka pipeline terpisah                                                                                       | Keputusan pemilik O8, 10 Oktober 2026                                                                      | Dijawab                  |
| Utilisasi adalah metrik terpisah dari okupansi                                                                                                            | O8                                                                                                         | Dijawab                  |
| Jendela retensi N = 90 hari (pembelian/booking ulang dalam 90 hari sejak yang pertama)                                                                    | O8                                                                                                         | Dijawab                  |
| Pendapatan dilaporkan kotor, lalu diskon, lalu refund, lalu bersih; bersih adalah angka utama                                                             | O8                                                                                                         | Dijawab                  |
| Jendela hari di `Asia/Jakarta`                                                                                                                            | O8                                                                                                         | Dijawab                  |
| Produktivitas: hanya fakta bisnis yang transparan; terlihat oleh karyawan, atasannya, dan HR; tinjauan tata kelola sebelum penggunaan yang berkonsekuensi | O8, tercatat sebagai rekomendasi agen yang mengikuti teks isu #337; pemilik dapat mengubahnya              | Dijawab, dapat diubah    |
| Vertikal pertama adalah hotel / vila / rental, dengan kapasitas multi-malam                                                                               | O2                                                                                                         | Dijawab                  |
| Kontrak metrik analitik untuk KPI CRM dan Booking masuk cakupan                                                                                           | O3 (melayani butir MUST)                                                                                   | Dijawab                  |
| Bukti kehadiran hanya geolokasi, mati secara default                                                                                                      | O6                                                                                                         | Dijawab; memengaruhi 7   |
| Commerce tetap otoritas pelanggan                                                                                                                         | O12                                                                                                        | Dijawab; memengaruhi 6   |
| Tanpa akuntansi, tanpa dokumen fiskal, tanpa aktivitas layanan pembayaran                                                                                 | O9                                                                                                         | Dijawab; membatasi 3     |
| Satu penyimpanan analitik, engine `reporting`                                                                                                             | ADR-0040 D5.2                                                                                              | Diterima                 |
| Jangkar kohort = pembelian **atau** booking pertama, mana yang lebih awal                                                                                 | Teks isu #337 ("cohort = first purchase or booking"); aturan seri persisnya adalah spesifikasi halaman ini | Dispesifikasikan di sini |
| Jendela penyajian ulang 35 hari, "bersih" tanpa pajak dan ongkir, zona waktu properti, aturan malam parsial                                               | **Bukan** keputusan pemilik; usulan halaman ini                                                            | Terbuka: Q1, Q2, Q3, Q4  |

Tidak ada hal lain di halaman ini yang merupakan keputusan baru. Bila aturan di bawah melampaui O8, ia ditandai **(usulan)** dan terdaftar di bagian 9.

## 3. Pendapatan

### 3.1 Apa yang dijawabnya

"Berapa yang diperoleh bisnis dari yang dijual atau disewakan pada periode ini, setelah diskon dan setelah uang yang dikembalikan?" Ini angka utama dasbor keuangan dan pemilik.

### 3.2 Empat angka

Pendapatan **selalu dilaporkan sebagai air terjun empat langkah**, berurutan, dan **bersih adalah angka utama**:

| Langkah   | Angka                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Kotor  | Nilai barang dan jasa pada harga daftar, sebelum diskon apa pun, untuk pesanan yang mencapai status terbayar (commerce) dan biaya booking yang mencapai terbayar (lewat adaptor)                  |
| 2. Diskon | Setiap pengurangan yang diterapkan sebelum pembayaran: diskon baris, diskon voucher, dan penebusan loyalitas atau kredit toko yang dicatat pesanan sebagai pengurang harga, sebagai angka positif |
| 3. Refund | Nilai yang dikembalikan setelah pembayaran: refund retur dan pembalikan pembatalan pesanan terbayar, sebagai angka positif                                                                        |
| 4. Bersih | Kotor − Diskon − Refund                                                                                                                                                                           |

Ongkir, asuransi, dan pajak **tidak** ada di dalam air terjun; ketiganya adalah kolom tambahan di sampingnya (bagian 3.5). Ini berbeda dari `commerce.sales_daily` saat ini, yang `net`-nya adalah `total` pesanan (yang dibayar pelanggan, termasuk ongkir dan pajak). Kolom yang ada tetap bermakna sama untuk layar yang ada; angka bersih utama adalah angka **baru dengan nama berbeda** (nama kerja `net_revenue`) agar tak ada angka yang berubah diam-diam bagi pembaca. Lihat Q2.

### 3.3 Tabel kontrak

| Atribut                            | Kontrak                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definisi                           | Pendapatan bersih = kotor − diskon − refund, per hari atribusi, per mata uang                                                                                                                                                                                                                                                                                                                                                                                                        |
| Pembilang                          | Jumlah air terjun bertanda untuk periode (berupa jumlah, bukan rasio)                                                                                                                                                                                                                                                                                                                                                                                                                |
| Penyebut                           | Tidak ada. Rasio turunan yang ditampilkan di sampingnya (rasio diskon = diskon ÷ kotor; rasio refund = refund ÷ kotor) memakai **kotor** sebagai penyebut dan tidak menampilkan apa pun bila kotor nol                                                                                                                                                                                                                                                                               |
| Inklusi / filter status            | Pesanan commerce yang transisi terbayar pertamanya terjadi (`paid`, lalu `processing`, `shipped`, `completed` mempertahankannya). Biaya booking hanya lewat adaptor booking-ke-commerce, sebagai pesanan commerce terbayar; status booking saja tidak pernah menciptakan pendapatan (status pembayaran tidak ada di modul booking, paket desain upstream)                                                                                                                            |
| Pengecualian                       | Pesanan belum dibayar, kedaluwarsa, dan dibatalkan sebelum bayar; booking hold dan belum dikonfirmasi; leg pembayaran gagal; pelanggan sentinel walk-in **dihitung** (penjualan adalah pendapatan) tetapi dikecualikan dari retensi; tenant internal atau uji tidak pernah diagregasi lintas tenant; **penerbitan** kartu hadiah dan kredit toko adalah kewajiban, bukan pendapatan (O9: tanpa ledger); nilai tersimpan yang **dibelanjakan** adalah pendapatan saat pesanan dibayar |
| Zona waktu dan jendela             | Hari atribusi = `paid_at` pesanan di `Asia/Jakarta`; refund atau pembalikan mendarat di **baris hari yang sama dengan pembayarannya**, seperti laporan penjualan yang ada                                                                                                                                                                                                                                                                                                            |
| Event terlambat dan koreksi mundur | Refund setelah penutupan periode menyatakan ulang hari terbayar asal (kolom refund naik, bersih turun). Tanggal refund sendiri juga disimpan, sehingga tampilan kas "menurut hari refund" dapat digambar tanpa sumber kedua. Refund setelah pembatalan tidak menyumbang apa pun, sehingga pesanan tidak pernah dikurangkan dua kali (aturan yang ada). Retur parsial mengurangi persis yang dikembalikan; pembatalan berikutnya hanya mengurangi sisanya                             |
| Mata uang dan pembulatan           | Satu mata uang per tenant di v1 (IDR). Sen bilangan bulat, tanpa float. Pembulatan di baris, sekali. Tenant multi-mata-uang di luar cakupan sampai isu build menyatakan lain; proyeksi tidak pernah menjumlahkan dua mata uang                                                                                                                                                                                                                                                       |
| Pemilik proyeksi                   | **Di sini (lintas-domain).** Pesanan, ledger pembayaran, dan retur adalah fakta `commerce` (ADR-0025, ADR-0033), jadi proyeksi penjualan commerce tetap menjadi sumber. Bagian yang bersumber booking adalah proyeksi lintas-domain yang menggabungkan reservasi booking ke pesanan commerce-nya lewat pasangan referensi buram adaptor, dan tidak menambah pendapatan sendiri                                                                                                       |
| Fakta sumber (konseptual)          | Transisi status pesanan (paid, cancelled, refunded, returned), jumlah header dan baris pesanan, alokasi pembayaran (leg payment dan reversal), catatan retur dan refund, reservasi booking dan referensi adaptor ke pesanannya                                                                                                                                                                                                                                                       |
| Memakai ulang yang ada             | Proyeksi sales daily, by-product, dan by-category sudah mengimplementasikan hari atribusi, pembalikan di hari yang sama, dan netting retur. Air terjun memperluas kolomnya; tidak menggantikannya                                                                                                                                                                                                                                                                                    |
| Privasi dan visibilitas            | Total teragregasi memerlukan izin baca reporting; rincian per pelanggan atau per pesanan adalah kueri live yang diotorisasi ulang. Pendapatan per kasir atau per staf **bukan** tampilan pendapatan; itu masuk aturan produktivitas bagian 7                                                                                                                                                                                                                                         |

### 3.4 Kasus event terlambat, dengan contoh

| Kasus                                                         | Dampak                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pesanan dibayar 30 Sep 23:50 WIB, direfund penuh 3 Okt        | 30 Sep: kotor 100, refund 100, bersih 0. 3 Okt tidak berubah di tampilan standar; tampilan kas "menurut hari refund" menunjukkan 100 keluar pada 3 Okt                                |
| Pesanan dibayar pukul 00:10 WIB pada 1 Okt (17:10 UTC 30 Sep) | Dihitung pada 1 Okt. Tanggal UTC tidak relevan                                                                                                                                        |
| Pesanan dibatalkan sebelum pembayaran                         | Tidak ada di kolom mana pun                                                                                                                                                           |
| Booking diamandemen menjadi lebih sedikit malam setelah bayar | Adaptor menerbitkan refund parsial atau kredit lewat retur commerce; pendapatan berubah hanya lewat refund itu, di hari terbayar asal. Modul booking tidak pernah mengedit pendapatan |
| Gateway melaporkan refund dua kali                            | Satu baris refund: kunci idempotensi pada ledger menjadikan yang kedua tidak berefek                                                                                                  |

### 3.5 Kolom pendamping

Ongkir, asuransi, dan pajak yang dipungut ditampilkan di samping bersih agar "yang dibayar pelanggan" dapat direkonsiliasi ke ledger pembayaran: `customer_paid = net_revenue + ongkir + asuransi + pajak` untuk pesanan tanpa retur. Rekonsiliasi ini adalah total kontrol wajib proyeksi (rekonsiliasi sumber engine). Angka pajak bersifat informasional; **tidak ada dokumen fiskal yang dihasilkan** (O9).

### 3.6 Tampilan

Tampilan default: menurut hari atribusi (terbayar). Tampilan kas: menurut hari settlement leg pembayaran (inilah laporan tender yang sudah ada). Keduanya tidak pernah dicampur dalam satu grafik.

## 4. Okupansi

### 4.1 Apa yang dijawabnya

"Dari kapasitas yang dapat terjual, berapa banyak yang terikat pada pelanggan terkonfirmasi?" Okupansi adalah ukuran **komitmen**.

### 4.2 Tabel kontrak

| Atribut                            | Kontrak                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definisi                           | Unit terisi ÷ unit tersedia, untuk interval dan himpunan resource yang dinyatakan                                                                                                                                                                                                                                                                                                                         |
| Pembilang                          | Untuk resource berbasis malam: jumlah resource-malam (satu unit terisi satu malam) yang dipegang reservasi berstatus `confirmed`, `checked_in`, atau `completed`. Untuk resource berbasis waktu: unit-waktu terkonfirmasi dalam interval, dihitung dalam unit utuh pada tiap instan, menurut bagian 4.4                                                                                                   |
| Penyebut                           | Unit tersedia pada interval yang sama: jumlah unit × malam (atau waktu tersedia hasil ekspansi jadwal), **dikurangi** penutupan pemeliharaan atau blokir yang dinyatakan di pengecualian jadwal (usulan; lihat Q4 untuk konfirmasi pemilik). Unit tidak pernah dikeluarkan dari penyebut karena sedang terisi                                                                                             |
| Inklusi / filter status            | `confirmed`, `checked_in`, `completed` dihitung. Reservasi `checked_in` atau `completed` dihitung untuk malam yang benar-benar dilaluinya; menginap yang dipersingkat (check-out dini) dihitung sebanyak malam yang dijalani setelah diamandemen                                                                                                                                                          |
| Pengecualian                       | **Hold (`held`) dikecualikan (O8).** `expired`, `cancelled`, `rescheduled` (catatan yang digantikan), `no_show` dikecualikan. `no_show` tetap dilaporkan terpisah karena itu kamar yang dikomitmenkan dan tak terpakai; itu bukan okupansi                                                                                                                                                                |
| Hold sebagai angka pipeline        | Dilaporkan **terpisah**, tidak pernah ditambahkan: `held_units` (dan nilai yang dipertaruhkan bila berharga) untuk interval, dengan umur hold tertua. Label: "pipeline". Ini indikator awal; tidak pernah dijumlahkan dengan okupansi untuk menghasilkan persentase lebih besar                                                                                                                           |
| Zona waktu dan jendela             | Berbasis malam: malam tanggal D adalah interval dari jam check-in properti pada D sampai jam check-out pada D+1, berlabel D; kalendernya adalah zona waktu **properti**. Berbasis waktu: instan UTC, di-bucket per hari `Asia/Jakarta` untuk tampilan. Jendela setengah-terbuka `[start, end)`; booking berakhir 11:00 dan satu lagi mulai 11:00 berbagi batas dan tidak tumpang tindih (aturan upstream) |
| Event terlambat dan koreksi mundur | Konfirmasi setelah tanggal menginap, reschedule, atau amandemen diterapkan oleh event reservasi; malam yang terpengaruh dinyatakan ulang. Okupansi untuk tanggal **lampau** dihitung dari reservasi yang terkonfirmasi untuknya, bukan dari status saat pengguna melihat. Menginap terkonfirmasi yang dibatalkan menghapus malamnya (inilah counter `released_seconds`)                                   |
| Mata uang dan pembulatan           | Bukan moneter. Persentase ditampilkan satu desimal; counter bilangan bulat disimpan. Nilai di atas 100% adalah cacat data, dan proyeksi memunculkan ketidakcocokan rekonsiliasi alih-alih memotongnya                                                                                                                                                                                                     |
| Pemilik proyeksi                   | **Upstream: modul Booking.** Dispesifikasikan di paket desain booking (§7.2) sebagai counter `booking.reservations` dan `booking.time`; definisi okupansi melengkapi paket itu. Tambahan lintas-domain (okupansi per kanal atau segmen) adalah proyeksi di sini                                                                                                                                           |
| Fakta sumber (konseptual)          | Event siklus hidup reservasi, alokasi reservasi (unit, interval), jadwal dan pengecualian penutupan, jumlah unit resource                                                                                                                                                                                                                                                                                 |
| Privasi dan visibilitas            | Okupansi agregat adalah angka manajemen. Kalender tingkat resource adalah kueri live yang diotorisasi ulang. Tidak ada nama atau kontak tamu di proyeksi atau eventnya                                                                                                                                                                                                                                    |

### 4.3 Mengapa hold dikecualikan

Hold adalah janji bisnis kepada dirinya sendiri, bukan komitmen pelanggan. Menghitungnya menggelembungkan angka selama menit atau jam hingga hold kedaluwarsa, lalu banyak hold kedaluwarsa tampak sebagai okupansi tinggi yang runtuh. Mengecualikannya membuat okupansi konservatif dan monotonik terhadap komitmen nyata; pipeline hold menjawab pertanyaan lain ("seberapa banyak yang bisa segera terkonfirmasi") dengan angkanya sendiri.

### 4.4 Aturan hitung untuk resource berbasis waktu

Untuk resource berbasis waktu dengan `U` unit, angka terisi pada suatu interval adalah integral `min(alokasi terkonfirmasi pada t, U)` pada interval itu, dalam unit-detik; penyebutnya adalah `U` × detik tersedia. Counter `booked_seconds` dan `released_seconds` dari paket booking memberi pembilang sebagai `booked − released`, yang sudah hanya memuat alokasi terkonfirmasi. Buffer (persiapan dan pembersihan) **tidak** masuk pembilang: itu waktu terblokir, bukan waktu terjual (lihat utilisasi, bagian 5, untuk cara masuknya).

## 5. Utilisasi

### 5.1 Apa yang dijawabnya

"Dari waktu sebuah resource atau orang **tersedia untuk bekerja**, berapa yang dipakai untuk aktivitas yang dijual?" Okupansi bertanya soal kapasitas terjual; utilisasi bertanya soal **pemakaian produktif**. Keduanya memakai pembilang dan penyebut berbeda, sehingga merupakan dua metrik dan tidak pernah satu angka dengan dua label (O8).

### 5.2 Tabel kontrak

| Atribut                            | Kontrak                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definisi                           | Waktu yang benar-benar dipakai untuk aktivitas yang dijual ÷ waktu yang tersedia untuknya, untuk sebuah resource (kamar, kursi, bay) atau seorang staf                                                                                                                                                                                                |
| Pembilang                          | **Waktu terpakai:** untuk resource, detik antara `checked_in` dan `completed` reservasinya (pemakaian aktual). Untuk staf, detik layanan yang ditugaskan dan dihadiri. Bila cap waktu aktual tidak ada (tanpa check-in), dipakai detik **ter-booking** dan angka diberi label "utilisasi ter-booking"; keduanya tidak dicampur dalam satu seri        |
| Penyebut                           | **Waktu tersedia:** ekspansi jadwal (jam buka resource, atau shift terjadwal staf) pada interval, **dikurangi** penutupan, cuti disetujui, dan waktu terblokir. Buffer persiapan dan pembersihan berada di dalam waktu tersedia dan di luar waktu terpakai, sehingga menurunkan utilisasi dengan jujur                                                |
| Inklusi / filter status            | Reservasi yang mencapai `checked_in` atau `completed` untuk utilisasi pemakaian aktual. Untuk utilisasi ter-booking: `confirmed`, `checked_in`, `completed`                                                                                                                                                                                           |
| Pengecualian                       | Hold, cancelled, expired, no-show (tidak ada pemakaian). Waktu di luar jadwal mana pun (resource tanpa jam buka tidak punya penyebut dan menampilkan "tidak berlaku", bukan 0%). Untuk staf: waktu cuti disetujui dan hari libur yang dikonfigurasi sebagai tidak bekerja                                                                             |
| Zona waktu dan jendela             | Jadwal ditulis dalam waktu dinding lokal zona IANA resource dan diekspansi ke instan UTC oleh fungsi murni upstream; bucket tampilan adalah hari `Asia/Jakarta` untuk resource WIB. Shift dan menginap yang melewati tengah malam diatribusikan menurut instan, dan bucket hari menerima irisan interval dengan `[00:00, 24:00)`                      |
| Event terlambat dan koreksi mundur | Koreksi kehadiran yang disetujui belakangan (staf) atau jam check-out yang diamandemen (resource) mengubah waktu terpakai harinya; hari itu dinyatakan ulang. Perubahan jadwal hanya mengubah waktu tersedia **mendatang**: penyebut lampau dihitung dari versi jadwal yang berlaku pada hari itu (effective dating), sehingga riwayat tidak bergeser |
| Mata uang dan pembulatan           | Bukan moneter. Detik adalah satuannya; rasio ditampilkan satu desimal. Rasio di atas 100% (lembur, penugasan tumpang tindih) ditampilkan apa adanya dan ditandai, tidak pernah dipotong diam-diam                                                                                                                                                     |
| Pemilik proyeksi                   | **Utilisasi resource: upstream, Booking** (counter `booking.time` dan laporan utilisasi live di paket). **Utilisasi staf: lintas-domain, di sini**, karena menggabungkan penugasan staf Booking dengan port ketersediaan Workforce dan shift; tidak ada modul yang boleh membaca tabel modul lain                                                     |
| Fakta sumber (konseptual)          | Event check-in dan penyelesaian reservasi; catatan penugasan staf; ekspansi jadwal; interval kerja workforce, cuti disetujui, dan koreksi kehadiran (lewat port ketersediaan)                                                                                                                                                                         |
| Privasi dan visibilitas            | Utilisasi resource adalah angka manajemen. **Utilisasi staf adalah fakta produktivitas tentang seseorang** dan sepenuhnya diatur bagian 7: terlihat oleh orangnya, atasannya, dan HR saja, dan tidak pernah dipakai untuk keputusan berkonsekuensi tanpa tinjauan                                                                                     |

### 5.3 Contoh hitung: okupansi versus utilisasi

Sebuah ruang perawatan buka 09:00-17:00 (8 jam = 28.800 detik waktu tersedia) pada satu hari. Tiap perawatan butuh 15 menit persiapan dan 15 menit pembersihan (buffer). Ada empat booking:

| Booking | Interval layanan | Status      | Catatan                                   |
| ------- | ---------------- | ----------- | ----------------------------------------- |
| A       | 09:30-10:30      | `completed` | dipakai 09:32-10:25 (53 menit aktual)     |
| B       | 11:30-12:30      | `completed` | dipakai persis seperti dipesan (60 menit) |
| C       | 14:00-15:00      | `no_show`   | tak ada yang datang                       |
| D       | 15:30-16:30      | `held`      | hold, belum terkonfirmasi                 |

Okupansi (berbasis waktu, terkomit, buffer dikecualikan, hold dan no-show dikecualikan): A dan B dihitung pada **interval layanan sesuai pesanan**, masing-masing 3.600 detik = 7.200 detik. 7.200 ÷ 28.800 = **25,0%**.

Pipeline hold (angka terpisah): D = 3.600 detik = **12,5%** kapasitas hari itu, dilaporkan sebagai "pipeline", tidak ditambahkan ke okupansi. Menambahkannya akan menampilkan 37,5%, angka yang dilarang O8.

No-show (angka terpisah): C = 3.600 detik = 12,5% kapasitas yang dikomitmenkan dan tak terpakai.

Utilisasi (pemakaian aktual terhadap waktu tersedia): waktu terpakai = A 53 menit (3.180 detik) + B 60 menit (3.600 detik) = 6.780 detik. 6.780 ÷ 28.800 = **23,5%** (23,54 dibulatkan satu desimal).

Kedua angka berbeda (25,0% lawan 23,5%) karena okupansi menghitung yang dikomitmenkan sedangkan utilisasi menghitung yang benar-benar terjadi: A mulai terlambat dua menit dan selesai tujuh menit lebih awal. Buffer tidak masuk pembilang mana pun: 15 + 15 menit persiapan dan pembersihan di sekitar dua booking yang dilayani (2 × 1.800 detik = 3.600 detik) tetap berada di dalam waktu tersedia, itulah sebabnya utilisasi jujur tentang hari kerja nyata ruangan. Ditampilkan bersama pada satu kartu, masing-masing dengan definisinya sebagai keterangan, kedua angka menjawab dua pertanyaan: "seberapa penuh bukunya" dan "seberapa baik ruangan dipakai".

## 6. Retensi

### 6.1 Apa yang dijawabnya

"Dari pelanggan yang mulai bersama kami pada suatu bulan, berapa yang kembali dalam 90 hari?" Ini metrik **pelanggan**, sehingga identitasnya berasal dari otoritas pelanggan, yaitu commerce (O12); harmonisasi `profile_identity` adalah ADR masa depan tersendiri dan tidak diasumsikan.

### 6.2 Tabel kontrak

| Atribut                            | Kontrak                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Definisi                           | Tingkat pengulangan 90 hari suatu **kohort**: porsi kohort yang melakukan setidaknya satu pembelian atau booking berikutnya yang memenuhi syarat dalam 90 hari sejak yang pertama                                                                                                                                                                                                                                                                                              |
| Kohort                             | Pelanggan termasuk kohort **bulan kalender (`Asia/Jakarta`) dari peristiwa memenuhi syarat pertamanya**, yaitu yang paling awal di antara: pesanan commerce terbayar, atau booking **terkonfirmasi** (tanggal menginap tidak relevan; instan konfirmasi adalah jangkarnya). Pelanggan berada di tepat satu kohort, sekali, selamanya                                                                                                                                           |
| Pembilang                          | Pelanggan kohort dengan setidaknya **satu** peristiwa memenuhi syarat **kedua** yang instannya setelah yang pertama dan **dalam 90 hari** (instan peristiwa pertama + 90 × 24 jam, inklusif pada instan akhir)                                                                                                                                                                                                                                                                 |
| Penyebut                           | Ukuran kohort: semua pelanggan yang peristiwa memenuhi syarat pertamanya jatuh di bulan kohort. Kohort yang jendela 90 harinya belum genap berlalu ditampilkan sebagai **belum matang** (abu-abu, persentase sejauh ini berlabel "to date"); tidak pernah disajikan sebagai final                                                                                                                                                                                              |
| Inklusi / filter status            | Peristiwa memenuhi syarat = pesanan commerce yang mencapai terbayar dan **tidak direfund penuh atau dibatalkan setelahnya**, atau reservasi booking yang mencapai `confirmed` dan tidak dibatalkan, kedaluwarsa, atau di-reschedule pergi (reservasi pengganti dihitung sekali). Peristiwa kedua harus **pesanan atau reservasi yang berbeda**: item dalam pesanan yang sama bukan pengulangan                                                                                 |
| Pengecualian                       | Pelanggan sentinel walk-in (placeholder bersama, bukan orang); pelanggan terblokir atau teranonimkan setelah anonimisasi (keluar dari penyebut pada rebuild berikutnya dan kohort dinyatakan ulang); pembelian pertama yang direfund penuh (pelanggan tak pernah benar-benar mulai); akun uji dan internal; tamu tanpa id otoritas pelanggan yang dapat diselesaikan (dihitung sebagai "unlinked", dilaporkan terpisah, tidak ditebak dari data kontak)                        |
| Zona waktu dan jendela             | Bulan kohort menurut kalender `Asia/Jakarta`. Jendela 90 hari adalah 90 × 24 jam waktu absolut sejak peristiwa pertama, bukan 90 hari kalender (tidak ada waktu musim panas; bila deployment kelak berbeda, aturan tetap waktu absolut). N tanpa konfigurasi di v1: **90**                                                                                                                                                                                                     |
| Event terlambat dan koreksi mundur | Peristiwa terlambat atau mundur dapat menggeser peristiwa pertama pelanggan lebih awal (booking dimasukkan setelah pesanan yang lebih belakangan) sehingga **memindahkannya antar kohort**; proyeksi harus mendukungnya dengan menghitung ulang dari riwayat peristiwa pelanggan, bukan dengan menambah counter (lihat 6.4). Refund pembelian pertama setelah kejadian mengeluarkan pelanggan dari kohort saat rebuild. Pengulangan yang kemudian dibatalkan berhenti dihitung |
| Mata uang dan pembulatan           | Bukan moneter. Tingkat ditampilkan satu desimal; hitungan adalah bilangan bulat. Kohort di bawah 20 pelanggan menampilkan hitungan, bukan persentase (aturan angka kecil, agar derau tidak terlalu dibaca dan untuk menghindari re-identifikasi)                                                                                                                                                                                                                               |
| Pemilik proyeksi                   | **Di sini (lintas-domain).** Menggabungkan pesanan commerce dan reservasi Booking pada id pelanggan commerce yang dibawa referensi buram adaptor; tidak ada modul yang dapat menghitungnya sendiri. Retensi hanya-commerce (hanya pesanan) adalah sub-tampilan milik commerce                                                                                                                                                                                                  |
| Fakta sumber (konseptual)          | Event pesanan terbayar, pesanan dibatalkan dan direfund dengan id pelanggan; event reservasi confirmed, cancelled, expired, dan rescheduled dengan referensi pelanggan adaptor                                                                                                                                                                                                                                                                                                 |
| Privasi dan visibilitas            | Agregat kohort untuk manajemen dengan izin baca reporting. Penelusuran ke daftar pelanggan (siapa yang tidak kembali, untuk segmen win-back) adalah **segmen CRM** yang dibangun dari definisi yang sama, di balik izin CRM dan persetujuan pemasaran pelanggan; proyeksi sendiri hanya memuat hitungan                                                                                                                                                                        |

### 6.3 Contoh hitung: kohort

Pelanggan dan peristiwa memenuhi syaratnya (semua `Asia/Jakarta`; "B" = booking terkonfirmasi, "O" = pesanan terbayar):

| Pelanggan | Peristiwa pertama               | Peristiwa kedua | Selisih hari | Kohort    | Ulang dalam 90 hari?               |
| --------- | ------------------------------- | --------------- | ------------ | --------- | ---------------------------------- |
| C1        | 3 Jan (O)                       | 20 Feb (B)      | 48           | Jan       | ya                                 |
| C2        | 10 Jan (B)                      | 10 Mei (O)      | 120          | Jan       | tidak                              |
| C3        | 15 Jan (O)                      | tidak ada       | n/a          | Jan       | tidak                              |
| C4        | 28 Jan (B)                      | 28 Apr (B)      | 90           | Jan       | ya (hari ke-90 masuk, 90 × 24 jam) |
| C5        | 2 Feb (O)                       | 12 Feb (O)      | 10           | Feb       | ya                                 |
| C6        | 9 Feb (B)                       | tidak ada       | n/a          | Feb       | tidak                              |
| C7        | 21 Feb (O), lalu direfund penuh | n/a             | n/a          | tidak ada | dikecualikan                       |

Kohort Januari: C1, C2, C3, C4 = 4 pelanggan; mengulang dalam 90 hari: C1, C4 = 2. **Retensi = 2 ÷ 4 = 50,0%.** (Dengan kurang dari 20 pelanggan, UI akan menampilkan "2 dari 4" alih-alih persentase; aritmetika ditunjukkan untuk contoh.) Kohort Februari: C5, C6 = 2 pelanggan; C7 tak pernah mulai. Pengulangan: C5 = 1. **1 ÷ 2 = 50,0%**. Kohort belum matang sampai 90 hari setelah hari terakhir bulannya (28 Feb + 90 hari = 29 Mei), sehingga sebelum tanggal itu ditampilkan "to date".

Dua hal yang dipertegas contoh ini. Pertama, peristiwa kedua C2 adalah pembelian lanjutan tetapi bukan pengulangan 90 hari karena di luar jendela; jendela lebih panjang adalah konfigurasi tersendiri, bukan kebenaran yang berbeda. Kedua, C1 dan C3 sama-sama mulai di Januari dan tak terbedakan pada saat itu; hanya riwayat setelah peristiwa pertama yang memisahkan mereka, itulah sebabnya proyeksi menghitung ulang per pelanggan.

### 6.4 Bentuk proyeksi

Retensi **bukan** counter murni yang hanya naik, karena satu peristiwa dapat memindahkan pelanggan antar kohort. Proyeksi lintas-domain karenanya menyimpan, per tenant dan pelanggan, hanya dua instan peristiwa memenuhi syarat paling awal (pertama dan kedua) dan menurunkan tally kohort darinya saat dibaca atau pada rebuild terbatas. Ini adalah tabel di penyimpanan proyeksi engine `reporting`, bukan penyimpanan kedua; tidak memuat nama atau kontak, dan barisnya dihapus saat pelanggan dianonimkan. Bila kontrak deskriptor engine tidak dapat mengekspresikan baris per-pelanggan berkunci, itu adalah **penghambat bagi isu build** dan diajukan ke upstream, tidak diakali dengan penyimpanan eksternal (ADR-0040 D5.2).

## 7. Produktivitas karyawan

### 7.1 Apa itu, dan apa bukan

Produktivitas di sini berarti **fakta bisnis yang transparan tentang pekerjaan karyawan**, ditampilkan apa adanya. Ini **bukan** skor, peringkat, indeks, "penilaian kinerja", atau prediksi. Tidak ada model yang menghasilkannya, tidak ada bobot yang menggabungkannya, dan tidak ada angka turunan yang tidak dapat dihitung ulang karyawan dari fakta yang tercantum.

### 7.2 Aturan keras: tinjauan tata kelola sebelum penggunaan berkonsekuensi

> **Tidak ada angka produktivitas yang boleh dipakai untuk keputusan berkonsekuensi tentang seorang karyawan tanpa tinjauan tata kelola yang tercatat lebih dahulu.** Keputusan berkonsekuensi mencakup perubahan gaji atau komisi, disiplin, promosi, demosi, penalti penjadwalan, pemutusan hubungan kerja, dan memeringkat karyawan satu sama lain. Tinjauan adalah catatan tertulis oleh tenant (siapa yang meninjau, apa yang diputuskan, dasar hukum, tanggal), disimpan di jejak audit. Sampai catatan itu ada untuk tujuan yang dinyatakan, angka hanya untuk **transparansi dan pengelolaan diri**. Ini aturan platform, bukan opsi konfigurasi: platform tidak menyediakan fitur yang mengotomatiskan tindakan berkonsekuensi dari angka ini, dan tidak menyediakan tampilan peringkat per karyawan.

Ini adalah O8 (sebagaimana direkomendasikan kepada pemilik, dapat diubah) dan merupakan batas minimum. Analisis hukum pemantauan karyawan menurut hukum Indonesia (termasuk undang-undang data pribadi) menjadi bagian model ancaman dan analisis privasi (artefak DoR terpisah) dan penasihat hukum tenant sendiri; platform adalah prosesor untuk data karyawan tenant (O5).

### 7.3 Tabel kontrak

| Atribut                            | Kontrak                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definisi                           | **Daftar tetap fakta bisnis** per karyawan per periode, masing-masing ditampilkan dengan definisinya sendiri, tidak pernah digabung. Daftar v1 (konseptual; mengubahnya berarti mengubah halaman ini): (a) layanan atau booking yang diselesaikan, sebagai penugasan staf yang mencapai `completed`; (b) jumlah dan nilai penjualan yang diatribusikan ke karyawan di titik penjualan (kasir atau penjual tercatat), ditampilkan sebagai air terjun bagian 3; (c) jam kerja, dari kehadiran yang disetujui; (d) jam terjadwal dan jam hadir; (e) utilisasi staf dari bagian 5; (f) koreksi yang diminta dan disetujui (hitungan, tanpa penilaian) |
| Pembilang / penyebut               | Tiap fakta adalah hitungan atau jumlahnya sendiri. Satu-satunya rasio adalah yang sudah didefinisikan (utilisasi, bagian 5). **Tidak ada rasio komposit** yang didefinisikan, dan tidak boleh ditambahkan tanpa tinjauan tata kelola tercatat dan perubahan halaman ini                                                                                                                                                                                                                                                                                                                                                                           |
| Inklusi / filter status            | Fakta dihitung hanya pada keadaan selesai dan disetujui (penugasan `completed`, pesanan terbayar dan tidak dibalik, kehadiran disetujui). Penjualan yang kemudian direfund dinettokan pada hari asalnya, seperti di bagian 3                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Pengecualian                       | Waktu cuti disetujui dan hari libur; pekerjaan pada konteks kepegawaian berbeda; jumlah komisi dan gaji (itu data payroll, bukan fakta produktivitas, dan tidak pernah ditampilkan di permukaan ini); bukti apa pun di luar daftar: **tidak ada keystroke, layar, foto, biometrik, atau sidik jari perangkat, selamanya**; geolokasi hanya bukti kehadiran (O6, mati secara default per tenant, dibatasi tujuan) dan **tidak pernah** menjadi masukan produktivitas atau ditampilkan berdampingan dengan angka ini                                                                                                                                |
| Zona waktu dan jendela             | Bucket hari `Asia/Jakarta`; rekap mingguan dan bulanan dengan kalender yang sama. Shift yang melewati tengah malam diatribusikan menurut instan peristiwa kehadiran (irisan dengan tiap hari)                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Event terlambat dan koreksi mundur | Koreksi kehadiran yang disetujui, refund, atau booking yang ditugaskan ulang menyatakan ulang periode terdampak, dan perubahannya terlihat oleh karyawan pada tampilan yang sama ("restated on <tanggal>"); tidak ada yang ditulis ulang diam-diam. Koreksi yang belum disetujui tidak dihitung                                                                                                                                                                                                                                                                                                                                                   |
| Mata uang dan pembulatan           | Nilai penjualan mengikuti bagian 3. Jam ditampilkan dalam jam dan menit dari detik tersimpan; tidak ada pembulatan ke atas waktu kerja di mana pun dalam proyeksi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Pemilik proyeksi                   | **Di sini (lintas-domain)**: menggabungkan kehadiran dan shift Workforce, penugasan staf Booking, dan pesanan commerce menurut referensi staf. Fakta khusus Workforce (jam, koreksi) adalah proyeksi `hr_workforce` upstream bila modul itu memilih menerbitkannya; fakta khusus Booking (penugasan selesai) milik Booking upstream                                                                                                                                                                                                                                                                                                               |
| Fakta sumber (konseptual)          | Event kehadiran dan koreksi disetujui; penugasan shift; penugasan staf dan penyelesaiannya; penjual atau kasir tercatat pesanan dan event pembayaran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Privasi dan visibilitas            | **Terlihat oleh tepat tiga audiens:** (1) karyawan, untuk angkanya sendiri; (2) atasannya, dalam cakupan kantor atasan (aturan cakupan turunan yang didefinisikan paket Workforce); (3) HR. Tidak ada yang lain, termasuk admin tenant secara default, pembaca keuangan, dan penjadwal, yang melihat angka per karyawan. Setiap pembacaan diaudit; pembacaan HR dan atasan dicatat dengan identitas pembaca dan karyawannya. Agregat lintas karyawan (total tim) boleh ditampilkan ke manajer hanya bila tidak ada individu yang dapat disimpulkan (ukuran kelompok minimum 5; usulan, Q5)                                                        |
| Hak dan transparansi karyawan      | Karyawan melihat **angka, definisi, dan catatan penyajian ulang yang sama** dengan atasannya, sehingga tidak ada skor tersembunyi. Fakta yang disengketakan dikoreksi lewat alur koreksi kehadiran atau koreksi pesanan, bukan dengan mengedit proyeksi                                                                                                                                                                                                                                                                                                                                                                                           |

### 7.4 Artinya bagi desain

- Tidak ada papan peringkat dan tidak ada lencana "performer teratas". Layar yang mengurutkan karyawan menurut fakta produktivitas di luar cakupan.
- Data produktivitas tidak mengalir otomatis ke modul payroll atau komisi. Komisi, bila ada, adalah akrual terpisah, berbasis aturan, dan berversi (desain Workforce dan Payroll); manusia membaca fakta dan memutuskan di bawah tinjauan, bukan pipeline.
- Retensi fakta dasar mengikuti siklus hidup sumbernya (kehadiran, pesanan). Proyeksi tidak menyimpan apa pun yang tidak disimpan sumbernya.

## 8. Vertikal pertama: hotel, vila, dan rental (O2)

Bentuk konsumen pertama adalah akomodasi multi-malam dan rental (kamar, vila, kendaraan per hari). Ini mengubah _satuan kapasitas_ dari waktu menjadi **malam** dan memerlukan kosakata metrik bidang itu, didefinisikan di atas bagian-bagian sebelumnya.

### 8.1 Kapasitas berbasis malam

- Satu **resource-malam** adalah satu unit (kamar, vila, mobil sewa) untuk satu malam, dari jam check-in properti pada tanggal D sampai jam check-out pada D+1, berlabel D. Menginap 3 malam dengan check-in 10 Okt dan check-out 13 Okt memegang malam 10, 11, dan 12 Okt. Tanggal check-out sendiri **bukan** malam (interval setengah-terbuka, aturan yang sama di mana-mana).
- Jam `check-in` dan `check-out` properti adalah konfigurasi penawaran atau jadwal, dalam zona IANA properti. Pergantian di hari yang sama diizinkan oleh aturan setengah-terbuka; jeda pembersihan adalah buffer.
- Satu malam **tersedia** kecuali unit diblokir untuk pemeliharaan atau pemakaian pemilik di pengecualian jadwal. Malam terblokir keluar dari penyebut (Q4).

### 8.2 Angka perhotelan

Semuanya adalah definisi di atas kontrak sebelumnya, bukan penyimpanan baru. Masing-masing dihitung per properti, per tipe kamar, dan untuk rentang tanggal.

| Angka                                | Definisi                                                                                                   | Catatan                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Tingkat okupansi                     | Resource-malam terisi ÷ resource-malam tersedia (bagian 4)                                                 | Hold dikecualikan (O8); `no_show` dikecualikan                                                                |
| Average daily rate (ADR)             | Pendapatan kamar bersih ÷ resource-malam terisi                                                            | Bersih seperti bagian 3 (hanya biaya kamar, setelah diskon dan refund); tidak terdefinisi bila malam terisi 0 |
| Revenue per available night (RevPAN) | Pendapatan kamar bersih ÷ resource-malam tersedia; sama dengan okupansi × ADR                              | Analog RevPAR di bidang ini; nama `RevPAN` dipakai karena satuannya malam sebuah unit, belum tentu kamar      |
| Lama menginap (rata-rata)            | Resource-malam terisi ÷ jumlah menginap terkonfirmasi                                                      | Dihitung untuk menginap yang beririsan dengan rentang tanggal, hanya di dalam rentang                         |
| Lead time                            | Hari antara konfirmasi dan check-in, per menginap                                                          | Informasional; ditampilkan sebagai median, bukan rata-rata                                                    |
| Tingkat pembatalan dan no-show       | Menginap terkonfirmasi yang dibatalkan (atau `no_show`) ÷ menginap terkonfirmasi yang dibuat dalam rentang | Pembatalan terlambat ditandai oleh counter upstream `late_cancelled`                                          |
| Pipeline hold                        | Resource-malam yang di-hold dan nilainya, dengan umur hold tertua                                          | Terpisah dari okupansi (O8)                                                                                   |

### 8.3 Contoh hitung: satu vila, satu minggu

Satu vila, 7 malam tanggal 12-18 Oktober. Malam tanggal 15 diblokir untuk pemeliharaan, sehingga **malam tersedia = 6**.

| Menginap    | Malam (berlabel tanggal) | Jumlah      | Kotor (IDR)      | Diskon  | Refund  | Bersih (IDR) |
| ----------- | ------------------------ | ----------- | ---------------- | ------- | ------- | ------------ |
| R1          | 12, 13, 14               | 3           | 3.000.000        | 0       | 0       | 3.000.000    |
| R2          | 16, 17                   | 2           | 2.500.000        | 250.000 | 100.000 | 2.150.000    |
| R3 (`held`) | 18                       | pipeline: 1 | bukan pendapatan | n/a     | n/a     | n/a          |

Diskon 10% R2 diterapkan saat pembayaran dan refund parsial 100.000 diterbitkan setelah menginap; keduanya diatribusikan ke hari terbayar asal R2.

- Malam terisi = R1 (3) + R2 (2) = 5. Okupansi = 5 / 6 = **83,3%**. Bila blokir pemeliharaan tidak dikeluarkan dari penyebut, hasilnya 5 / 7 = 71,4%; pilihan ini penting, itulah sebabnya Q4 meminta konfirmasi pemilik.
- Air terjun pendapatan: kotor 5.500.000, diskon 250.000, refund 100.000, **bersih 5.150.000**.
- ADR = 5.150.000 / 5 = **1.030.000**.
- RevPAN = 5.150.000 / 6 = **858.333** (858.333,33 saat ditampilkan; counter tersimpan adalah 5.150.000 dan 6).
- Pemeriksaan: okupansi × ADR = (5/6) × 1.030.000 = 858.333.
- Pipeline: R3 = 1 malam hold, di barisnya sendiri; tidak masuk okupansi (kalau masuk, akan terbaca 6 / 6 = 100,0%).
- Rata-rata lama menginap = 5 / 2 = 2,5 malam.

### 8.4 Utilisasi di vertikal ini

Untuk unit berbasis malam, **utilisasi bukan angka utama tersendiri** seperti untuk ruang perawatan: unit terisi atau tidak pada suatu malam, sehingga utilisasi malam sama dengan okupansi, dan menampilkan keduanya mengundang kebingungan. Di vertikal ini, utilisasi berlaku untuk **staf dan resource bersama** (tata graha, kolam, shuttle), tempat waktu-terpakai terhadap waktu-tersedia yang berbasis waktu bermakna. Bila angka berbasis malam dan berbasis waktu ada untuk unit yang sama, aturan pemilik berlaku: keduanya metrik terpisah, berlabel, tidak pernah digabung.

### 8.5 Kanal dan segmen

Okupansi dan pendapatan bersih boleh diiris menurut kanal booking (langsung, sumber dari adaptor) dan segmen pelanggan (segmen CRM). Irisan adalah **dimensi pada counter yang sama**, bukan keluarga proyeksi kedua, dan irisan dengan kurang dari 5 pelanggan ditampilkan sebagai agregat agar tamu tidak teridentifikasi.

## 9. Pertanyaan terbuka

Ini usulan halaman ini, bukan keputusan pemilik (seri O lengkap untuk artefak ini). Masing-masing harus dijawab atau diterima sebelum proyeksi yang bergantung padanya dibangun.

| #   | Pertanyaan                                                                                                                                                                                  | Default yang direkomendasikan                                       | Menghambat                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------- |
| Q1  | Jendela penyajian ulang untuk penanda "restated"                                                                                                                                            | 35 hari (mencakup penutupan bulanan ditambah siklus refund gateway) | UX kartu pendapatan           |
| Q2  | Bersih utama tidak termasuk ongkir, asuransi, dan pajak, sehingga berbeda dari `net` yang ada (total pesanan). Konfirmasi kolom `net_revenue` baru alih-alih mendefinisikan ulang yang lama | Kolom baru; yang lama tetap bermakna sama                           | Perluasan proyeksi pendapatan |
| Q3  | Kalender malam properti di luar WIB                                                                                                                                                         | Zona IANA properti sendiri; `Asia/Jakarta` adalah default tenant    | Okupansi berbasis malam       |
| Q4  | Apakah penyebut okupansi mengecualikan malam pemeliharaan dan blokir pemilik?                                                                                                               | Ya: tidak dapat dijual. Laporkan jumlah terblokir di sampingnya     | Okupansi                      |
| Q5  | Ukuran kelompok minimum untuk agregat tim produktivitas                                                                                                                                     | 5                                                                   | Agregat produktivitas         |
| Q6  | Apakah booking terkonfirmasi dengan deposit tetapi tanpa pesanan commerce adalah pendapatan? (Halaman ini menyatakan pendapatan hanya ada lewat commerce, jadi tidak)                       | Pendapatan hanya mengikuti pesanan commerce dan ledger pembayaran   | Adaptor booking-ke-commerce   |
| Q7  | Apakah pelanggan yang pertama muncul sebagai _tamu_ (tanpa id pelanggan commerce) dapat ditautkan kemudian untuk retensi                                                                    | Tidak sebelum ADR identitas O12; tampilkan sebagai "unlinked"       | Retensi                       |

## 10. Tempat setiap proyeksi berada

| KPI                                       | Dimiliki upstream (modul)                          | Lintas-domain, dimiliki di sini                                                             | Engine      |
| ----------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------- |
| Air terjun pendapatan (pesanan)           | tidak ada                                          | Memperluas proyeksi penjualan commerce yang ada (sudah dimiliki commerce di repositori ini) | `reporting` |
| Air terjun pendapatan (bersumber booking) | tidak ada                                          | Gabungan reservasi dan pesanan commerce-nya lewat referensi adaptor                         | `reporting` |
| Okupansi, pipeline hold, no-show          | Booking (`booking.reservations`, `booking.time`)   | Irisan menurut kanal dan segmen                                                             | `reporting` |
| Utilisasi resource                        | Booking (laporan live + `booking.time`)            | tidak ada                                                                                   | `reporting` |
| Utilisasi staf                            | Fakta ketersediaan Workforce (port)                | Gabungan penugasan staf Booking dengan port ketersediaan                                    | `reporting` |
| Retensi                                   | tidak ada                                          | Proyeksi dua-peristiwa-paling-awal per pelanggan yang menggabungkan pesanan dan reservasi   | `reporting` |
| Fakta produktivitas karyawan              | `hr_workforce` (jam, koreksi); Booking (penugasan) | Tampilan gabungan, diaudit, tiga audiens                                                    | `reporting` |

Proyeksi lintas-domain di sini bergantung pada **event dan port** upstream dan tidak yang lain. Bila event upstream tidak memiliki bidang yang dibutuhkan kontrak di atas (misalnya referensi pelanggan pada event reservasi, atau penjual tercatat pada event pesanan), kekurangan itu diajukan ke upstream sebagai permintaan perubahan, tidak ditambal dengan salinan privat datanya.

## 11. Yang harus dibuktikan setiap isu build

Proyeksi yang dibangun dari halaman ini diterima hanya dengan uji untuk:

1. **Rebuild sama dengan live** untuk counter KPI, dan total kontrol rekonsiliasi terhadap sumber (rekonsiliasi sumber engine).
2. **Setiap kasus event terlambat** di tabel kontrak KPI (refund setelah penutupan, booking diamandemen, kehadiran dikoreksi), termasuk bahwa tidak ada yang dihitung dua kali.
3. **Hold dikecualikan** dari okupansi, dan hadir di angka pipeline.
4. **Okupansi dan utilisasi dihitung terpisah** pada contoh bagian 5.3 dan contoh vila bagian 8.3, dengan angka persis ini.
5. **Penetapan kohort retensi** pada contoh bagian 6.3, termasuk batas hari ke-90 dan pembelian pertama yang direfund penuh.
6. **Visibilitas**: orang di luar tiga audiens tidak menerima angka produktivitas; atasan di luar cakupan tidak menerimanya untuk karyawan itu; setiap pembacaan diaudit.
7. **Tanpa penyimpanan kedua**: proyeksi terdaftar sebagai deskriptor `reporting` dan hanya menulis tabel milik engine.

## Di luar cakupan halaman ini

PRD platform (cerita, MoSCoW), model ancaman dan analisis privasi, ERD, dan matriks RBAC/ABAC/RLS adalah artefak DoR terpisah. Akuntansi, dokumen fiskal, dan aktivitas layanan pembayaran adalah non-tujuan (O9), sehingga tidak ada KPI di sini yang berupa saldo buku besar, angka pajak resmi, atau posisi kas.
