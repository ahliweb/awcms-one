Page fixtures cut from real BPS "Dalam Angka 2026" PDFs (`pdftotext -bbox-layout`, one `<page>` each):

- `prov-3.1.3-sex-by-regency.bbox.xml` - Provinsi Kalimantan Tengah Dalam Angka 2026, PDF p.202 (Kapuas label letter-spaced, watermark fragments between rows)
- `prov-3.1.1-distribution-swapped-rows.bbox.xml` - same publication, PDF p.198 (rows 3-4 emitted out of order by the text layer)
- `prov-3.1.2-age-by-sex.bbox.xml` - same publication, PDF p.201 (a total row with "1467,14" and "1 483,00")
- `prov-4.5.4-religion-continued.bbox.xml` - same publication, PDF p.495 (nil symbols, a repeated column marker)
- `city-3.1.3-registration-by-kelurahan.bbox.xml` - Kota Palangka Raya Dalam Angka 2026, PDF p.130 (two label columns, wrapped labels, "Jumlah di Kecamatan" subtotals)

BPS statistics are quoted for testing only; they remain BPS's (see apps/cms/data/idn-population/NOTICE.md).
- `prov-3.2.14-employed-by-industry.bbox.xml` - same publication, PDF p.228 (industry groups 1-3 defined in a footnote)
- `city-front-matter.txt` - Kota Palangka Raya Dalam Angka 2026, `pdftotext` of PDF p.4 (catalogue, ISSN, publication number, copyright sentence)
- `kec-pahandut-p68.bbox.xml`, `kec-pahandut-p121.bbox.xml` - Kecamatan Pahandut Dalam Angka 2025, PDF p.68 (population by sex per kelurahan) and p.121 (religion per kelurahan)
