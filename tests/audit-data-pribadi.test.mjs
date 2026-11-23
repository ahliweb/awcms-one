/**
 * The gate over its own gate — `packages/gerbang/audit-data-pribadi.mjs` and
 * `packages/gerbang/lib/data-pribadi.mjs`.
 *
 * A scanner whose normal answer is green can stop scanning without anyone
 * noticing, so each category is proven in both directions: one example is
 * found exactly once, and its fake or placeholder sibling is not.
 *
 * Every identifier below is assembled from fragments at run time. No
 * identifier-shaped literal is committed in this file, so the gate (which
 * scans this very file) needs no allow-list entry for it — and the test can
 * never be the way a real-looking value enters the tree. The values are
 * invented; none belongs to a person.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  applyAllowList,
  isDataFile,
  isInScope,
  scanDiff,
  scanText,
  validateAllowList
} from "../packages/gerbang/lib/data-pribadi.mjs";

const SCRIPT = resolve("packages/gerbang/audit-data-pribadi.mjs");

const join_ = (...parts) => parts.join("");

/** Invented values, one per category, plus a fake sibling for each. */
const NATIONAL_ID = join_("31", "71", "01", "15", "05", "90", "0001");
const NATIONAL_ID_RESERVED = join_("99", "71", "01", "15", "05", "90", "0001");
const NATIONAL_ID_REPEATED = join_("31", "71", "01", "11", "11", "11", "1111");
const PHONE = join_("08", "13", "7361", "2480");
const PHONE_FAKE = join_("08", "12", " 0000 ", "4410");
const EMAIL = join_("budi.santoso", "@", "gmail", ".com");
const EMAIL_PLACEHOLDER = join_("budi", "@", "example", ".com");
const SHARE_LINK = join_("https://drive.google.com/file/d/", "1aB3cD5eF7gH9iJ1kL3mN5oP7qR9sT1uV", "/view");
const SHARE_LINK_PLACEHOLDER = join_("https://drive.google.com/file/d/", "FILE_ID", "/view");

describe("scanText — one finding per example, none for the fake sibling", () => {
  const categoriesOf = (text) => scanText(text).map((f) => f.category);

  test("a national-identity-shaped number is found once", () => {
    expect(categoriesOf(`nik: ${NATIONAL_ID}`)).toEqual(["national-id"]);
  });

  test("a reserved-prefix or repeated number is not a finding", () => {
    expect(categoriesOf(`nik: ${NATIONAL_ID_RESERVED}`)).toEqual([]);
    expect(categoriesOf(`nik: ${NATIONAL_ID_REPEATED}`)).toEqual([]);
  });

  test("a digit string inside a longer token is not a national id", () => {
    expect(categoriesOf(`sha512-${NATIONAL_ID}abc`)).toEqual([]);
    expect(categoriesOf(`${NATIONAL_ID}${NATIONAL_ID}`)).toEqual([]);
  });

  test("a mobile number is found once, in each written form", () => {
    expect(categoriesOf(`call ${PHONE}`)).toEqual(["mobile-phone"]);
    expect(categoriesOf(`call ${PHONE.replace(/^0/, "+62 ")}`)).toEqual(["mobile-phone"]);
  });

  test("a recognisably fake mobile number is not a finding", () => {
    expect(categoriesOf(`call ${PHONE_FAKE}`)).toEqual([]);
  });

  test("an address outside the placeholder domains is found once", () => {
    expect(categoriesOf(`mail ${EMAIL}`)).toEqual(["email"]);
  });

  test("placeholder domains, reserved TLDs and version strings are not findings", () => {
    expect(categoriesOf(`mail ${EMAIL_PLACEHOLDER}`)).toEqual([]);
    expect(categoriesOf(`mail a${"@"}shop.example.org b${"@"}host.test c${"@"}svc.internal`)).toEqual([]);
    expect(categoriesOf(`picomatch${"@"}4.0.7.patch pkg${"@"}1.2.3`)).toEqual([]);
  });

  test("a file-share link with an id is found once; a placeholder id is not", () => {
    expect(categoriesOf(`see ${SHARE_LINK}`)).toEqual(["file-share-link"]);
    expect(categoriesOf(`see ${SHARE_LINK_PLACEHOLDER}`)).toEqual([]);
  });

  test("findings carry a line number and never the value", () => {
    const findings = scanText(`line one\nnik ${NATIONAL_ID}\n`);
    expect(findings).toEqual([{ line: 2, category: "national-id" }]);
    expect(JSON.stringify(findings)).not.toContain(NATIONAL_ID);
  });
});

describe("scope and data files", () => {
  test("the upstream subtree is skipped unless a path is declared as owned", () => {
    expect(isInScope("apps/storefront/src/a.ts")).toBe(true);
    expect(isInScope("apps/cms/src/a.ts")).toBe(false);
    const config = {
      SKIPPED_PREFIXES: ["apps/cms/"],
      OWNED_SUBTREE_PATHS: ["apps/cms/src/modules/commerce/"]
    };
    expect(isInScope("apps/cms/src/modules/commerce/a.ts", config)).toBe(true);
    expect(isInScope("apps/cms/src/modules/blog/a.ts", config)).toBe(false);
  });

  test("spreadsheets, CSVs, archives, logs and snapshots are data files", () => {
    for (const name of ["a.csv", "a.XLSX", "a.zip", "a.tar.gz", "run.log", "a.snap", "x/__snapshots__/y.txt"]) {
      expect(isDataFile(name)).toBe(true);
    }
    for (const name of ["a.ts", "a.json", "README.md", "logo.png", "catalog.mjs"]) {
      expect(isDataFile(name)).toBe(false);
    }
  });
});

describe("allow-list", () => {
  const finding = { path: "a/b.ts", line: 3, category: "email" };

  test("an entry covers a finding by exact path, directory prefix, and pinned line", () => {
    const covers = (entry) => applyAllowList([finding], [entry]).remaining.length === 0;
    expect(covers({ path: "a/b.ts", category: "email", reason: "r" })).toBe(true);
    expect(covers({ path: "a/", category: "email", reason: "r" })).toBe(true);
    expect(covers({ path: "a/b.ts", category: "email", line: 3, reason: "r" })).toBe(true);
    expect(covers({ path: "a/b.ts", category: "email", line: 4, reason: "r" })).toBe(false);
    expect(covers({ path: "a/b.ts", category: "mobile-phone", reason: "r" })).toBe(false);
    expect(covers({ path: "a/c.ts", category: "email", reason: "r" })).toBe(false);
  });

  test("an entry that covers nothing is reported as unused", () => {
    const { unused } = applyAllowList([finding], [
      { path: "a/b.ts", category: "email", reason: "r" },
      { path: "gone.ts", category: "email", reason: "r" }
    ]);
    expect(unused).toEqual([1]);
  });

  test("an entry with no reason, a bad category or a non-integer line is invalid", () => {
    expect(validateAllowList([{ path: "a", category: "email", reason: "r" }])).toEqual([]);
    expect(validateAllowList([{ path: "a", category: "email" }]).length).toBe(1);
    expect(validateAllowList([{ path: "a", category: "email", reason: "  " }]).length).toBe(1);
    expect(validateAllowList([{ path: "a", category: "nope", reason: "r" }]).length).toBe(1);
    expect(validateAllowList([{ path: "a", category: "email", line: "3", reason: "r" }]).length).toBe(1);
    expect(validateAllowList("x").length).toBe(1);
  });
});

describe("scanDiff — the --history diagnostic", () => {
  test("only added lines are scanned, and commit and path are reported", () => {
    const diff = [
      "commit abcdef1234567890",
      "--- a/old.txt",
      "+++ b/notes.txt",
      `-removed ${EMAIL}`,
      `+added ${EMAIL}`,
      "commit 1234567890abcdef",
      "+++ b/apps/cms/skipped.txt",
      `+added ${EMAIL}`
    ].join("\n");
    expect(scanDiff(diff)).toEqual([{ commit: "abcdef123456", path: "notes.txt", category: "email" }]);
  });
});

/** @type {string[]} */
const cleanup = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

/**
 * A fixture git work tree holding `files` (path -> content), all staged.
 *
 * @param {Record<string, string>} files
 * @returns {string} the tree's root
 */
function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "audit-data-pribadi-"));
  cleanup.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  expect(Bun.spawnSync(["git", "-C", root, "init", "-q"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", root, "add", "-A"]).exitCode).toBe(0);
  return root;
}

function runGate(root, ...extra) {
  const result = Bun.spawnSync(["bun", SCRIPT, "--root", root, ...extra], {
    stdout: "pipe",
    stderr: "pipe"
  });
  return { exitCode: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
}

const ALLOWLIST = "packages/gerbang/data-pribadi-allowlist.json";

describe("audit-data-pribadi.mjs over a fixture repository", () => {
  test("one example per category yields exactly one finding each and prints no value", () => {
    const root = fixtureTree({
      "docs/nik.md": `nik ${NATIONAL_ID}\n`,
      "docs/phone.md": `hp ${PHONE}\n`,
      "docs/mail.md": `surel ${EMAIL}\n`,
      "docs/link.md": `berkas ${SHARE_LINK}\n`,
      "data/pelanggan.csv": "a,b\n"
    });
    const { exitCode, out } = runGate(root);
    expect(exitCode).toBe(1);
    expect(out).toContain("FAILED — 5 violation(s)");
    expect(out).toContain("docs/nik.md:1");
    expect(out).toContain("docs/phone.md:1");
    expect(out).toContain("docs/mail.md:1");
    expect(out).toContain("docs/link.md:1");
    expect(out).toContain("data/pelanggan.csv");
    for (const value of [NATIONAL_ID, PHONE, EMAIL, SHARE_LINK]) {
      expect(out).not.toContain(value);
    }
  });

  test("fake values, the skipped subtree and an allow-listed line produce no finding", () => {
    const root = fixtureTree({
      "docs/fake.md": [NATIONAL_ID_RESERVED, PHONE_FAKE, EMAIL_PLACEHOLDER, SHARE_LINK_PLACEHOLDER].join("\n"),
      "apps/cms/src/upstream.md": `${EMAIL}\n`,
      "docs/known.md": `surel ${EMAIL}\n`,
      [ALLOWLIST]: JSON.stringify({
        entries: [{ path: "docs/known.md", category: "email", line: 1, reason: "invented fixture" }]
      })
    });
    const { exitCode, out } = runGate(root);
    expect(out).toContain("OK — no violations.");
    expect(exitCode).toBe(0);
  });

  test("an allow-list entry that matches nothing fails the gate", () => {
    const root = fixtureTree({
      "docs/clean.md": "nothing here\n",
      [ALLOWLIST]: JSON.stringify({
        entries: [{ path: "docs/clean.md", category: "email", reason: "stale" }]
      })
    });
    const { exitCode, out } = runGate(root);
    expect(exitCode).toBe(1);
    expect(out).toContain("[allow-list-unused]");
  });

  test("an allow-list entry without a reason fails the gate", () => {
    const root = fixtureTree({
      "docs/known.md": `surel ${EMAIL}\n`,
      [ALLOWLIST]: JSON.stringify({ entries: [{ path: "docs/known.md", category: "email" }] })
    });
    const { exitCode, out } = runGate(root);
    expect(exitCode).toBe(1);
    expect(out).toContain("no `reason`");
  });

  test("--history is a diagnostic: it reports added lines and exits 0", () => {
    const root = fixtureTree({ "docs/mail.md": `surel ${EMAIL}\n` });
    const commit = Bun.spawnSync(
      ["git", "-C", root, "-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "x"],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(commit.exitCode).toBe(0);
    const { exitCode, out } = runGate(root, "--history");
    expect(exitCode).toBe(0);
    expect(out).toContain("docs/mail.md [email]");
    expect(out).not.toContain(EMAIL);
  });
});

describe("the real tree's allow-list", () => {
  test("is well-formed", async () => {
    const parsed = JSON.parse(await Bun.file(ALLOWLIST).text());
    expect(validateAllowList(parsed.entries)).toEqual([]);
  });
});
