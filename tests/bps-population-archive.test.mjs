/**
 * Unit tests for tools/bps-population/archive.ts. No network, no rclone, no
 * database: the rclone runner and the local delete are injected fakes, and the
 * eligibility positive case reads the committed dataset only when it exists.
 */
import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  archiveOne,
  classifyPdfLocation,
  compareVerification,
  decideEligibility,
  findArchiveRecord,
  isDeletableArchiveSource,
  mergeArchiveRecord,
  matchesOnly,
  md5Hex,
  normaliseRemoteRoot,
  parseArchiveJson,
  parseArgs,
  parseRcloneMd5,
  parseRcloneSizeJson,
  remoteFilePath,
  sha256Hex
} from "../tools/bps-population/archive.ts";
import { parsePopulationManifest } from "../apps/cms/src/modules/idn-admin-regions/domain/population-manifest.ts";

const REMOTE = "gdrive-test:Folder/Sub";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 fake publication bytes");
const LOCAL = { md5: md5Hex(PDF_BYTES), bytes: PDF_BYTES.byteLength };
const SHA = sha256Hex(PDF_BYTES);

/** A dataset candidate whose CSV is deliberately not a valid population file. */
function candidate({ sourceFileSha256 = SHA, csvText = "not,the,header\n", csvBytesSha256 = null } = {}) {
  const csv = csvText === null ? null : csvText;
  const csvSha = csvBytesSha256 ?? (csv === null ? null : sha256Hex(new TextEncoder().encode(csv)));
  const manifest = {
    datasetCode: "bps-9999-dalam-angka-2026",
    publicationSeries: "kabupaten_kota_dalam_angka",
    coverageRegionCode: "99.99",
    coverageRegionLevel: 2,
    publicationTitle: "Test Dalam Angka 2026",
    publisherName: "BPS Test",
    publisherDomain: "9999",
    publisherWebsite: "https://test.bps.go.id",
    attribution: "test",
    catalogueNumber: null,
    publicationNumber: null,
    issn: null,
    publicationYear: 2026,
    releaseDate: null,
    publicationUrl: "https://test.bps.go.id/id/publication",
    sourceFileSha256,
    sourceFileBytes: PDF_BYTES.byteLength,
    termsOfUse: "test",
    csvPath: null,
    csvSha256: csvSha
  };
  return { datasetCode: manifest.datasetCode, manifest, csvText: csv, csvBytesSha256: csvSha };
}

/** A fake rclone that answers from a table keyed by the first argument. */
function fakeRclone({ md5 = LOCAL.md5, bytes = LOCAL.bytes, fileName = "6271-dalam-angka-2026.pdf", copyCode = 0, md5Code = 0 } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "copyto") return { code: copyCode, stdout: "", stderr: copyCode ? "boom" : "" };
    if (args[0] === "md5sum") {
      return { code: md5Code, stdout: `${md5}  ${fileName}\n`, stderr: "" };
    }
    if (args[0] === "size") return { code: 0, stdout: JSON.stringify({ count: 1, bytes, sizeless: 0 }), stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls };
}

function deps(run, log = []) {
  let records = [];
  return {
    run,
    loadRecords: async () => records,
    saveRecord: async (record) => {
      log.push(["save", record.remote]);
      records = mergeArchiveRecord(records, record);
    },
    deleteLocal: async (filePath) => {
      log.push(["delete", filePath]);
    },
    now: () => new Date("2026-10-26T00:00:00Z")
  };
}

const ITEM = {
  filePath: "/cache/pdf/6271-dalam-angka-2026.pdf",
  fileName: "6271-dalam-angka-2026.pdf",
  sha256: SHA,
  md5: LOCAL.md5,
  bytes: LOCAL.bytes,
  remote: `${REMOTE}/kabkota-provinsi/2026/6271-dalam-angka-2026.pdf`,
  datasetCode: "bps-9999-dalam-angka-2026"
};

describe("eligibility", () => {
  test("no dataset cites the PDF: not eligible, 'no dataset yet'", () => {
    const result = decideEligibility(SHA, [candidate({ sourceFileSha256: "f".repeat(64) })]);
    assert.deepEqual(result, { eligible: false, reason: "no dataset yet" });
  });

  test("two datasets cite the same PDF: ambiguous, not eligible", () => {
    const a = candidate();
    const b = candidate();
    b.datasetCode = "bps-9998-dalam-angka-2026";
    const result = decideEligibility(SHA, [a, b]);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /ambiguous/);
  });

  test("CSV missing: not eligible", () => {
    const result = decideEligibility(SHA, [candidate({ csvText: null })]);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /missing or unreadable/);
  });

  test("CSV checksum differs from the manifest: not eligible", () => {
    const drifted = candidate();
    drifted.manifest.csvSha256 = "0".repeat(64);
    const result = decideEligibility(SHA, [drifted]);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /checksum does not match/);
  });

  test("CSV that fails the importer's shape check: validation failed", () => {
    const result = decideEligibility(SHA, [candidate({ csvText: "not,the,header\n" })]);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /^validation failed/);
  });

  test("a valid header with no data rows: validation failed", () => {
    const header =
      "region_code,region_level,source_region_name,dimension,category,sex,value,unit,reference_year,figure_basis,universe,source_table,source_page,value_note,category_label";
    const result = decideEligibility(SHA, [candidate({ csvText: `${header}\n` })]);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /validation failed/);
  });

  test("the committed 6271 dataset, when present, is eligible for its own PDF", () => {
    const dir = join(import.meta.dir ?? ".", "..", "apps", "cms", "data", "idn-population", "datasets");
    const jsonPath = join(dir, "bps-6271-dalam-angka-2026.json");
    const csvPath = join(dir, "bps-6271-dalam-angka-2026.csv");
    if (!existsSync(jsonPath) || !existsSync(csvPath)) return;
    const parsed = parsePopulationManifest(JSON.parse(readFileSync(jsonPath, "utf8")));
    assert.equal(parsed.ok, true);
    const csvBytes = new Uint8Array(readFileSync(csvPath));
    const result = decideEligibility(parsed.manifest.sourceFileSha256, [
      {
        datasetCode: parsed.manifest.datasetCode,
        manifest: parsed.manifest,
        csvText: Buffer.from(csvBytes).toString("utf8"),
        csvBytesSha256: sha256Hex(csvBytes)
      }
    ]);
    assert.deepEqual(result, { eligible: true, datasetCode: "bps-6271-dalam-angka-2026", year: 2026 });
  });
});

describe("remote path", () => {
  test("direct PDFs go to kabkota-provinsi/<year>", () => {
    assert.equal(
      remoteFilePath(REMOTE, "kabkota-provinsi", 2026, "6271-dalam-angka-2026.pdf"),
      "gdrive-test:Folder/Sub/kabkota-provinsi/2026/6271-dalam-angka-2026.pdf"
    );
  });

  test("kecamatan subfolder PDFs go to kecamatan/<year>", () => {
    const loc = classifyPdfLocation(join("kecamatan", "6271010-dalam-angka-2026.pdf"));
    assert.deepEqual(loc, { ok: true, scope: "kecamatan", fileName: "6271010-dalam-angka-2026.pdf" });
    assert.equal(
      remoteFilePath(REMOTE, loc.scope, 2026, loc.fileName),
      "gdrive-test:Folder/Sub/kecamatan/2026/6271010-dalam-angka-2026.pdf"
    );
  });

  test("a path that climbs out of pdf/ is refused", () => {
    const loc = classifyPdfLocation(join("..", "state.json"));
    assert.equal(loc.ok, false);
    assert.match(loc.reason, /outside pdf/);
    assert.equal(classifyPdfLocation(join("kecamatan", "..", "..", "x.pdf")).ok, false);
    assert.equal(classifyPdfLocation("/etc/passwd.pdf").ok, false);
  });

  test("a deeper subfolder than kecamatan/ is refused", () => {
    assert.equal(classifyPdfLocation(join("kecamatan", "extra", "x.pdf")).ok, false);
    assert.equal(classifyPdfLocation(join("other", "x.pdf")).ok, false);
  });

  test("a file name with a separator or dot segment cannot build a remote path", () => {
    assert.throws(() => remoteFilePath(REMOTE, "kecamatan", 2026, "../x.pdf"));
    assert.throws(() => remoteFilePath(REMOTE, "kecamatan", 2026, ".."));
    assert.throws(() => remoteFilePath(REMOTE, "kecamatan", 26, "x.pdf"));
  });

  test("the remote must name a path and must not look like a flag", () => {
    assert.equal(normaliseRemoteRoot(undefined).ok, false);
    assert.equal(normaliseRemoteRoot("   ").ok, false);
    assert.equal(normaliseRemoteRoot("--config=/x").ok, false);
    assert.equal(normaliseRemoteRoot("noColonHere").ok, false);
    assert.equal(normaliseRemoteRoot("myremote:").ok, false);
    assert.deepEqual(normaliseRemoteRoot("myremote:Folder/Sub/"), { ok: true, remote: "myremote:Folder/Sub" });
  });
});

describe("pdf selection", () => {
  test(".part downloads are never archivable", () => {
    assert.equal(classifyPdfLocation("6271-dalam-angka-2026.pdf.part").ok, false);
    assert.equal(classifyPdfLocation(join("kecamatan", "x.pdf.part")).ok, false);
  });

  test("only .pdf files are deletable, and only inside pdf/", () => {
    const cache = "/home/u/.cache/awcms-bps-population";
    assert.equal(isDeletableArchiveSource(cache, `${cache}/pdf/6271.pdf`), true);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/pdf/kecamatan/6271010.pdf`), true);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/state.json`), false);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/archive.json`), false);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/pdf/../state.json`), false);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/pdf/6271.pdf.part`), false);
    assert.equal(isDeletableArchiveSource(cache, `${cache}/pdf`), false);
  });

  test("--only matches a domain or a whole file stem", () => {
    assert.equal(matchesOnly("6271-dalam-angka-2026.pdf", "6271"), true);
    assert.equal(matchesOnly("6271-dalam-angka-2026.pdf", "6271-dalam-angka-2026"), true);
    assert.equal(matchesOnly("6271-dalam-angka-2026.pdf", "62"), false);
    assert.equal(matchesOnly("6271-dalam-angka-2026.pdf", null), true);
  });

  test("argv parsing: dry run by default, --commit and --only", () => {
    assert.deepEqual(parseArgs([]), { commit: false, only: null });
    assert.deepEqual(parseArgs(["--commit", "--only", "6271"]), { commit: true, only: "6271" });
    assert.deepEqual(parseArgs(["--only=6271"]), { commit: false, only: "6271" });
    assert.throws(() => parseArgs(["--bogus"]));
    assert.throws(() => parseArgs(["--only"]));
  });
});

describe("verification", () => {
  test("parses the rclone md5sum line for the named file only", () => {
    const out = `${LOCAL.md5}  6271-dalam-angka-2026.pdf\n${"a".repeat(32)}  other.pdf\n`;
    assert.equal(parseRcloneMd5(out, "6271-dalam-angka-2026.pdf"), LOCAL.md5);
    assert.equal(parseRcloneMd5(out, "missing.pdf"), null);
    assert.equal(parseRcloneMd5("garbage", "x.pdf"), null);
  });

  test("parses rclone size --json and refuses a count other than one", () => {
    assert.equal(parseRcloneSizeJson(JSON.stringify({ count: 1, bytes: 42, sizeless: 0 })), 42);
    assert.equal(parseRcloneSizeJson(JSON.stringify({ count: 0, bytes: 0, sizeless: 0 })), null);
    assert.equal(parseRcloneSizeJson("not json"), null);
  });

  test("md5 mismatch fails the comparison", () => {
    const result = compareVerification(LOCAL, { md5: "b".repeat(32), bytes: LOCAL.bytes });
    assert.equal(result.ok, false);
    assert.match(result.reason, /MD5 mismatch/);
  });

  test("size mismatch fails the comparison", () => {
    const result = compareVerification(LOCAL, { md5: LOCAL.md5, bytes: LOCAL.bytes + 1 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /size mismatch/);
  });

  test("an unreadable remote MD5 or size fails the comparison", () => {
    assert.equal(compareVerification(LOCAL, { md5: null, bytes: LOCAL.bytes }).ok, false);
    assert.equal(compareVerification(LOCAL, { md5: LOCAL.md5, bytes: null }).ok, false);
  });

  test("matching MD5 and size pass", () => {
    assert.deepEqual(compareVerification(LOCAL, { md5: LOCAL.md5, bytes: LOCAL.bytes }), { ok: true });
  });
});

describe("archive.json", () => {
  const record = (overrides = {}) => ({
    file: "6271-dalam-angka-2026.pdf",
    sha256: SHA,
    md5: LOCAL.md5,
    bytes: LOCAL.bytes,
    remote: ITEM.remote,
    datasetCode: "bps-9999-dalam-angka-2026",
    archivedAt: "2026-10-26T00:00:00.000Z",
    ...overrides
  });

  test("merging the same sha256 and remote replaces, never duplicates", () => {
    const once = mergeArchiveRecord([], record());
    const twice = mergeArchiveRecord(once, record({ archivedAt: "2026-10-27T00:00:00.000Z" }));
    assert.equal(twice.length, 1);
    assert.equal(twice[0].archivedAt, "2026-10-27T00:00:00.000Z");
  });

  test("the same bytes archived to a second remote is a second record", () => {
    const merged = mergeArchiveRecord([record()], record({ remote: "other:Elsewhere/x.pdf" }));
    assert.equal(merged.length, 2);
  });

  test("findArchiveRecord matches on sha256 and remote together", () => {
    const records = [record()];
    assert.ok(findArchiveRecord(records, SHA, ITEM.remote));
    assert.equal(findArchiveRecord(records, SHA, "other:x"), undefined);
    assert.equal(findArchiveRecord(records, "0".repeat(64), ITEM.remote), undefined);
  });

  test("a corrupt ledger throws rather than being overwritten", () => {
    assert.throws(() => parseArchiveJson("{}"));
    assert.throws(() => parseArchiveJson('[{"file":1}]'));
    assert.deepEqual(parseArchiveJson("[]"), []);
  });
});

describe("archiveOne: verification gates the local delete", () => {
  test("md5 mismatch on the remote: no delete, no record", async () => {
    const log = [];
    const { run } = fakeRclone({ md5: "c".repeat(32) });
    const outcome = await archiveOne(ITEM, deps(run, log));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /MD5 mismatch/);
    assert.deepEqual(log, []);
  });

  test("size mismatch on the remote: no delete, no record", async () => {
    const log = [];
    const { run } = fakeRclone({ bytes: LOCAL.bytes + 5 });
    const outcome = await archiveOne(ITEM, deps(run, log));
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /size mismatch/);
    assert.deepEqual(log, []);
  });

  test("copy failure: no delete", async () => {
    const log = [];
    const { run } = fakeRclone({ copyCode: 1 });
    const outcome = await archiveOne(ITEM, deps(run, log));
    assert.equal(outcome.status, "failed");
    assert.deepEqual(log, []);
  });

  test("success: record is written before the local delete, and the copy uses --checksum", async () => {
    const log = [];
    const { run, calls } = fakeRclone();
    const outcome = await archiveOne(ITEM, deps(run, log));
    assert.equal(outcome.status, "deleted");
    assert.deepEqual(log, [
      ["save", ITEM.remote],
      ["delete", ITEM.filePath]
    ]);
    assert.deepEqual(calls[0], ["copyto", ITEM.filePath, ITEM.remote, "--checksum"]);
  });

  test("already archived and still present remotely: verify, delete, no second upload", async () => {
    const log = [];
    const { run, calls } = fakeRclone();
    const d = deps(run, log);
    await d.saveRecord({
      file: ITEM.fileName,
      sha256: SHA,
      md5: LOCAL.md5,
      bytes: LOCAL.bytes,
      remote: ITEM.remote,
      datasetCode: ITEM.datasetCode,
      archivedAt: "2026-10-25T00:00:00.000Z"
    });
    log.length = 0;
    const outcome = await archiveOne(ITEM, d);
    assert.equal(outcome.status, "deleted");
    assert.equal(calls.some((c) => c[0] === "copyto"), false);
    assert.deepEqual(log, [["delete", ITEM.filePath]]);
  });
});
