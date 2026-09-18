/**
 * The gate over its own gate — `packages/gerbang/audit-rilis.mjs`.
 *
 * `audit:rilis` is a checker whose NORMAL answer is green, and a checker
 * like that can stop checking anything without anyone noticing — a regex
 * that shifts by one character, or a misplaced `continue`, would make it
 * report "no violations" over a backlog it never actually counted.
 *
 * Every bound is proven in BOTH directions: red one file past it, green
 * exactly ON it. The second direction carries the larger cost: a checker
 * that reddens everything passes "it catches this defect" without being
 * useful at all, and a bound that is off by one (`>=` instead of `>`) is
 * only visible from that side.
 *
 * Time is supplied through `RELEASE_TODAY`, not read from the wall clock. A
 * test that computed its fixture dates from the same clock the script reads
 * would only prove that subtraction works.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("packages/gerbang/audit-rilis.mjs");

/** The day every case in this file is measured against, so ages below can be checked by hand. */
const TODAY = "2026-09-15";

/** @type {string[]} */
const cleanup = [];

afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

/**
 * A fixture tree with `.changesets/` holding the requested names.
 *
 * File CONTENT is never read by this gate — only the name is asked — so the
 * fixtures deliberately do not carry valid frontmatter. If this gate ever
 * starts reading content, the cases below will redden and say so.
 *
 * @param {string[] | null} names - null means the directory is not created at all
 */
function tree(names) {
  const root = mkdtempSync(join(tmpdir(), "audit-rilis-"));
  cleanup.push(root);

  if (names === null) return root;

  const dir = join(root, ".changesets");
  mkdirSync(dir, { recursive: true });
  for (const file of names) writeFileSync(join(dir, file), "# fixture\n");

  return root;
}

/** `n` changesets, all dated `date`. */
function nOf(n, date = TODAY) {
  return Array.from({ length: n }, (_, i) => `${date}-change-${i + 1}.md`);
}

async function run(root, env = {}) {
  const child = Bun.spawn(["bun", SCRIPT], {
    cwd: root,
    env: { ...process.env, RELEASE_TODAY: TODAY, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });

  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ]);

  return { code: await child.exited, output: out + err };
}

describe("count waiting", () => {
  test("ten changesets — exactly at the bound — is green", async () => {
    const { code, output } = await run(tree(nOf(20)));

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("twenty-one is red, and the count plus the bound are named", async () => {
    const { code, output } = await run(tree(nOf(21)));

    expect(output).toContain("21 changeset(s) waiting, bound is 20");
    expect(output).toContain("bun run release --apply");
    expect(code).toBe(1);
  });

  test("the directory's own README is not counted as a changeset", async () => {
    // The defect this guards against: a filter comparing against one exact
    // name would count README.id.md as a waiting changeset — two phantom
    // files shifting the count with nothing ever written.
    const root = tree([...nOf(20), "README.md", "README.id.md"]);
    const { code, output } = await run(root);

    expect(output).toContain("20 changeset(s) waiting");
    expect(code).toBe(0);
  });
});

describe("age of the oldest", () => {
  test("fourteen days — exactly at the bound — is green", async () => {
    const { code, output } = await run(tree(["2026-09-01-old-enough.md"]));

    expect(output).toContain("14 day(s) (bound 14)");
    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });

  test("fifteen days is red, and the oldest file is named", async () => {
    const root = tree(["2026-08-31-oldest.md", "2026-09-14-newest.md"]);
    const { code, output } = await run(root);

    expect(output).toContain("2026-08-31-oldest.md");
    expect(output).toContain("waiting 15 day(s) since 2026-08-31, bound is 14");
    // The younger one is not accused too: what is measured is the backlog, not each file.
    expect(output).not.toContain("2026-09-14-newest.md: waiting");
    expect(code).toBe(1);
  });

  test("a changeset dated far in the future is red instead of negatively aged", async () => {
    // Without this check, a name like `2026-10-30-` is the one way to park a
    // changeset in the backlog forever: its age is negative, so it never
    // crosses any bound, and the name reads like a typo rather than a
    // defect.
    const { code, output } = await run(tree(["2026-10-30-not-yet.md"]));

    expect(output).toContain("dated 2026-10-30, more than 1 day(s) ahead of today");
    expect(code).toBe(1);
  });

  test("one day ahead is GREEN, because a timezone is not a defect", async () => {
    const { code, output } = await run(tree(["2026-09-16-written-ahead.md"]));

    expect(output).toContain("OK — no violations.");
    expect(code).toBe(0);
  });
});

describe("names that cannot be dated", () => {
  test("no date prefix is red", async () => {
    const { code, output } = await run(tree(["quick-fix.md"]));

    expect(output).toContain("quick-fix.md");
    expect(output).toContain("is not prefixed with a valid `YYYY-MM-DD-` date");
    expect(code).toBe(1);
  });

  test("a date the calendar does not have is red, not rolled into next month", async () => {
    // `new Date("2026-02-31")` answers 3 March without complaint. A date
    // that rolls is a date the author did not write, and accepting it means
    // computing an age from a day that never existed.
    const { code, output } = await run(tree(["2026-02-31-ghost-date.md"]));

    expect(output).toContain("2026-02-31-ghost-date.md");
    expect(output).toContain("is not prefixed with a valid `YYYY-MM-DD-` date");
    expect(code).toBe(1);
  });

  test("an undatable file does not hide an old one behind it", async () => {
    // The easy way to get this wrong: a `continue` that stops the whole
    // check on the first bad file would let a two-week-old backlog hide
    // behind it, red for the wrong reason and silent about the real one.
    const root = tree(["no-date.md", "2026-08-19-very-old.md"]);
    const { code, output } = await run(root);

    expect(output).toContain("no-date.md");
    expect(output).toContain("waiting 27 day(s) since 2026-08-19");
    expect(code).toBe(1);
  });
});

describe("empty states", () => {
  test("an empty backlog is green and names both bounds in force", async () => {
    const { code, output } = await run(tree([]));

    expect(output).toContain("No changesets waiting.");
    expect(output).toContain("20 file(s)");
    expect(output).toContain("14 day(s)");
    expect(code).toBe(0);
  });

  test("no .changesets/ directory is green, and SAYS it read nothing", async () => {
    // A legitimate state for a tree that has removed the release machinery
    // entirely. What must not happen is silence: a gate that read nothing
    // and a gate that read and found nothing must not print the same verdict.
    const { code, output } = await run(tree(null));

    expect(output).toContain(".changesets/ does not exist");
    expect(code).toBe(0);
  });
});

describe("the wall clock", () => {
  test("without RELEASE_TODAY, age is computed from today, not from zero", async () => {
    // Proves the default path genuinely reads the calendar: the fixture
    // date is far in the past, so it must cross the age bound whatever day
    // this actually runs.
    const { code, output } = await run(tree(["2020-01-01-ancient.md"]), { RELEASE_TODAY: "" });

    expect(output).toContain("2020-01-01-ancient.md");
    expect(output).toContain("bound is 14");
    expect(code).toBe(1);
  });
});
