🇮🇩 Bahasa Indonesia · 🇬🇧 [English (source)](SUPPORT.md)

<!-- i18n-source-hash: sha256:6f50aaa65a3a01dd7aae67d9709f9df185ca7317c8c8f661200ff05ba0f1a016 -->

# Dukungan

## Yang BUKAN kanal ini

**Repo ini menyimpan kode dan dokumentasi untuk me-re-platform borneojek-mart, bukan toko yang sudah tayang atau layanan pelanggannya.** Belum ada deployment produksi platform ini yang hidup (increment 1 belum punya basis data hidup — lihat [`SECURITY.md`](SECURITY.md)), dan sekalipun nanti sudah ada, masalah pesanan, pembayaran, atau akun pelanggan di toko yang berjalan bukan sesuatu yang ditangani oleh issue tracker repo ini.

Pertanyaan tentang kode, workspace, cakupan re-platform, atau integrasi dengan `apps/cms` dipersilakan lewat GitHub Issues.

## Yang bisa dibantu di sini

| Kebutuhan | Jalur |
| --- | --- |
| Gerbang yang rusak, hasil CI yang salah, workspace yang tidak bisa dibangun | Buka issue dengan templat **Bug report** |
| Pertanyaan tentang struktur repo ini, gerbangnya, atau penyematan `apps/cms` lewat subtree | Buka issue; mulai dari [`AGENTS.md`](AGENTS.md) |
| Pertanyaan tentang cakupan re-platform untuk increment saat ini | Lihat dulu [issue #1](https://github.com/ahliweb/awcms-one/issues/1), lalu buka issue bila masih belum jelas |
| Ingin membantu menerjemahkan cermin Indonesia sebuah dokumen governance | Buka issue, lalu lihat [`CONTRIBUTING.md`](CONTRIBUTING.md#translation) |
| Menemukan kerentanan keamanan | **Jangan buka issue publik.** Ikuti [`SECURITY.md`](SECURITY.md) |
| Masalah toko yang sudah tayang atau akun pelanggan | Bukan di sini — repo ini belum punya deployment hidup; begitu ada, kanalnya akan didokumentasikan di sini |

## Prioritas

Ditangani sebelum yang lain: cacat yang tidak menggagalkan gerbang mana pun tetapi tetap salah — kolom skema yang diekspresikan ulang dengan makna yang keliru, batas workspace yang terlewati diam-diam, dokumen yang sudah tidak sesuai lagi dengan kode. Setiap gerbang di repo ini ditulis untuk mempersempit celah itu, tetapi sebuah gerbang hanya menangkap apa yang memang ditulis untuk ditangkapnya.
