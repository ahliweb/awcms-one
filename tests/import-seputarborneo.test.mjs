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
 *   4. `buildRedirectEntry`/URL construction, and slug-collision handling —
 *      including the two review-round-2 contract points: `origin:
 *      "legacy_blog"` (the only origin the storefront serves) and the
 *      query-free synthetic `/video/{id}-{slug}.html` source key (the CMS
 *      strips a source's query string, so the real `?video=` URL cannot be
 *      stored).
 *   5. `tools/lib/redirect-push.ts` — the `--push-redirects` chunker,
 *      idempotency-key derivation, file-wide duplicate guard, and the whole
 *      dry-run/commit loop against a fake poster and a mocked `fetch`.
 */
import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  videoRedirectSourcePath,
  normalizeLegacyTaxonomy,
  mapLegacyTaxonomy,
  termMapHintFor,
  normalizeYoutubeVideoId,
  resolvePublishedAt,
  newPostSlug,
  buildPostRecord,
  buildVideoRecord,
  buildRedirectEntry,
  buildSiteProfileUpdateFromConfig,
  REDIRECT_ORIGIN
} from "../tools/import-seputarborneo.ts";
import {
  MAX_REDIRECT_IMPORT_ITEMS,
  REDIRECT_IMPORT_PATH,
  chunkRedirects,
  chunkIdempotencyKey,
  stableStringify,
  importScopeKey,
  findFileWideDuplicates,
  parseRedirectFile,
  createRedirectImportPoster,
  pushRedirects,
  formatPushSummary
} from "../tools/lib/redirect-push.ts";

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

  test("its redirect source is the query-free synthetic key, never the real ?video= URL (review round 2)", () => {
    const built = buildVideoRecord(row(), new Set(), now);
    assert.ok(built.ok);
    assert.equal(built.redirectSources.current, "/video/5-banjir-disejumlah-daerah.html");
    assert.equal(built.redirectSources.pre2000, undefined);
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

  test("the REAL video URL matches sb_video_url()'s ?video= query form (documentation only — never a redirect source)", () => {
    assert.equal(legacyVideoUrl(5, "Banjir Disejumlah Daerah"), "/video/?video=5-banjir-disejumlah-daerah.html");
  });

  test("the video redirect SOURCE is the query-free synthetic key — the real URL with `?video=` removed, nothing else", () => {
    assert.equal(videoRedirectSourcePath(5, "Banjir Disejumlah Daerah"), "/video/5-banjir-disejumlah-daerah.html");
    assert.equal(
      videoRedirectSourcePath(5, "Banjir Disejumlah Daerah"),
      legacyVideoUrl(5, "Banjir Disejumlah Daerah").replace("/video/?video=", "/video/")
    );
    assert.ok(!videoRedirectSourcePath(5, "Banjir Disejumlah Daerah").includes("?"));
  });

  test("a video whose title slugifies to nothing still gets a per-id key (`/video/{id}.html`) the storefront's `[-_.]` index accepts", () => {
    assert.equal(videoRedirectSourcePath(7, "!!!"), "/video/7.html");
    assert.match(videoRedirectSourcePath(7, "!!!"), /^\/video\/(\d+)[-_.]/);
  });

  test("every video source key matches the storefront's `rowIdIndexFor` video pattern and carries the id it indexes by", () => {
    for (const [id, title] of [[1, "Banjir"], [42, "Pemilu 2024: Hasil"], [999, ""]]) {
      const match = /^\/video\/(\d+)[-_.]/.exec(videoRedirectSourcePath(id, title));
      assert.ok(match, `no match for id ${id}`);
      assert.equal(match[1], String(id));
    }
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
  test("targets the CMS's own canonical /blog/{tenantCode}/{slug} URL, origin legacy_blog", () => {
    const entry = buildRedirectEntry("/news/25-dukung-kla.html", "borneojek-mart", "dukung-kla");
    assert.deepEqual(entry, {
      sourcePath: "/news/25-dukung-kla.html",
      target: "/blog/borneojek-mart/dukung-kla",
      origin: "legacy_blog",
      statusCode: 301
    });
  });

  test("origin is legacy_blog — the ONLY origin apps/storefront's getLegacyRedirectRows() keeps — never the route's default `import`", () => {
    // Read straight off the storefront's own filter so a change on either
    // side fails here, not silently at the next build.
    const blogTs = readFileSync("apps/storefront/src/lib/awcms/blog.ts", "utf8");
    assert.match(blogTs, /row\.origin === "legacy_blog"/);
    assert.equal(REDIRECT_ORIGIN, "legacy_blog");
    assert.equal(buildRedirectEntry("/news/1-a.html", "t", "a").origin, "legacy_blog");
    assert.notEqual(buildRedirectEntry("/news/1-a.html", "t", "a").origin, "import");
  });

  test("a video row's entry uses the synthetic query-free source, so no two video rows share the CMS's normalized key", () => {
    const a = buildRedirectEntry(videoRedirectSourcePath(1, "Satu"), "t", "satu");
    const b = buildRedirectEntry(videoRedirectSourcePath(2, "Dua"), "t", "dua");
    assert.notEqual(importScopeKey(a.sourcePath), importScopeKey(b.sourcePath));
    // …whereas the REAL URLs would have collapsed onto `/video` — the defect this key exists to avoid.
    assert.equal(importScopeKey(legacyVideoUrl(1, "Satu")), "/video");
    assert.equal(importScopeKey(legacyVideoUrl(2, "Dua")), "/video");
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

// ---------------------------------------------------------------------------
// 5. tools/lib/redirect-push.ts — the --push-redirects loop
// ---------------------------------------------------------------------------

/** `n` distinct, valid-looking entries — never real titles. */
function fakeEntries(n, prefix = "news") {
  return Array.from({ length: n }, (_, i) => ({
    sourcePath: `/${prefix}/${i + 1}-judul-${i + 1}.html`,
    target: `/blog/t/judul-${i + 1}`,
    origin: "legacy_blog",
    statusCode: 301
  }));
}

describe("redirect-push: chunkRedirects", () => {
  test("splits into consecutive slices of MAX_REDIRECT_IMPORT_ITEMS (200), last one shorter, order preserved", () => {
    const entries = fakeEntries(451);
    const chunks = chunkRedirects(entries);
    assert.equal(MAX_REDIRECT_IMPORT_ITEMS, 200);
    assert.deepEqual(
      chunks.map((c) => c.length),
      [200, 200, 51]
    );
    assert.deepEqual(chunks.flat(), entries);
  });

  test("an empty file is zero chunks; an exact multiple has no empty trailing chunk", () => {
    assert.deepEqual(chunkRedirects([]), []);
    assert.deepEqual(
      chunkRedirects(fakeEntries(400)).map((c) => c.length),
      [200, 200]
    );
  });

  test("refuses a non-positive chunk size rather than looping forever", () => {
    assert.throws(() => chunkRedirects(fakeEntries(3), 0), RangeError);
  });

  test("mirrors the CMS's MAX_REDIRECT_IMPORT_ITEMS — the documented copy must not drift from the subtree", () => {
    const ruleTs = readFileSync("apps/cms/src/modules/seo-distribution/domain/redirect-rule.ts", "utf8");
    const match = /export const MAX_REDIRECT_IMPORT_ITEMS = (\d+);/.exec(ruleTs);
    assert.ok(match);
    assert.equal(Number(match[1]), MAX_REDIRECT_IMPORT_ITEMS);
  });
});

describe("redirect-push: chunkIdempotencyKey — deterministic from CONTENT, not position", () => {
  test("the same chunk always derives the same key, with the seputarborneo-redirects- prefix and a full sha256", () => {
    const chunk = fakeEntries(3);
    const key = chunkIdempotencyKey(chunk);
    assert.equal(key, chunkIdempotencyKey(fakeEntries(3)));
    assert.match(key, /^seputarborneo-redirects-[0-9a-f]{64}$/);
  });

  test("key order inside an item does not change the key (stableStringify sorts keys)", () => {
    const a = [{ sourcePath: "/news/1-a.html", target: "/blog/t/a", origin: "legacy_blog", statusCode: 301 }];
    const b = [{ statusCode: 301, origin: "legacy_blog", target: "/blog/t/a", sourcePath: "/news/1-a.html" }];
    assert.equal(chunkIdempotencyKey(a), chunkIdempotencyKey(b));
    assert.equal(stableStringify(a), stableStringify(b));
  });

  test("any change to any item — or a shifted boundary — yields a different key", () => {
    const base = fakeEntries(5);
    const edited = fakeEntries(5);
    edited[4] = { ...edited[4], target: "/blog/t/other" };
    assert.notEqual(chunkIdempotencyKey(base), chunkIdempotencyKey(edited));
    assert.notEqual(chunkIdempotencyKey(base), chunkIdempotencyKey(fakeEntries(6).slice(1)));
  });
});

describe("redirect-push: importScopeKey / findFileWideDuplicates — the CMS's query-stripping normalization, applied to the WHOLE file", () => {
  test("drops query and fragment, collapses //, upper-cases %xx, strips one trailing slash — as redirect-path.ts does", () => {
    assert.equal(importScopeKey("/video/?video=5-a.html"), "/video");
    assert.equal(importScopeKey("/news//1-a.html/"), "/news/1-a.html");
    assert.equal(importScopeKey("/news/1-%c3%a9.html#x"), "/news/1-%C3%A9.html");
    assert.equal(importScopeKey("/"), "/");
  });

  test("the OLD ?video= shape collapses every video row onto /video — exactly the defect the synthetic key removes", () => {
    const old = [1, 2, 3].map((id) => ({
      sourcePath: legacyVideoUrl(id, `Video ${id}`),
      target: `/blog/t/video-${id}`,
      origin: "legacy_blog",
      statusCode: 301
    }));
    assert.deepEqual(findFileWideDuplicates(old), [{ scopeKey: "/video", indexes: [0, 1, 2] }]);

    const fixed = [1, 2, 3].map((id) => ({
      sourcePath: videoRedirectSourcePath(id, `Video ${id}`),
      target: `/blog/t/video-${id}`,
      origin: "legacy_blog",
      statusCode: 301
    }));
    assert.deepEqual(findFileWideDuplicates(fixed), []);
  });

  test("a duplicate that straddles two chunks is still found (the route only sees one chunk at a time)", () => {
    const entries = fakeEntries(201);
    entries[200] = { ...entries[200], sourcePath: `${entries[0].sourcePath}?utm=x` };
    assert.deepEqual(findFileWideDuplicates(entries), [{ scopeKey: "/news/1-judul-1.html", indexes: [0, 200] }]);
  });
});

describe("redirect-push: parseRedirectFile", () => {
  test("accepts an array of { sourcePath, target } objects and refuses anything else", () => {
    assert.equal(parseRedirectFile(fakeEntries(2)).length, 2);
    assert.throws(() => parseRedirectFile({ redirects: [] }), /JSON array/);
    assert.throws(() => parseRedirectFile([{ sourcePath: 1 }]), /entry #0/);
  });
});

/** A fake poster that records every call and answers from a scripted queue, defaulting to an all-ok reply. */
function fakePoster(script = []) {
  const calls = [];
  const post = async (body, idempotencyKey) => {
    calls.push({ body, idempotencyKey });
    const next = script.shift();
    if (next) return next(body, idempotencyKey);
    const results = body.redirects.map((entry, index) => ({ index, ok: true, normalizedSourcePath: entry.sourcePath }));
    return body.dryRun
      ? {
          status: 200,
          ok: true,
          data: { dryRun: true, total: body.redirects.length, valid: body.redirects.length, results },
          raw: {}
        }
      : {
          status: 200,
          ok: true,
          data: { dryRun: false, total: body.redirects.length, created: body.redirects.length, results },
          raw: {}
        };
  };
  return { post, calls };
}

describe("redirect-push: pushRedirects — dry run (the default)", () => {
  test("sends every chunk with dryRun: true and an Idempotency-Key, and reports success without ever committing", async () => {
    const { post, calls } = fakePoster();
    const lines = [];
    const summary = await pushRedirects(fakeEntries(450), { commit: false, post, log: (l) => lines.push(l) });

    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.body.dryRun === true));
    assert.ok(calls.every((c) => /^seputarborneo-redirects-[0-9a-f]{64}$/.test(c.idempotencyKey)));
    assert.deepEqual(
      calls.map((c) => c.body.redirects.length),
      [200, 200, 50]
    );
    assert.equal(summary.mode, "dry-run");
    assert.equal(summary.failed, 0);
    assert.equal(summary.succeeded, 3);
    assert.equal(summary.created, 0);
    assert.match(formatPushSummary(summary), /rerun with --commit/);
  });

  test("a dry run that refuses items (HTTP 200, valid < total) is a FAILED chunk: per-item reports surface and later chunks are not sent", async () => {
    const { post, calls } = fakePoster([
      async (body) => ({
        status: 200,
        ok: true,
        data: {
          dryRun: true,
          total: body.redirects.length,
          valid: body.redirects.length - 1,
          results: body.redirects.map((_, index) =>
            index === 3
              ? { index, ok: false, code: "VALIDATION_ERROR", errors: [{ field: "sourcePath", message: "x" }] }
              : { index, ok: true }
          )
        },
        raw: {}
      })
    ]);
    const lines = [];
    const summary = await pushRedirects(fakeEntries(401), { commit: false, post, log: (l) => lines.push(l) });

    assert.equal(calls.length, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.attempted, 1);
    assert.equal(summary.outcomes[0].refused.length, 1);
    assert.equal(summary.outcomes[0].refused[0].index, 3);
    // The file-level entry number (chunk offset + item index) is what the operator needs.
    assert.ok(lines.some((l) => /entry 3\s+VALIDATION_ERROR/.test(l)));
  });

  test("file-wide duplicates stop the run BEFORE any call — the route could only have caught them per chunk", async () => {
    const { post, calls } = fakePoster();
    const entries = fakeEntries(3);
    entries[2] = { ...entries[2], sourcePath: "/news/1-judul-1.html?x=1" };
    const summary = await pushRedirects(entries, { commit: true, post });
    assert.equal(calls.length, 0);
    assert.equal(summary.failed, 1);
    assert.equal(summary.duplicates.length, 1);
  });
});

describe("redirect-push: pushRedirects — --commit", () => {
  test("sends real chunks (dryRun: false) with a content-derived key each, sums `created`, exits clean", async () => {
    const { post, calls } = fakePoster();
    const entries = fakeEntries(250);
    const summary = await pushRedirects(entries, { commit: true, post });

    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.body.dryRun === false));
    assert.equal(calls[0].idempotencyKey, chunkIdempotencyKey(entries.slice(0, 200)));
    assert.equal(calls[1].idempotencyKey, chunkIdempotencyKey(entries.slice(200)));
    assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
    assert.equal(summary.created, 250);
    assert.equal(summary.failed, 0);
    assert.match(formatPushSummary(summary), /rules created\s+250/);
  });

  test("a rerun after a crash sends the IDENTICAL keys, so the CMS replays the committed chunks instead of duplicating them", async () => {
    const entries = fakeEntries(401);
    const first = fakePoster([
      undefined,
      undefined,
      async () => {
        throw new Error("connection reset");
      }
    ]);
    await assert.rejects(pushRedirects(entries, { commit: true, post: first.post }), /connection reset/);
    assert.equal(first.calls.length, 3);

    const second = fakePoster();
    const summary = await pushRedirects(entries, { commit: true, post: second.post });
    assert.deepEqual(
      second.calls.map((c) => c.idempotencyKey),
      first.calls.map((c) => c.idempotencyKey)
    );
    assert.equal(summary.failed, 0);
  });

  test("a 400 IMPORT_VALIDATION_FAILED chunk is reported from error.details.results, stops the run, and is non-zero", async () => {
    const { post, calls } = fakePoster([
      undefined,
      async () => ({
        status: 400,
        ok: false,
        data: null,
        raw: {
          success: false,
          error: {
            code: "IMPORT_VALIDATION_FAILED",
            message: "One or more items are invalid; nothing was imported.",
            details: {
              results: [{ index: 7, ok: false, code: "CONFLICT", normalizedSourcePath: "/news/208-judul-208.html" }]
            }
          },
          meta: {}
        }
      })
    ]);
    const lines = [];
    const summary = await pushRedirects(fakeEntries(600), { commit: true, post, log: (l) => lines.push(l) });

    assert.equal(calls.length, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.created, 200);
    assert.equal(summary.outcomes[1].code, "IMPORT_VALIDATION_FAILED");
    assert.ok(lines.some((l) => /entry 207\s+CONFLICT/.test(l)));
    assert.match(formatPushSummary(summary), /stopped at the first failed chunk/);
  });

  test("a 409 IDEMPOTENCY_CONFLICT (same key, different body) is a failed chunk too", async () => {
    const { post } = fakePoster([
      async () => ({
        status: 409,
        ok: false,
        data: null,
        raw: { success: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "…" }, meta: {} }
      })
    ]);
    const summary = await pushRedirects(fakeEntries(5), { commit: true, post });
    assert.equal(summary.failed, 1);
    assert.equal(summary.outcomes[0].code, "IDEMPOTENCY_CONFLICT");
  });
});

describe("redirect-push: createRedirectImportPoster — the exact wire shape the route reads, over a mocked fetch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs /api/v1/seo/redirects/import with { redirects, dryRun }, the idempotency-key header, and the tenant/bearer pair", async () => {
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          success: true,
          data: { dryRun: true, total: 2, valid: 2, results: [{ index: 0, ok: true }, { index: 1, ok: true }] },
          meta: {}
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const post = createRedirectImportPoster("http://cms.test", { tenantId: "tenant-1", token: "tok" });
    const chunk = fakeEntries(2);
    const key = chunkIdempotencyKey(chunk);
    const result = await post({ redirects: chunk, dryRun: true }, key);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `http://cms.test${REDIRECT_IMPORT_PATH}`);
    assert.equal(seen[0].init.method, "POST");
    assert.equal(seen[0].init.headers["idempotency-key"], key);
    assert.equal(seen[0].init.headers["x-awcms-tenant-id"], "tenant-1");
    assert.equal(seen[0].init.headers.authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(seen[0].init.body), { redirects: chunk, dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.data.valid, 2);
  });

  test("the whole loop over the mocked fetch: 450 entries -> 3 POSTs, every one carrying a distinct content-derived key", async () => {
    const keys = [];
    globalThis.fetch = async (_url, init) => {
      keys.push(init.headers["idempotency-key"]);
      const body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            dryRun: false,
            total: body.redirects.length,
            created: body.redirects.length,
            results: body.redirects.map((_, index) => ({ index, ok: true }))
          },
          meta: {}
        }),
        { status: 200 }
      );
    };
    const post = createRedirectImportPoster("http://cms.test", { tenantId: "t", token: "k" });
    const summary = await pushRedirects(fakeEntries(450), { commit: true, post });
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys).size, 3);
    assert.equal(summary.created, 450);
  });
});
