/*
================================================================================
filename  : db/wilayah.sql (TEST FIXTURE, awcms-one ADR-0053)
purpose   : a four-region copy of the vendored file's SHAPE, with made-up figures
note      : Data Kode Wilayah sesuai Kepmendagri No 300.2.2-2138 Tahun 2025
            Data Luas Wilaah berdasar dari Badan Informasi Geospasial berdasarkan
            Surat Deputi Bidang Informasi Geospasial Dasar
            Nomor B-16.10/DIGD-BIG/IGD.04.04/12/2024, Tanggal 16 Desember 2024,
            Hal Penghitungan Luas Wilayah di Seluruh Indonesia
================================================================================*/
--
-- Table structure for table wilayah_luas
--
DROP TABLE IF EXISTS wilayah_luas;
CREATE TABLE wilayah_luas (
 kode varchar(13) NOT NULL,
 nama varchar(100) DEFAULT NULL,
 luas double NOT NULL,
 PRIMARY KEY (kode)
);
CREATE INDEX luas_nama_idx ON wilayah_luas(nama);
--
-- Dumping data for table wilayah_luas
--

INSERT INTO wilayah_luas(kode,nama,luas)
VALUES
('62.0','Provinsi Uji',153.564),
('62.01','Kabupaten Uji Satu',100.5);
INSERT INTO wilayah_luas(kode,nama,luas)
VALUES
('62.1','Kabupaten Uji Sepuluh',40.064),
('62.71','Kota Uji Dua',13.0);
