/**
 * Gate: every storefront stub fixture is judged against the OpenAPI
 * response schema it stands for (issue #553, ADR-0058, audit finding F-02).
 *
 * No database, no network, no build: the bundle is the committed
 * `apps/cms/openapi/awcms-public-api.openapi.yaml`, read only. The map and
 * the dated exceptions are in `tests/support/fixture-skema-mapa.mjs`, the
 * rules in `tests/support/fixture-skema.mjs`. Runs with the root `bun test`
 * (the `local-ci/check-toko` leg).
 *
 * Nothing here imports from `apps/cms/src` or `packages/kontrak`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  FIXTURE_DIR,
  createValidator,
  evaluateEntry,
  loadBundle,
  readFixture
} from "./support/fixture-skema.mjs";
import { EXCEPTIONS, FIXTURE_MAP } from "./support/fixture-skema-mapa.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const bundle = loadBundle();
const validator = createValidator(bundle);
const today = new Date().toISOString().slice(0, 10);

describe("fixtures versus the OpenAPI response schemas", () => {
  test("every fixture file is mapped exactly once and every mapping has a file", () => {
    const files = readdirSync(ROOT + FIXTURE_DIR).sort();
    const mapped = FIXTURE_MAP.map((entry) => entry.file);
    expect(mapped.filter((file, index) => mapped.indexOf(file) !== index)).toEqual([]);
    expect(files.filter((file) => !mapped.includes(file))).toEqual([]);
    expect(mapped.filter((file) => !files.includes(file))).toEqual([]);
  });

  test("every exception belongs to a mapped, validated fixture", () => {
    for (const exception of EXCEPTIONS) {
      const entry = FIXTURE_MAP.find((candidate) => candidate.file === exception.fixture);
      expect(entry, `exception ${exception.id} names an unmapped fixture`).toBeDefined();
      expect(["response", "subset", "lookup"]).toContain(entry.kind);
    }
    const ids = EXCEPTIONS.map((exception) => exception.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const entry of FIXTURE_MAP) {
    test(`${entry.file} (${entry.kind})`, () => {
      const { problems } = evaluateEntry(entry, validator, readFixture, EXCEPTIONS, today);
      expect(problems).toEqual([]);
    });
  }
});

describe("the gate itself", () => {
  const read = () => ({ x: 1 });
  const base = {
    file: "x.json",
    kind: "response",
    op: { path: "/api/v1/media/public-origin", method: "get", status: 200 },
    bodies: () => [{ body: { success: true, data: { configured: true, origin: null, baseUrl: null } } }],
    reason: "A synthetic entry used only by the gate's own tests."
  };
  const run = (entry, exceptions = [], date = "2026-11-24") =>
    evaluateEntry(entry, validator, read, exceptions, date).problems;

  test("a valid body passes", () => {
    expect(run(base)).toEqual([]);
  });

  test("a mapped operation missing from the bundle fails", () => {
    const problems = run({ ...base, op: { path: "/api/v1/does-not-exist", method: "get", status: 200 } });
    expect(problems.join("\n")).toContain("is not in the OpenAPI bundle");
  });

  test("a status the operation does not declare fails", () => {
    const problems = run({ ...base, op: { ...base.op, status: 299 } });
    expect(problems.join("\n")).toContain("is not in the OpenAPI bundle");
  });

  test("a value outside an enum, a wrong type and an undeclared property all fail", () => {
    const bad = (data) => ({ ...base, bodies: () => [{ body: { success: true, data } }] });
    expect(run(bad({ configured: "yes", origin: null, baseUrl: null })).join("\n")).toContain("type at /data/configured");
    expect(run(bad({ configured: true, origin: null, baseUrl: null, extra: 1 })).join("\n")).toContain(
      "unevaluatedProperties"
    );
    const regions = {
      ...base,
      op: { path: "/api/v1/idn-regions/regions", method: "get", status: 200 },
      bodies: () => [
        { body: { success: true, data: { datasetCode: null, nextCursor: null, reason: null, items: [{ regionType: "city" }] } } }
      ]
    };
    expect(run(regions).join("\n")).toContain("enum at /data/items/0/regionType");
  });

  test("a subset must name the required fields it omits, and each must still be omitted", () => {
    const partial = { ...base, bodies: () => [{ body: { success: true, data: { configured: true } } }] };
    expect(run(partial).join("\n")).toContain("required at /data");
    const subset = {
      ...partial,
      kind: "subset",
      omittedRequired: [
        { property: "origin", reason: "Synthetic omission for the gate's own test." },
        { property: "baseUrl", reason: "Synthetic omission for the gate's own test." }
      ]
    };
    expect(run(subset)).toEqual([]);
    const stale = { ...subset, bodies: base.bodies };
    expect(run(stale).join("\n")).toContain("no longer matches anything");
    expect(run({ ...subset, kind: "response" }).join("\n")).toContain("only allowed on a subset");
  });

  test("an exception forgives only what it names, and fails once it matches nothing", () => {
    const violating = {
      ...base,
      bodies: () => [{ body: { success: true, data: { configured: true, origin: null, baseUrl: null, extra: 1 } } }]
    };
    const exception = {
      id: "T-1",
      fixture: "x.json",
      issue: "#554",
      reviewBy: "2026-12-15",
      reason: "synthetic",
      matches: [{ keyword: "unevaluatedProperties", instancePath: "^/data$", property: "extra" }]
    };
    expect(run(violating, [exception])).toEqual([]);
    expect(run(violating, [{ ...exception, matches: [{ ...exception.matches[0], property: "other" }] }]).join("\n")).toContain(
      "unevaluatedProperties"
    );
    expect(run(base, [exception]).join("\n")).toContain("matches nothing any more");
  });

  test("an exception past its review date fails", () => {
    const violating = {
      ...base,
      bodies: () => [{ body: { success: true, data: { configured: true, origin: null, baseUrl: null, extra: 1 } } }]
    };
    const exception = {
      id: "T-2",
      fixture: "x.json",
      issue: "#554",
      reviewBy: "2026-11-01",
      reason: "synthetic",
      matches: [{ keyword: "unevaluatedProperties", instancePath: "^/data$", property: "extra" }]
    };
    expect(run(violating, [exception]).join("\n")).toContain("passed its review date");
  });

  test("a not-a-response entry needs a reason and no operation", () => {
    expect(run({ file: "x.json", kind: "not-a-response", reason: "short" }).join("\n")).toContain("reason");
    expect(
      run({ file: "x.json", kind: "not-a-response", op: base.op, reason: "A synthetic configuration file for the test." }).join("\n")
    ).toContain("must not name an operation");
  });

  test("every mapped operation resolves to a response schema in the bundle", () => {
    for (const entry of FIXTURE_MAP.filter((candidate) => candidate.op)) {
      expect(validator.has(entry.op.path, entry.op.method, entry.op.status)).toBe(true);
    }
  });
});
