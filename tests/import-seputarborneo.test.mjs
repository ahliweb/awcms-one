/**
 * tests/import-seputarborneo.test.mjs — issue #58.
 *
 * Unit coverage for the seputarborneo importer's four pure surfaces, all on
 * hand-authored fixtures (never the real dump, which is never committed):
 *
 *   1. `tools/lib/mysql-dump-reader.ts` — the streaming tokenizer (quotes,
 *      `\'`/`\n`/NULL escapes, multi-row `VALUES`, a 3 MB synthetic dump fed
 *      through in small chunks so it genuinely exercises the "never buffer
 *      more than one row" contract).
 *   2. `tools/import-seputarborneo.ts`'s taxonomy mapper, against every
 *      legacy spelling `migrations/2026-09-02-normalize-legacy-taxonomy.sql`
 *      names (read from the reference seputarborneo clone during this
 *      issue's development — see that migration's own comments for the
 *      counts this test's fixtures are drawn from).
 *   3. `tools/lib/html-to-portable-text.ts` — the tag set issue #58 lists.
 *   4. `newPostSlug`'s collision handling (`-{id_ber}` suffix).
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  SqlInsertTokenizer,
  extractCreateTableColumns,
  tryParseValueTuple,
  readMysqlDumpRows
} from "../tools/lib/mysql-dump-reader.ts";
import { convertHtmlToPortableText } from "../tools/lib/html-to-portable-text.ts";
import {
  sbSlug,
  phpRawUrlEncode,
  legacyNewsUrlCurrent,
  legacyNewsUrlPre2000,
  legacyVideoUrl,
  normalizeLegacyTaxonomy,
  mapLegacyTaxonomy,
  normalizeYoutubeVideoId,
  resolvePublishedAt,
  newPostSlug,
  buildRedirectPayload,
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
    // 'a\\' -> the string "a\" — a literal backslash, then the closing quote.
    const r = tryParseValueTuple("(1,'a\\\\')", 0);
    assert.ok(r.ok);
    assert.deepEqual(r.values, [1, "a\\"]);
  });

  test("an incomplete tuple (buffer ends mid-string) reports ok:false, not an error", () => {
    const r = tryParseValueTuple("(1,'unterminated", 0);
    assert.equal(r.ok, false);
  });

  test("an incomplete NULL at the exact buffer boundary reports ok:false", () => {
    // Only "NUL" buffered — must not be mistaken for a parse error.
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
    // Feed one CHARACTER at a time — the worst case for chunk-boundary bugs.
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
    // A "3 MB synthetic file" per issue #58's own acceptance list — one row's
    // body is padded to ~3 KB so ~1000 rows crosses 3 MB of decompressed SQL,
    // and it is genuinely written to a temp file and read back through
    // `Bun.file(...).stream()` (the real code path), not held as one string.
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
    // The migration's own point: `IN ('Wisata')` must not also catch `WISATA`.
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

describe("mapLegacyTaxonomy: classification after normalization", () => {
  test("the five plain rubriks map to their committed slug (issue #57's own naming)", () => {
    const expected = {
      POLITIK: "politik",
      HUKUM: "hukum",
      NASIONAL: "nasional",
      OLAHRAGA: "olahraga",
      WISATA: "wisata"
    };
    for (const [jenis, slug] of Object.entries(expected)) {
      assert.deepEqual(mapLegacyTaxonomy(jenis, ""), {
        ok: true,
        value: { kind: "rubrik", rubrikSlug: slug }
      });
    }
  });

  test("DAERAH + a region name maps to kind:daerah", () => {
    assert.deepEqual(mapLegacyTaxonomy("DAERAH", "Kapuas"), {
      ok: true,
      value: { kind: "daerah", regionName: "Kapuas" }
    });
  });

  test("MITRA BORNEO + an institution name maps to kind:mitra", () => {
    assert.deepEqual(mapLegacyTaxonomy("MITRA-BORNEO", "Pemkab Kapuas"), {
      ok: true,
      value: { kind: "mitra", institutionName: "Pemkab Kapuas" }
    });
  });

  test("UMUM + a valid child maps to kind:umum, including the WISATA-colliding child", () => {
    assert.deepEqual(mapLegacyTaxonomy("UMUM", "Wisata"), {
      ok: true,
      value: { kind: "umum", childName: "Wisata" }
    });
  });

  test("UTAMA/METROPOLIS/DAERAH-with-no-kategori are reported as unmapped, never guessed at", () => {
    assert.equal(mapLegacyTaxonomy("UTAMA", "").ok, false);
    assert.equal(mapLegacyTaxonomy("METROPOLIS", "").ok, false);
    assert.equal(mapLegacyTaxonomy("DAERAH", "").ok, false);
  });

  test("every one of the 45 (jenis_rubrik, kategori) combinations observed in the real dump on 2026-09-18 maps cleanly", () => {
    // Recorded directly from a --dry-run against the real dump this issue
    // names — never the dump's row CONTENT, only its taxonomy label pairs
    // (a bounded, 45-entry controlled vocabulary, not article text).
    const observed = [
      ["HUKUM", ""],
      ["MITRA BORNEO", "Pemkab Kotawaringin Timur"],
      ["UMUM", "Provinsi"],
      ["DAERAH", "Kotawaringin Timur"],
      ["MITRA BORNEO", "DPRD Kalteng"],
      ["MITRA BORNEO", "Pemkab Kapuas"],
      ["MITRA BORNEO", "DPRD Kotawaringin Timur"],
      ["NASIONAL", ""],
      ["MITRA BORNEO", "DPRD Kapuas"],
      ["MITRA BORNEO", "DPRD Palangka Raya"],
      ["MITRA BORNEO", "Pemko Palangka Raya"],
      ["MITRA BORNEO", "Pemprov Kalteng"],
      ["MITRA BORNEO", "Pemkab Lamandau"],
      ["MITRA BORNEO", "Pemkab Pulang Pisau"],
      ["DAERAH", "Palangka Raya"],
      ["MITRA BORNEO", "DPRD Murung Raya"],
      ["POLITIK", ""],
      ["MITRA BORNEO", "Pemkab Gunung Mas"],
      ["MITRA BORNEO", "DPRD Seruyan"],
      ["MITRA BORNEO", "Pemkab Barito Timur"],
      ["DAERAH", "Lamandau"],
      ["MITRA BORNEO", "Pemkab Murung Raya"],
      ["DAERAH", "Kapuas"],
      ["MITRA BORNEO", "Pemkab Katingan"],
      ["DAERAH", "Pulang Pisau"],
      ["MITRA BORNEO", "Pemkab Seruyan"],
      ["OLAHRAGA", ""],
      ["MITRA BORNEO", "DPRD Pulang Pisau"],
      ["DAERAH", "Kotawaringin Barat"],
      ["UMUM", "Budaya"],
      ["DAERAH", "Murung Raya"],
      ["DAERAH", "Barito Timur"],
      ["UMUM", "Bisnis"],
      ["DAERAH", "Gunung Mas"],
      ["DAERAH", "Barito Selatan"],
      ["WISATA", ""],
      ["DAERAH", "Katingan"],
      ["DAERAH", "Barito Utara"],
      ["MITRA BORNEO", "Pemkab Barito Utara"],
      ["UMUM", "Wisata"],
      ["DAERAH", "Seruyan"],
      ["UMUM", "Kuliner"],
      ["DAERAH", "Sukamara"],
      ["MITRA BORNEO", "DPRD Lamandau"],
      ["MITRA BORNEO", "DPRD Barito Timur"]
    ];
    assert.equal(observed.length, 45);

    const unmapped = observed.filter(([jenis, kategori]) => !mapLegacyTaxonomy(jenis, kategori).ok);
    assert.deepEqual(unmapped, [], "every real-dump combination must map — 0 unmapped taxonomy values");
  });
});

// ---------------------------------------------------------------------------
// 3. HTML -> Portable Text (the listed tag set)
// ---------------------------------------------------------------------------

describe("convertHtmlToPortableText: p, strong/em, a, ul/ol/li, h2-h4, blockquote, img", () => {
  test("paragraph with bold, italic, and a link; <script> is dropped entirely", () => {
    const { document } = convertHtmlToPortableText(
      '<p>Hello <strong>world</strong> and <em>you</em>, <a href="https://example.com/x">a link</a>.<script>alert(1)</script></p>'
    );
    assert.equal(document.length, 1);
    const [block] = document;
    assert.equal(block._type, "block");
    assert.equal(block.style, "normal");
    const text = block.children.map((s) => s.text).join("");
    assert.ok(text.includes("Hello"));
    assert.ok(text.includes("world"));
    assert.ok(text.includes("you"));
    assert.ok(text.includes("a link"));
    assert.ok(!text.includes("alert"));
    assert.ok(block.children.some((s) => s.marks.includes("strong") && s.text === "world"));
    assert.ok(block.children.some((s) => s.marks.includes("em") && s.text === "you"));
    assert.equal(block.markDefs[0].href, "https://example.com/x");
  });

  test("headings h2-h4 and blockquote each become their own block with the right style", () => {
    const { document } = convertHtmlToPortableText(
      "<h2>Dua</h2><h3>Tiga</h3><h4>Empat</h4><blockquote>Kutipan</blockquote>"
    );
    assert.deepEqual(
      document.map((b) => b.style),
      ["h2", "h3", "h4", "blockquote"]
    );
  });

  test("ul/ol/li produce listItem blocks with the right kind", () => {
    const { document } = convertHtmlToPortableText(
      "<ul><li>satu</li><li>dua</li></ul><ol><li>pertama</li></ol>"
    );
    assert.equal(document[0].listItem, "bullet");
    assert.equal(document[1].listItem, "bullet");
    assert.equal(document[2].listItem, "number");
    assert.equal(document[0].children[0].text, "satu");
  });

  test("&nbsp; and CRLF are decoded/collapsed", () => {
    const { document } = convertHtmlToPortableText("<p>A&nbsp;B\r\n&amp; C</p>");
    const text = document[0].children.map((s) => s.text).join("");
    assert.ok(text.includes("A B"));
    assert.ok(text.includes("& C"));
  });

  test("an <img> with no resolver is dropped and reported; with a resolver it becomes a gallery block", () => {
    const dropped = convertHtmlToPortableText('<p>Before</p><img src="foto1.jpg" alt="x"><p>After</p>');
    assert.deepEqual(dropped.droppedImages, ["foto1.jpg"]);
    assert.ok(!dropped.document.some((n) => n._type === "gallery"));

    const resolved = convertHtmlToPortableText(
      '<p>Before</p><img src="foto1.jpg" alt="x"><p>After</p>',
      { resolveImage: (src) => (src === "foto1.jpg" ? "11111111-1111-1111-1111-111111111111" : null) }
    );
    assert.equal(resolved.droppedImages.length, 0);
    const gallery = resolved.document.find((n) => n._type === "gallery");
    assert.equal(gallery.items[0].mediaObjectId, "11111111-1111-1111-1111-111111111111");
    assert.equal(gallery.items[0].caption, "x");
  });

  test("an unrecognised tag is transparent: its markup disappears, its text still flows into the paragraph", () => {
    const { document } = convertHtmlToPortableText('<p>Hello <font color="red">red</font> world</p>');
    assert.equal(document[0].children.map((s) => s.text).join(""), "Hello red world");
  });

  test("a javascript: href degrades to plain text rather than being stored as a link", () => {
    const { document } = convertHtmlToPortableText('<p><a href="javascript:alert(1)">click</a></p>');
    assert.equal(document[0].markDefs.length, 0);
    assert.equal(document[0].children[0].text, "click");
  });

  test("bare text with no wrapping tag becomes an implicit paragraph", () => {
    const { document } = convertHtmlToPortableText("Teks polos tanpa tag apa pun.");
    assert.equal(document.length, 1);
    assert.equal(document[0].children[0].text, "Teks polos tanpa tag apa pun.");
  });
});

// ---------------------------------------------------------------------------
// 4. Slug collision handling
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

// ---------------------------------------------------------------------------
// Small supporting surfaces exercised alongside the above (URLs, dates,
// YouTube ids, redirect/site-profile payload shape) — not separately listed
// in the acceptance criteria, but each one feeds a field the taxonomy/slug/
// HTML tests above depend on being correct.
// ---------------------------------------------------------------------------

describe("legacy URL construction", () => {
  test("current-style URL matches seputarborneo_id_slug()/seputarborneo_news_href()", () => {
    assert.equal(legacyNewsUrlCurrent(25, "Dukung KLA, BPBD Pulpis dan DP3AP2KB Teken MoU"), "/news/25-dukung-kla-bpbd-pulpis-dan-dp3ap2kb-teken-mou.html");
  });

  test("pre-2.0 URL replaces spaces with underscores and rawurlencode()s the rest, case preserved", () => {
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

  test("a well-formed past tgl/jam converts from Asia/Jakarta (UTC+7) to UTC and is not scheduled", () => {
    const result = resolvePublishedAt("2026-09-04", "14:30:00", now);
    assert.ok(result.ok);
    assert.equal(result.publishedAt.toISOString(), "2026-09-04T07:30:00.000Z");
    assert.equal(result.willBeScheduled, false);
  });

  test("a future tgl/jam is flagged for scheduling", () => {
    const result = resolvePublishedAt("2027-01-01", "00:00:00", now);
    assert.ok(result.ok);
    assert.equal(result.willBeScheduled, true);
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

describe("buildRedirectPayload", () => {
  test("targets the CMS's own canonical /blog/{tenantCode}/{slug} URL, origin legacy_blog", () => {
    const payload = buildRedirectPayload("/news/25-dukung-kla.html", "borneojek-mart", "dukung-kla");
    assert.deepEqual(payload, {
      sourcePath: "/news/25-dukung-kla.html",
      target: "/blog/borneojek-mart/dukung-kla",
      origin: "legacy_blog",
      statusCode: 301
    });
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
