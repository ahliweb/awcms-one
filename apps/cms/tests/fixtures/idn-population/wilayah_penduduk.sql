/*
================================================================================
filename : db/wilayah_penduduk.sql (TEST FIXTURE, awcms-one ADR-0053)
purpose  : a four-region copy of the vendored file's SHAPE, with made-up figures
note     : Data jumlah penduduk dan kode wilayah sesuai Kepmendagri
           No 300.2.2-2138 Tahun 2025
================================================================================*/
--
-- Table structure for table penduduk
--

DROP TABLE IF EXISTS wilayah_penduduk;
CREATE TABLE IF NOT EXISTS wilayah_penduduk (
    kode varchar(13) NOT NULL,
    nama varchar(100) NOT NULL,
    pria integer NOT NULL,
    wanita integer NOT NULL,
    total integer NOT NULL,
    PRIMARY KEY (kode)
);
CREATE INDEX penduduk_nama_idx ON wilayah_penduduk(nama);
--
-- Dumping data for table penduduk
--

--
INSERT INTO wilayah_penduduk(kode, nama, pria, wanita, total)
VALUES
('0','INDONESIA','520','480','1000'),
('62','Provinsi Uji','520','480','1000'),
('62.01','Kabupaten Uji Satu','160','140','300'),
('62.10','Kab Uji Sepuluh','100','100','200'),
('62.71','Kota Uji Dua','260','240','500');
