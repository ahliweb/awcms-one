/**
 * Offline tests for tools/bps-population (issue #497): link parsing, the download server's JSON error,
 * name/slug matching and resumable state. No network, no PDF.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { matchTitle, normalizeName, slugify } from "../tools/bps-population/lib/names.ts";
import {
  detectJsonError,
  extractActionId,
  extractDownloadLink,
  isChallenge,
  isPdf,
  parseDomainCode,
  parseListResponse,
  parsePublicationPage,
  parseTautan,
  publicationPageUrl,
} from "../tools/bps-population/lib/parse.ts";
import { matchRegion, parseWilayah } from "../tools/bps-population/lib/regions.ts";
import { PoliteClient } from "../tools/bps-population/lib/http.ts";
import { loadState, needsWork, saveState, stateKey, emptyState } from "../tools/bps-population/lib/state.ts";
import { pdfPath, selectTargets } from "../tools/bps-population/fetch.ts";

const enc = (s) => new TextEncoder().encode(s);

describe("download link and page metadata", () => {
  const html =
    '<a class="download-product" href="https://webapi.bps.go.id/download.php?f=AQAD-x_y&amp;z=1">Unduh Publikasi</a>' +
    '<table><tbody><tr class="py-2"><td>Nomor Katalog</td><td> : </td><td>1102001.6271</td></tr>' +
    '<tr class="py-2"><td>Nomor Publikasi</td><td> : </td><td>62710.26003</td></tr>' +
    '<tr class="py-2"><td>ISSN/ISBN</td><td> : </td><td>0215-5990</td></tr>' +
    '<tr class="py-2"><td>Tanggal Rilis</td><td> : </td><td>27 Februari 2026</td></tr></tbody></table>';
  test("finds the Unduh Publikasi link and unescapes it", () => {
    assert.equal(extractDownloadLink(html), "https://webapi.bps.go.id/download.php?f=AQAD-x_y&z=1");
    assert.equal(extractDownloadLink("<a href='/x'>none</a>"), null);
  });
  test("reads the metadata table", () => {
    const m = parsePublicationPage(html);
    assert.equal(m.catalogueNumber, "1102001.6271");
    assert.equal(m.publicationNumber, "62710.26003");
    assert.equal(m.issn, "0215-5990");
    assert.equal(m.releaseDateText, "27 Februari 2026");
    assert.equal(parsePublicationPage("<p/>").catalogueNumber, null);
  });
  test("domain code comes from the ppid mfd link", () => {
    assert.equal(parseDomainCode('<a href="https://ppid.bps.go.id/?mfd=6271">x</a><a href="...mfd=6271">'), "6271");
    assert.equal(parseDomainCode("<p>none</p>"), null);
    // another mfd= mention (a province link) must not win over the office's own PPID link
    assert.equal(parseDomainCode('<a href="x?mfd=3500">a</a><a href="x?mfd=3500">b</a><a href="https://ppid.bps.go.id/?mfd=3504">PPID</a>'), "3504");
    assert.equal(parseDomainCode('<input type="hidden" name="mfd" value="3504"/>'), "3504");
  });
});

describe("JSON error and challenge detection", () => {
  test("the 200-with-JSON error is not a PDF", () => {
    const bad = enc('{"status":"error","message":"Remote server error (404)."}');
    assert.equal(detectJsonError(bad), "Remote server error (404).");
    assert.equal(isPdf(bad), false);
  });
  test("a real PDF header is not an error", () => {
    const pdf = enc("%PDF-1.7\n....");
    assert.equal(detectJsonError(pdf), null);
    assert.equal(isPdf(pdf), true);
  });
  test("empty and HTML bodies are flagged", () => {
    assert.equal(detectJsonError(new Uint8Array()), "empty body");
    assert.equal(detectJsonError(enc("<html>blocked</html>")), "HTML body instead of a PDF");
    assert.equal(detectJsonError(enc('{"status":"ok"}')), null);
  });
  test("403 and Cloudflare interstitials are challenges; ordinary pages are not", () => {
    assert.equal(isChallenge(403, new Headers(), ""), true);
    assert.equal(isChallenge(200, new Headers({ "cf-mitigated": "challenge" }), ""), true);
    assert.equal(isChallenge(200, new Headers(), "<title>Just a moment...</title>"), true);
    assert.equal(isChallenge(200, new Headers(), "<html><script src='/cdn-cgi/challenge-platform/x'></script>"), false);
  });
});

describe("name and slug matching", () => {
  test("normalisation collapses spacing and case", () => {
    assert.equal(normalizeName("Kota Palangka Raya"), normalizeName("Kota Palangkaraya"));
    assert.equal(slugify("Kota Palangka Raya Dalam Angka 2026"), "kota-palangka-raya-dalam-angka-2026");
  });
  test("page URL is rebuilt from release date, id and title", () => {
    assert.equal(
      publicationPageUrl("https://palangkakota.bps.go.id", "2026-02-27", "6986ba8774fe2789d108bd60", "Kota Palangka Raya Dalam Angka 2026"),
      "https://palangkakota.bps.go.id/id/publication/2026/02/27/6986ba8774fe2789d108bd60/kota-palangka-raya-dalam-angka-2026.html"
    );
  });
  test("title matching: strict, lenient, never a Kecamatan or another year or type", () => {
    assert.equal(matchTitle("Kota Palangka Raya Dalam Angka 2026", "Kota Palangka Raya", 2026), "strict");
    assert.equal(matchTitle("Palangkaraya Dalam Angka 2026", "Kota Palangka Raya", 2026), "lenient");
    assert.equal(matchTitle("Kecamatan Pahandut Dalam Angka 2026", "Kota Palangka Raya", 2026), null);
    assert.equal(matchTitle("Kota Palangka Raya Dalam Angka 2025", "Kota Palangka Raya", 2026), null);
    assert.equal(matchTitle("Kabupaten Bima Dalam Angka 2026", "Kota Bima", 2026), null);
    assert.equal(matchTitle("Provinsi Kalimantan Tengah Dalam Angka 2026", "Provinsi Kalimantan Tengah", 2026), "strict");
  });
  test("regions match by name and report a different code instead of guessing", () => {
    const regions = parseWilayah(
      "('62','Kalimantan Tengah'),\n('62.71','Kota Palangkaraya'),\n('62.01','Kabupaten Kotawaringin Barat'),\n('93.01','Kabupaten Merauke'),\n('91','Papua'),\n('12.71','Kota Medan')"
    );
    assert.deepEqual(matchRegion("regency_city", "6271", "Kota Palangka Raya", regions).how, "code+name");
    assert.equal(matchRegion("province", "6200", "Provinsi Kalimantan Tengah", regions).kemendagriCode, "62");
    const m = matchRegion("regency_city", "9401", "Kabupaten Merauke", regions);
    assert.equal(m.how, "name");
    assert.equal(m.kemendagriCode, "93.01");
    assert.equal(matchRegion("regency_city", "1171", "Kota Nowhere", regions).how, "unmatched");
    const alias = parseWilayah("('21','Kepulauan Riau'),\n('31','Daerah Khusus Ibukota Jakarta'),\n('64.11','Kabupaten Mahakam Ulu'),\n('81.03','Kabupaten Kepulauan Tanimbar')");
    assert.equal(matchRegion("province", "2100", "Provinsi Kep. Riau", alias).kemendagriCode, "21");
    assert.equal(matchRegion("province", "3100", "Provinsi DKI Jakarta", alias).kemendagriCode, "31");
    assert.equal(matchRegion("regency_city", "6411", "Kabupaten Mahakam Hulu", alias).how, "code+name");
    assert.equal(matchRegion("regency_city", "8101", "Kabupaten Maluku Tenggara Barat", alias).kemendagriCode, "81.03");
  });
});

describe("tautan, server action and list parsing", () => {
  test("tautan lists provinces and regencies", () => {
    const html =
      'Website Badan Pusat Statistik Provinsi<ul><li><a target="_blank" href="https://aceh.bps.go.id">Provinsi Aceh</a></li></ul></li>' +
      '<li>Website Badan Pusat Statistik Kabupaten/Kota<ul><li><a target="_blank" href="https://acehbaratkab.bps.go.id">Kabupaten <!-- -->Aceh Barat</a></li></ul>';
    const t = parseTautan(html);
    assert.deepEqual(t.provinces, [{ host: "https://aceh.bps.go.id", name: "Provinsi Aceh" }]);
    assert.deepEqual(t.regencies, [{ host: "https://acehbaratkab.bps.go.id", name: "Kabupaten Aceh Barat" }]);
    assert.throws(() => parseTautan("<p>nothing</p>"));
  });
  test("action id is read from the chunk", () => {
    const js = 'let s=(0,l.createServerReference)("60624e3a7c825a0b98392f2120a4870bd26b8f90f2",l.callServer,void 0,l.findSourceMapURL,"getListPublication")';
    assert.equal(extractActionId(js), "60624e3a7c825a0b98392f2120a4870bd26b8f90f2");
    assert.equal(extractActionId("nothing"), null);
  });
  test("list response parses; a missing row 1 means a stale action id", () => {
    const row = { status: true, response: { status: "OK", data: [{ page: 1, pages: 1, total: 1 }, [{ pub_id: "abc", title: "T", issn: "1", rl_date: "2026-02-27", pdf: "https://webapi.bps.go.id/download.php?f=x", size: "1 MB" }]] } };
    const r = parseListResponse(`0:{"a":"$@1"}\n1:${JSON.stringify(row)}\n`);
    assert.equal(r.total, 1);
    assert.equal(r.items[0].pubId, "abc");
    assert.throws(() => parseListResponse('0:{"a":"$@1"}\n'));
    // a text row (abstract) is length-prefixed, may hold newlines, and row 1 follows it with no newline
    const text = "ab\ncd é.";
    const len = Buffer.byteLength(text).toString(16);
    const glued = `0:{"a":"$@1"}\n2:T${len},${text}1:${JSON.stringify(row)}\n`;
    assert.equal(parseListResponse(glued).items[0].pubId, "abc");
    const empty = parseListResponse(`1:${JSON.stringify({ status: true, response: { status: "OK", "data-availability": "list-not-available" } })}\n`);
    assert.equal(empty.items.length, 0);
  });
});

describe("state resume", () => {
  test("done items are skipped, failed retried, missing only on request; state round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "bps-state-"));
    try {
      const path = join(dir, "state.json");
      const s = emptyState();
      const base = { name: "n", host: "h", targetYear: 2026, foundYear: 2026, fallbackYear: false, matchKind: "strict", title: null, pubId: null, pageUrl: null, releaseDate: null, catalogueNumber: null, publicationNumber: null, issn: null, pdfFile: null, sha256: null, bytes: null, pages: null, adopted: false, error: null, attempts: 1, updatedAt: "x" };
      s.offices[stateKey("6200", 2026)] = { ...base, domain: "6200", status: "done" };
      s.offices[stateKey("6201", 2026)] = { ...base, domain: "6201", status: "failed" };
      s.offices[stateKey("6202", 2026)] = { ...base, domain: "6202", status: "missing" };
      saveState(path, s);
      const back = loadState(path);
      assert.equal(needsWork(back.offices["6200:2026"], false), false);
      assert.equal(needsWork(back.offices["6201:2026"], false), true);
      assert.equal(needsWork(back.offices["6202:2026"], false), false);
      assert.equal(needsWork(back.offices["6202:2026"], true), true);
      assert.equal(needsWork(back.offices["6203:2026"], false), true);
      assert.equal(loadState(join(dir, "none.json")).version, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("stage selection and file naming", () => {
    const o = (domain, level, code) => ({ domain, level, kemendagriCode: code, name: domain, host: "h" });
    const all = [o("6200", "province", "62"), o("6271", "regency_city", "62.71"), o("6201", "regency_city", "62.01"), o("1100", "province", "11"), o("1101", "regency_city", "11.01"), { ...o("9999", "regency_city", null) }];
    assert.deepEqual(selectTargets(all, 1, null).map((x) => x.domain), ["6200", "6201", "6271"]);
    assert.deepEqual(selectTargets(all, 2, null).map((x) => x.domain), ["1100", "6200"]);
    assert.deepEqual(selectTargets(all, 3, "11").map((x) => x.domain), ["1101"]);
    assert.equal(pdfPath("/c", "6200", 2026), "/c/pdf/6200-dalam-angka-2026.pdf");
  });
});

describe("PoliteClient", () => {
  test("keeps at least 3 s between requests and stops on a challenge", async () => {
    let t = 0;
    const waits = [];
    const client = new PoliteClient({
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    await client.getText("https://x.bps.go.id/a");
    await client.getText("https://x.bps.go.id/b");
    assert.ok(waits.length >= 1 && waits.every((w) => w >= 2000 && w <= 2500), JSON.stringify(waits));
    const pauses = [];
    let calls = 0;
    const blocked = new PoliteClient({ sleep: async (ms) => void pauses.push(ms), fetchImpl: async () => (calls++, new Response("no", { status: 403 })) });
    await assert.rejects(() => blocked.getText("https://x.bps.go.id/"), /stopping, not bypassing/);
    assert.equal(calls, 3); // first try + retry after 15 min + retry after 60 min, then stop
    assert.ok(pauses.includes(15 * 60_000) && pauses.includes(60 * 60_000));
    let n = 0;
    const flaky = new PoliteClient({ sleep: async () => {}, fetchImpl: async () => (++n === 1 ? new Response("no", { status: 403 }) : new Response("ok")) });
    assert.equal((await flaky.getText("https://x.bps.go.id/")).text, "ok");
  });
  test("backs off on 429 then succeeds", async () => {
    let n = 0;
    const waits = [];
    const client = new PoliteClient({
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: async () => (++n < 3 ? new Response("slow", { status: 429 }) : new Response("ok")),
    });
    const r = await client.getText("https://x.bps.go.id/");
    assert.equal(r.text, "ok");
    assert.ok(waits.includes(10_000) && waits.includes(30_000));
  });
});
