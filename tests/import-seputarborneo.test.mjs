/**
 * tests/import-seputarborneo.test.mjs — issue #58.
 *
 * Unit coverage for the seputarborneo EXPORTER's pure surfaces, all on
 * hand-authored fixtures (never the real dump, which is never committed):
 *
 *   1. `tools/lib/mysql-dump-reader.ts` — the streaming tokenizer.
 *   2. The taxonomy mapper, against every legacy spelling
 *      `migrations/2026-09-02-normalize-legacy-taxonomy.sql` names, plus all
 *      45 real-dump combinations, plus the `legacyName`/`termMapHintFor`
 *      shapes `blog:legacy:import`'s `--term-map`/`--section-map` expect.
 *   3. `buildPostRecord`/`buildVideoRecord` — the exact
 *      `legacy-import-record.ts` field shapes.
 *   4. `buildRedirectEntry`/URL construction, and slug-collision handling.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  SqlInsertTokenizer,
  extractCreateTableColumns,
  tryParseValueTuple,
  readMysqlDumpRows
} from "../tools/lib/mysql-dump-reader.ts";
import {
  sbSlug,
  phpRawUrlEncode,
  legacyNewsUrlCurrent,
  legacyNewsUrlPre2000,
  legacyVideoUrl,
  normalizeLegacyTaxonomy,
  mapLegacyTaxonomy,
  termMapHintFor,
  normalizeYoutubeVideoId,
  resolvePublishedAt,
  newPostSlug,
  buildPostRecord,
  buildVideoRecord,
  buildRedirectEntry,
  buildSiteProfileUpdateFromConfig
} from "../tools/import-seputarborneo.ts";

// ---------------------------------------------------------------------------
// 1. tools/lib/mysql-dump-reader.ts
// ---------------------------------------------------------------------------

describe("mysql-dump-reader: tryParseValueTuple", () => {
  test("numbers, quoted strings, escapes, and NULL in one tuple", () => {
    const r = tryParseValueTuple("(1,'plain','a\\'b','line1\\nline2',NULL,-3.5)", 0);
    assert.ok(r.ok);
    assert.deepEqual(r.values, [1, "plain", "a'b", "line1\nline2", null, -3.5]);
  });

  test("a comma INSIDE a quoted string is not a value separator", () => {
    const r = tryParseValueTuple("(1,'a,b,c')", 0);
    assert.ok(r.ok);
    assert.deepEqual(r.values, [1, "a,b,c"]);
  });

  test("a doubled backslash then a quote closes the string correctly", () => {
    const r = tryParseValueTuple("(1,'a\\\\')", 0);
    assert.ok(r.ok);
    assert.deepEqual(r.values, [1, "a\\"]);
  });

  test("an incomplete tuple (buffer ends mid-string) reports ok:false, not an error", () => {
    const r = tryParseValueTuple("(1,'unterminated", 0);
    assert.equal(r.ok, false);
  });

  test("an incomplete NULL at the exact buffer boundary reports ok:false", () => {
    const r = tryParseValueTuple("(1,NUL", 0);
    assert.equal(r.ok, false);
  });

  test("a malformed token that can never become valid throws", () => {
    assert.throws(() => tryParseValueTuple("(1,@garbage)", 0));
  });
});

describe("mysql-dump-reader: extractCreateTableColumns", () => {
  test("column names in order, skipping PRIMARY KEY/KEY/CONSTRAINT clauses", () => {
    const inner =
      "`id_ber` int(11) NOT NULL AUTO_INCREMENT, `judul` varchar(100) NOT NULL, " +
      "`kategori` enum('a,b','c') DEFAULT 'a,b', PRIMARY KEY (`id_ber`), " +
      "KEY `idx_kategori` (`kategori`)";
    assert.deepEqual(extractCreateTableColumns(inner), ["id_ber", "judul", "kategori"]);
  });

  test("a decimal type's own comma does not split columns", () => {
    const inner = "`price` decimal(10,2) NOT NULL, `qty` int(11) NOT NULL";
    assert.deepEqual(extractCreateTableColumns(inner), ["price", "qty"]);
  });
});

describe("mysql-dump-reader: SqlInsertTokenizer (multi-row, multi-statement, fed byte-by-byte)", () => {
  test("learns column order from CREATE TABLE, reads multi-row VALUES across two statements, skips unwanted tables", () => {
    const sql =
      "CREATE TABLE `t` (`a` int(11), `b` varchar(10)) ENGINE=MyISAM;\n" +
      "INSERT INTO `t` VALUES (1,'x'),(2,NULL),(3,'y,z');\n" +
      "INSERT INTO `other` VALUES (99,'skip-me');\n" +
      "INSERT INTO `t` VALUES (4,'second-statement');\n";

    const tokenizer = new SqlInsertTokenizer(["t"]);
    const rows = [];
    for (const ch of sql) rows.push(...tokenizer.feed(ch));

    assert.ok(tokenizer.isAtRest());
    assert.deepEqual(tokenizer.columnsFor("t"), ["a", "b"]);
    assert.deepEqual(rows, [
      { table: "t", values: [1, "x"] },
      { table: "t", values: [2, null] },
      { table: "t", values: [3, "y,z"] },
      { table: "t", values: [4, "second-statement"] }
    ]);
  });

  test("a table split across chunked INSERT statements (mysqldump packet-size chunking) is read as one continuous set", () => {
    const tokenizer = new SqlInsertTokenizer(["berita_red"]);
    const schema = "CREATE TABLE `berita_red` (`id_ber` int(11), `judul` varchar(100));\n";
    const insert1 = "INSERT INTO `berita_red` VALUES (1,'A');\n";
    const insert2 = "INSERT INTO `berita_red` VALUES (2,'B');\n";

    const rows = [
      ...tokenizer.feed(schema),
      ...tokenizer.feed(insert1),
      ...tokenizer.feed(insert2)
    ];

    assert.deepEqual(rows.map((r) => r.values), [
      [1, "A"],
      [2, "B"]
    ]);
  });
});

describe("mysql-dump-reader: readMysqlDumpRows against a 3 MB synthetic gzip fixture", () => {
  test("streams every row without ever holding the file whole, fed in small chunks", async () => {
    const ROW_COUNT = 1500;
    const PADDING = "x".repeat(2500);
    let sql = "CREATE TABLE `berita_red` (`id_ber` int(11), `judul` varchar(3000));\n";
    sql += "INSERT INTO `berita_red` VALUES ";
    sql += Array.from(
      { length: ROW_COUNT },
      (_, i) => `(${i},'row-${i}-${PADDING}')`
    ).join(",");
    sql += ";\n";

    assert.ok(Buffer.byteLength(sql, "utf8") > 3 * 1024 * 1024, "fixture must exceed 3 MB");

    const tmpPath = `${import.meta.dir}/../tools/out/.test-fixture-3mb.sql.gz`;
    const gzipped = Bun.gzipSync(new TextEncoder().encode(sql));
    await Bun.write(tmpPath, gzipped);

    try {
      let count = 0;
      let firstId = null;
      let lastId = null;
      for await (const { table, row } of readMysqlDumpRows(tmpPath, ["berita_red"])) {
        assert.equal(table, "berita_red");
        if (firstId === null) firstId = row.id_ber;
        lastId = row.id_ber;
        count++;
      }
      assert.equal(count, ROW_COUNT);
      assert.equal(firstId, 0);
      assert.equal(lastId, ROW_COUNT - 1);
    } finally {
      await Bun.file(tmpPath).delete();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Taxonomy mapper — every legacy spelling
//    migrations/2026-09-02-normalize-legacy-taxonomy.sql names.
// ---------------------------------------------------------------------------

describe("normalizeLegacyTaxonomy: every pattern the 2026-09-02 migration names", () => {
  test("MITRA-BORNEO (hyphen) normalizes to MITRA BORNEO (space)", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("MITRA-BORNEO", "Pemkab Kapuas"), {
      jenisRubrik: "MITRA BORNEO",
      kategori: "Pemkab Kapuas"
    });
  });

  test("a stray </option> fragment is stripped from kategori", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("MITRA BORNEO", "Pemkab Seruyan/option>"), {
      jenisRubrik: "MITRA BORNEO",
      kategori: "Pemkab Seruyan"
    });
  });

  test("a leaf institution name stored bare in jenis_rubrik moves to MITRA BORNEO/<name>", () => {
    for (const prefix of ["Pemkab", "Pemko", "Pemprov", "DPRD"]) {
      const leaf = `${prefix} Contoh`;
      assert.deepEqual(normalizeLegacyTaxonomy(leaf, ""), {
        jenisRubrik: "MITRA BORNEO",
        kategori: leaf
      });
    }
  });

  test("a leaf daerah name stored bare in jenis_rubrik moves to DAERAH/<name>", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("Kapuas", ""), {
      jenisRubrik: "DAERAH",
      kategori: "Kapuas"
    });
  });

  test("a leaf UMUM name stored bare in jenis_rubrik moves to UMUM/<name>", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("Provinsi", ""), {
      jenisRubrik: "UMUM",
      kategori: "Provinsi"
    });
  });

  test("WISATA (the rubrik, all caps) is NOT captured by the UMUM leaf-label move — binary/case-sensitive comparison", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("WISATA", ""), {
      jenisRubrik: "WISATA",
      kategori: ""
    });
  });

  test("Palangkaraya (no space) normalizes to Palangka Raya wherever it appears as kategori", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("DAERAH", "Palangkaraya"), {
      jenisRubrik: "DAERAH",
      kategori: "Palangka Raya"
    });
    assert.deepEqual(normalizeLegacyTaxonomy("MITRA BORNEO", "DPRD Palangkaraya"), {
      jenisRubrik: "MITRA BORNEO",
      kategori: "DPRD Palangka Raya"
    });
  });

  test("OLAHRAGA with a stray kategori has it cleared (its admin form has no such field)", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("OLAHRAGA", "Sepak Bola"), {
      jenisRubrik: "OLAHRAGA",
      kategori: ""
    });
  });

  test("UTAMA/METROPOLIS/DAERAH-with-empty-kategori are deliberately left untouched (the migration's own carve-out)", () => {
    assert.deepEqual(normalizeLegacyTaxonomy("UTAMA", ""), { jenisRubrik: "UTAMA", kategori: "" });
    assert.deepEqual(normalizeLegacyTaxonomy("METROPOLIS", ""), {
      jenisRubrik: "METROPOLIS",
      kategori: ""
    });
    assert.deepEqual(normalizeLegacyTaxonomy("DAERAH", ""), { jenisRubrik: "DAERAH", kategori: "" });
  });
});

describe("mapLegacyTaxonomy: classification + legacyName (the flat category-name value blog:legacy:import's --term-map keys on)", () => {
  test("the five plain rubriks map to their committed slug, legacyName is the rubrik itself", () => {
    const expected = {
      POLITIK: "politik",
      HUKUM: "hukum",
      NASIONAL: "nasional",
      OLAHRAGA: "olahraga",
      WISATA: "wisata"
    };
    for (const [jenis, slug] of Object.entries(expected)) {
      const result = mapLegacyTaxonomy(jenis, "");
      assert.deepEqual(result, {
        ok: true,
        value: { kind: "rubrik", rubrikSlug: slug, legacyName: jenis }
      });
    }
  });

  test("DAERAH + a region name maps to kind:daerah, legacyName is the region", () => {
    assert.deepEqual(mapLegacyTaxonomy("DAERAH", "Kapuas"), {
      ok: true,
      value: { kind: "daerah", regionName: "Kapuas", legacyName: "Kapuas" }
    });
  });

  test("MITRA BORNEO + an institution name maps to kind:mitra, legacyName is the institution", () => {
    assert.deepEqual(mapLegacyTaxonomy("MITRA-BORNEO", "Pemkab Kapuas"), {
      ok: true,
      value: { kind: "mitra", institutionName: "Pemkab Kapuas", legacyName: "Pemkab Kapuas" }
    });
  });

  test("UMUM + a valid child maps to kind:umum, including the WISATA-colliding child", () => {
    assert.deepEqual(mapLegacyTaxonomy("UMUM", "Wisata"), {
      ok: true,
      value: { kind: "umum", childName: "Wisata", legacyName: "Wisata" }
    });
  });

  test("UTAMA/METROPOLIS/DAERAH-with-no-kategori are reported as unmapped, never guessed at", () => {
    assert.equal(mapLegacyTaxonomy("UTAMA", "").ok, false);
    assert.equal(mapLegacyTaxonomy("METROPOLIS", "").ok, false);
    assert.equal(mapLegacyTaxonomy("DAERAH", "").ok, false);
  });

  test("every one of the 45 (jenis_rubrik, kategori) combinations observed in the real dump on 2026-09-18 maps cleanly", () => {
    const observed = [
      ["HUKUM", ""], ["MITRA BORNEO", "Pemkab Kotawaringin Timur"], ["UMUM", "Provinsi"],
      ["DAERAH", "Kotawaringin Timur"], ["MITRA BORNEO", "DPRD Kalteng"], ["MITRA BORNEO", "Pemkab Kapuas"],
      ["MITRA BORNEO", "DPRD Kotawaringin Timur"], ["NASIONAL", ""], ["MITRA BORNEO", "DPRD Kapuas"],
      ["MITRA BORNEO", "DPRD Palangka Raya"], ["MITRA BORNEO", "Pemko Palangka Raya"],
      ["MITRA BORNEO", "Pemprov Kalteng"], ["MITRA BORNEO", "Pemkab Lamandau"],
      ["MITRA BORNEO", "Pemkab Pulang Pisau"], ["DAERAH", "Palangka Raya"], ["MITRA BORNEO", "DPRD Murung Raya"],
      ["POLITIK", ""], ["MITRA BORNEO", "Pemkab Gunung Mas"], ["MITRA BORNEO", "DPRD Seruyan"],
      ["MITRA BORNEO", "Pemkab Barito Timur"], ["DAERAH", "Lamandau"], ["MITRA BORNEO", "Pemkab Murung Raya"],
      ["DAERAH", "Kapuas"], ["MITRA BORNEO", "Pemkab Katingan"], ["DAERAH", "Pulang Pisau"],
      ["MITRA BORNEO", "Pemkab Seruyan"], ["OLAHRAGA", ""], ["MITRA BORNEO", "DPRD Pulang Pisau"],
      ["DAERAH", "Kotawaringin Barat"], ["UMUM", "Budaya"], ["DAERAH", "Murung Raya"], ["DAERAH", "Barito Timur"],
      ["UMUM", "Bisnis"], ["DAERAH", "Gunung Mas"], ["DAERAH", "Barito Selatan"], ["WISATA", ""],
      ["DAERAH", "Katingan"], ["DAERAH", "Barito Utara"], ["MITRA BORNEO", "Pemkab Barito Utara"],
      ["UMUM", "Wisata"], ["DAERAH", "Seruyan"], ["UMUM", "Kuliner"], ["DAERAH", "Sukamara"],
      ["MITRA BORNEO", "DPRD Lamandau"], ["MITRA BORNEO", "DPRD Barito Timur"]
    ];
    assert.equal(observed.length, 45);

    const unmapped = observed.filter(([jenis, kategori]) => !mapLegacyTaxonomy(jenis, kategori).ok);
    assert.deepEqual(unmapped, [], "every real-dump combination must map — 0 unmapped taxonomy values");
  });
});

describe("termMapHintFor: the guidance this exporter writes to term-map-hints.json", () => {
  test("a rubrik hint suggests the committed term slug", () => {
    const outcome = mapLegacyTaxonomy("HUKUM", "").value;
    assert.deepEqual(termMapHintFor(outcome), {
      kind: "rubrik",
      suggestedTermSlugCandidates: ["hukum"]
    });
  });

  test("a daerah hint suggests the daerah term plus a Pemkab institution guess", () => {
    const outcome = mapLegacyTaxonomy("DAERAH", "Kapuas").value;
    assert.deepEqual(termMapHintFor(outcome), {
      kind: "daerah",
      suggestedTermSlugCandidates: ["daerah"],
      suggestedInstitutionName: "Pemkab Kapuas"
    });
  });

  test("Palangka Raya is a Pemko, not a Pemkab", () => {
    const outcome = mapLegacyTaxonomy("DAERAH", "Palangka Raya").value;
    assert.equal(termMapHintFor(outcome).suggestedInstitutionName, "Pemko Palangka Raya");
  });

  test("a mitra hint's institution name is the category name itself", () => {
    const outcome = mapLegacyTaxonomy("MITRA BORNEO", "DPRD Kalteng").value;
    assert.deepEqual(termMapHintFor(outcome), {
      kind: "mitra",
      suggestedTermSlugCandidates: ["mitra-borneo"],
      suggestedInstitutionName: "DPRD Kalteng"
    });
  });

  test("the UMUM/Wisata collision lists both of issue #57's candidate slugs, in order", () => {
    const outcome = mapLegacyTaxonomy("UMUM", "Wisata").value;
    assert.deepEqual(termMapHintFor(outcome).suggestedTermSlugCandidates, ["wisata-travel", "wisata"]);
  });

  test("an ordinary UMUM child suggests its own lowercase name as the slug", () => {
    const outcome = mapLegacyTaxonomy("UMUM", "Budaya").value;
    assert.deepEqual(termMapHintFor(outcome).suggestedTermSlugCandidates, ["budaya"]);
  });
});

// ---------------------------------------------------------------------------
// 3. buildPostRecord / buildVideoRecord — the exact legacy-import-record.ts shape
// ---------------------------------------------------------------------------

describe("buildPostRecord: matches legacy-import-record.ts's LegacyImportRecord field-for-field", () => {
  const now = new Date("2026-09-18T00:00:00Z");

  function row(overrides = {}) {
    return {
      id_ber: 25,
      judul: "Dukung KLA, BPBD Pulpis dan DP3AP2KB Teken MoU",
      sub_judul: "Sebuah ringkasan",
      isi_berita: '<p style="text-align: justify;">Isi berita <strong>lengkap</strong>.</p>',
      foto_berita: "091255-sb2.jpeg",
      jenis_rubrik: "MITRA BORNEO",
      kategori: "Pemkab Pulang Pisau",
      tgl: "2026-09-04",
      jam: "14:30:00",
      user: "Redaksi",
      ...overrides
    };
  }

  test("produces every field legacy-import-record.ts's parser reads, nothing more that would confuse it", () => {
    const built = buildPostRecord(row(), new Set(), now);
    assert.ok(built.ok);
    assert.deepEqual(Object.keys(built.record).sort(), [
      "bodyHtml", "categories", "excerpt", "featuredImageSrc", "legacyId",
      "locale", "publishedAt", "slug", "status", "title"
    ]);
    assert.equal(built.record.legacyId, "25");
    assert.equal(built.record.slug, "dukung-kla-bpbd-pulpis-dan-dp3ap2kb-teken-mou");
    assert.equal(built.record.status, "published");
    assert.equal(built.record.publishedAt, "2026-09-04T07:30:00.000Z");
    assert.deepEqual(built.record.categories, ["Pemkab Pulang Pisau"]);
    assert.equal(built.record.featuredImageSrc, "091255-sb2.jpeg");
    // bodyHtml is the RAW legacy HTML, untouched — upstream's own converter handles it.
    assert.equal(built.record.bodyHtml, row().isi_berita);
  });

  test("bodyHtml is passed through verbatim — this exporter never converts it itself", () => {
    const dangerous = row({ isi_berita: "<p>Hello</p><script>alert(1)</script>" });
    const built = buildPostRecord(dangerous, new Set(), now);
    assert.ok(built.ok);
    assert.equal(built.record.bodyHtml, dangerous.isi_berita);
  });

  test("a future publishedAt is exported as status:draft rather than published", () => {
    const future = row({ tgl: "2027-01-01", jam: "00:00:00" });
    const built = buildPostRecord(future, new Set(), now);
    assert.ok(built.ok);
    assert.equal(built.record.status, "draft");
  });

  test("an unmapped taxonomy value is refused, not guessed at", () => {
    const built = buildPostRecord(row({ jenis_rubrik: "UTAMA", kategori: "" }), new Set(), now);
    assert.equal(built.ok, false);
    assert.equal(built.table, "berita_red");
  });

  test("an implausible date (the real dump's one '0025' row) is refused", () => {
    const built = buildPostRecord(row({ tgl: "0025-08-03" }), new Set(), now);
    assert.equal(built.ok, false);
  });

  test("an empty foto_berita becomes null, not an empty string", () => {
    const built = buildPostRecord(row({ foto_berita: "" }), new Set(), now);
    assert.ok(built.ok);
    assert.equal(built.record.featuredImageSrc, null);
  });
});

describe("buildVideoRecord: berita_vid, with the documented link-not-embed degradation", () => {
  const now = new Date("2026-09-18T00:00:00Z");

  function row(overrides = {}) {
    return {
      id_vid: 5,
      judul_vid: "Banjir Disejumlah Daerah",
      link: "CpFjEwC0fRg",
      text_vid: "<p>Banjir</p>",
      tgl: "221120",
      jam: "031607",
      admin: "Admin",
      ...overrides
    };
  }

  test("bodyHtml is text_vid plus a plain link to the video, never an embed", () => {
    const built = buildVideoRecord(row(), new Set(), now);
    assert.ok(built.ok);
    assert.ok(built.record.bodyHtml.startsWith(row().text_vid));
    assert.ok(built.record.bodyHtml.includes('<a href="https://youtu.be/CpFjEwC0fRg">'));
    assert.ok(!built.record.bodyHtml.includes("<iframe"));
  });

  test("a link that does not normalize to a YouTube id is refused", () => {
    const built = buildVideoRecord(row({ link: "" }), new Set(), now);
    assert.equal(built.ok, false);
    assert.equal(built.table, "berita_vid");
  });

  test("YYMMDD/HHMMSS timestamps are reformatted and dated correctly", () => {
    const built = buildVideoRecord(row(), new Set(), now);
    assert.ok(built.ok);
    // 221120 031607 -> 2022-11-20 03:16:07 WIB -> UTC (-7h)
    assert.equal(built.record.publishedAt, "2022-11-19T20:16:07.000Z");
  });
});

// ---------------------------------------------------------------------------
// 4. Slug collision, redirects, URLs
// ---------------------------------------------------------------------------

describe("newPostSlug: -{id_ber} on collision", () => {
  test("the first article with a given title keeps the plain slug", () => {
    assert.equal(newPostSlug("Banjir di Sampit", 100, new Set()), "banjir-di-sampit");
  });

  test("a second article with the SAME title (sb_slug collision) gets -{id_ber} appended", () => {
    const taken = new Set(["banjir-di-sampit"]);
    assert.equal(newPostSlug("Banjir di Sampit", 200, taken), "banjir-di-sampit-200");
  });

  test("a title that slugifies to an empty string falls back to a legacy-id-based slug", () => {
    assert.equal(newPostSlug("!!!", 42, new Set()), "berita-42");
  });
});

describe("legacy URL construction", () => {
  test("current-style URL matches seputarborneo_id_slug()/seputarborneo_news_href()", () => {
    assert.equal(
      legacyNewsUrlCurrent(25, "Dukung KLA, BPBD Pulpis dan DP3AP2KB Teken MoU"),
      "/news/25-dukung-kla-bpbd-pulpis-dan-dp3ap2kb-teken-mou.html"
    );
  });

  test("pre-2.0 URL replaces spaces with underscores and rawurlencode()s the rest, case preserved, built from the RAW title", () => {
    assert.equal(legacyNewsUrlPre2000(25, "Banjir di Sampit"), "/news/25_Banjir_di_Sampit.html");
  });

  test("video URL matches sb_video_url()'s ?video= query form", () => {
    assert.equal(legacyVideoUrl(5, "Banjir Disejumlah Daerah"), "/video/?video=5-banjir-disejumlah-daerah.html");
  });

  test("sbSlug strips punctuation and collapses whitespace/hyphens like the PHP original", () => {
    assert.equal(sbSlug("  Hello,   World!!  "), "hello-world");
    assert.equal(sbSlug("Under_score_Name"), "under-score-name");
  });

  test("phpRawUrlEncode additionally escapes ! * ' ( ) that encodeURIComponent leaves bare", () => {
    assert.equal(phpRawUrlEncode("a(b)c'd!e*f"), "a%28b%29c%27d%21e%2Af");
  });
});

describe("buildRedirectEntry: correct even for a colliding (suffixed) stored slug — the reason this exporter does not delegate to blog:legacy:redirects:import's own {slug} templating", () => {
  test("targets the CMS's own canonical /blog/{tenantCode}/{slug} URL, origin import", () => {
    const entry = buildRedirectEntry("/news/25-dukung-kla.html", "borneojek-mart", "dukung-kla");
    assert.deepEqual(entry, {
      sourcePath: "/news/25-dukung-kla.html",
      target: "/blog/borneojek-mart/dukung-kla",
      origin: "import",
      statusCode: 301
    });
  });

  test("a collision-suffixed slug still produces the CORRECT source path (built from the raw title, not the stored slug)", () => {
    // Two articles titled "Banjir di Sampit": the second gets a suffixed
    // stored slug, but its LEGACY current-style URL never had that suffix.
    const source = legacyNewsUrlCurrent(200, "Banjir di Sampit");
    const entry = buildRedirectEntry(source, "borneojek-mart", "banjir-di-sampit-200");
    assert.equal(entry.sourcePath, "/news/200-banjir-di-sampit.html");
    assert.equal(entry.target, "/blog/borneojek-mart/banjir-di-sampit-200");
  });
});

describe("normalizeYoutubeVideoId", () => {
  test("a bare 11-character id passes through unchanged", () => {
    assert.equal(normalizeYoutubeVideoId("CpFjEwC0fRg"), "CpFjEwC0fRg");
  });

  test("a youtu.be short link resolves to its id", () => {
    assert.equal(normalizeYoutubeVideoId("https://youtu.be/Mc44o_z06aQ"), "Mc44o_z06aQ");
  });

  test("a watch?v= URL resolves to its id", () => {
    assert.equal(
      normalizeYoutubeVideoId("https://www.youtube.com/watch?v=inc2M8ejmxA"),
      "inc2M8ejmxA"
    );
  });

  test("a non-YouTube or unparseable value resolves to null", () => {
    assert.equal(normalizeYoutubeVideoId(""), null);
    assert.equal(normalizeYoutubeVideoId("not a url at all"), null);
  });
});

describe("resolvePublishedAt", () => {
  const now = new Date("2026-09-18T00:00:00Z");

  test("a well-formed past tgl/jam converts from Asia/Jakarta (UTC+7) to UTC", () => {
    const result = resolvePublishedAt("2026-09-04", "14:30:00", now);
    assert.ok(result.ok);
    assert.equal(result.publishedAt.toISOString(), "2026-09-04T07:30:00.000Z");
  });

  test("an implausible year (the real dump's one '0025' row) is refused, never silently imported", () => {
    const result = resolvePublishedAt("0025-08-03", "10:00:00", now);
    assert.equal(result.ok, false);
  });

  test("a non-string tgl/jam (unexpected dump shape) is refused rather than throwing", () => {
    const result = resolvePublishedAt(20260904, "10:00:00", now);
    assert.equal(result.ok, false);
  });
});

describe("buildSiteProfileUpdateFromConfig", () => {
  test("maps motto/coppyright/alamat/email/wasupport and only http(s) social links", () => {
    const update = buildSiteProfileUpdateFromConfig({
      motho: "Motto situs",
      coppyright: "© Contoh",
      alamat: "Jl. Contoh",
      email: "redaksi@contoh.test",
      wasupport: "0812-0000-0000",
      fb: "https://facebook.com/contoh",
      tw: "https://x.com/contoh",
      ig: "",
      yt: "javascript:alert(1)",
      tt: "https://tiktok.com/@contoh",
      th: ""
    });
    assert.equal(update.tagline, "Motto situs");
    assert.equal(update.copyrightNotice, "© Contoh");
    assert.equal(update.editorialAddress, "Jl. Contoh");
    assert.equal(update.contactEmail, "redaksi@contoh.test");
    assert.equal(update.whatsappNumber, "0812-0000-0000");
    assert.deepEqual(update.socialLinks, [
      { platform: "facebook", url: "https://facebook.com/contoh" },
      { platform: "x", url: "https://x.com/contoh" },
      { platform: "tiktok", url: "https://tiktok.com/@contoh" }
    ]);
  });
});
