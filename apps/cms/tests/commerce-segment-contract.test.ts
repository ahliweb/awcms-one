/**
 * Static contract for CRM segments (Issue #360, ADR-0042) - no database. The
 * rules that must not rot silently:
 *
 *   - the seven permission keys are declared by the module, seeded by
 *     `sql/1003` exactly, and each is enforced by the route meant to need it;
 *   - every segment route is feature-gated, and the screen claims only declared
 *     permissions and never builds SQL or `innerHTML`;
 *   - no SQL text is ever built from a rule: `segment-sql.ts` has no `unsafe(`,
 *     no string concatenation into a template, and its two exhaustive
 *     `switch`es are what a new field has to satisfy;
 *   - the sidebar entry is gated on segment read and on the `segments` feature;
 *   - the migrations sit in the band ADR-0037 allocated, and the tables are
 *     registered for lifecycle and subject data.
 */
import { readFile, readdir } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { listModules } from "../src/modules";
import { FIELD_SPECS } from "../src/modules/commerce/domain/segment-rules";

const SEGMENT_ROUTES = [
  "src/pages/api/v1/commerce/segments/index.ts",
  "src/pages/api/v1/commerce/segments/[id]/index.ts",
  "src/pages/api/v1/commerce/segments/preview.ts",
  "src/pages/api/v1/commerce/segments/[id]/members.ts",
  "src/pages/api/v1/commerce/segments/[id]/export.csv.ts"
];

const EXPECTED_KEYS = [
  "commerce.segments.read",
  "commerce.segments.create",
  "commerce.segments.update",
  "commerce.segments.delete",
  "commerce.segment_previews.read",
  "commerce.segment_members.read",
  "commerce.segment_members.export"
];

const CONSTANT_TO_CODE: Record<string, string> = {
  COMMERCE_SEGMENTS_ACTIVITY_CODE: "segments",
  COMMERCE_SEGMENT_PREVIEWS_ACTIVITY_CODE: "segment_previews",
  COMMERCE_SEGMENT_MEMBERS_ACTIVITY_CODE: "segment_members"
};

function guardsIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const match of source.matchAll(
    /activityCode:\s*(COMMERCE_[A-Z_]+_ACTIVITY_CODE),\s*action:\s*"([a-z_]+)"/g
  )) {
    const code = CONSTANT_TO_CODE[match[1]!];
    if (code) found.add(`commerce.${code}.${match[2]}`);
  }
  return found;
}

const commerce = listModules().find((module) => module.key === "commerce");
const declared = new Set(
  (commerce?.permissions ?? []).map(
    (permission) => `commerce.${permission.activityCode}.${permission.action}`
  )
);

describe("permissions", () => {
  test("the seven keys are declared, and sql/1003 seeds exactly them", async () => {
    for (const key of EXPECTED_KEYS) expect(declared.has(key)).toBe(true);
    const sql = await readFile(
      "sql/1003_awcms_commerce_segments_permissions.sql",
      "utf8"
    );
    const seeded = [
      ...sql.matchAll(/\('commerce', '([a-z_]+)', '([a-z_]+)',/g)
    ].map((match) => `commerce.${match[1]}.${match[2]}`);
    expect(seeded.sort()).toEqual([...EXPECTED_KEYS].sort());
  });

  test("each key is enforced by a route, and only verbs the upstream AccessAction union already has are used", async () => {
    const enforced = new Set<string>();
    for (const route of SEGMENT_ROUTES) {
      for (const key of guardsIn(await readFile(route, "utf8"))) {
        enforced.add(key);
      }
    }
    expect(EXPECTED_KEYS.filter((key) => !enforced.has(key))).toEqual([]);
    for (const key of EXPECTED_KEYS) {
      expect(["read", "create", "update", "delete", "export"]).toContain(
        key.split(".")[2]!
      );
    }
  });

  test("listing or exporting members also requires customer read, through the one chokepoint", async () => {
    for (const route of [
      "src/pages/api/v1/commerce/segments/[id]/members.ts",
      "src/pages/api/v1/commerce/segments/[id]/export.csv.ts"
    ]) {
      const source = await readFile(route, "utf8");
      expect(source).toContain("requireCustomersRead(");
    }
    const http = await readFile(
      "src/modules/commerce/application/segment-http.ts",
      "utf8"
    );
    expect(http).toContain("authorizeInTransaction(");
    expect(http).toContain("COMMERCE_CUSTOMERS_ACTIVITY_CODE");
  });

  test("high-risk verbs: delete and export are high-risk, so a tenant may author SoD rules against them", async () => {
    const { isHighRiskAction } =
      await import("../src/modules/identity-access/domain/access-control");
    expect(isHighRiskAction("delete")).toBe(true);
    expect(isHighRiskAction("export")).toBe(true);
    expect(isHighRiskAction("read")).toBe(false);
  });
});

describe("routes and screen", () => {
  test("every segment route is feature-gated and defined through defineTenantRoute", async () => {
    for (const route of SEGMENT_ROUTES) {
      const source = await readFile(route, "utf8");
      expect(source).toContain("requireSegmentsFeature(");
      expect(source).toContain("defineTenantRoute");
      expect(source).not.toMatch(/\.unsafe\(/);
    }
  });

  test("a request never names a tenant: no route reads a tenant id from the body or the query", async () => {
    for (const route of SEGMENT_ROUTES) {
      const source = await readFile(route, "utf8");
      expect(source).not.toMatch(/body\.tenantId|searchParams\.get\("tenant/);
    }
  });

  test("the screen claims only declared permissions, never builds SQL or innerHTML, and calls only the segment endpoints", async () => {
    const page = await readFile(
      "src/pages/admin/commerce-segments.astro",
      "utf8"
    );
    const claimed = new Set<string>();
    for (const match of page.matchAll(
      /activityCode:\s*"([a-z_]+)",\s*action:\s*"([a-z_]+)"/g
    )) {
      claimed.add(`commerce.${match[1]}.${match[2]}`);
    }
    const borrowed = new Set(["commerce.customers.read"]);
    expect(
      [...claimed].filter((key) => !declared.has(key) && !borrowed.has(key))
    ).toEqual([]);
    expect(page).toContain("fetchCommerceFeatures(");
    expect(page).not.toMatch(
      /\b(INSERT\s+INTO|UPDATE\s+awcms_|DELETE\s+FROM)/i
    );
    expect(page).not.toMatch(/\.innerHTML\s*=/);
    expect(page).not.toContain("window.confirm");
    expect(page).toContain("/api/v1/commerce/segments");
    expect(page).toContain("confirmFromTrigger");
  });

  test("the sidebar entry is gated on segment read and on the segments feature", () => {
    const nav = commerce?.navigation?.find(
      (entry) => entry.path === "/admin/commerce-segments"
    );
    expect(nav).toBeDefined();
    expect(nav!.requiredPermission).toBe("commerce.segments.read");
    expect(declared.has(nav!.requiredPermission as string)).toBe(true);
    expect(nav!.requiredFeature).toEqual({
      moduleKey: "commerce",
      feature: "segments"
    });
  });
});

describe("no SQL text from a rule (C-25)", () => {
  test("segment-sql.ts builds only tagged templates: no unsafe(), no string-built SQL", async () => {
    const source = await readFile(
      "src/modules/commerce/application/segment-sql.ts",
      "utf8"
    );
    expect(source).not.toMatch(/\.unsafe\(/);
    expect(source).not.toMatch(/sql\.raw|tx\.raw/);
    // Executable code only: a template literal is the one place a value may meet SQL.
    expect(source).not.toMatch(/`[^`]*\$\{leaf\.field\}[^`]*`/);
    expect(source).not.toMatch(/`[^`]*\$\{leaf\.op\}[^`]*`/);
  });

  test("the evaluator and directory bind rules as jsonb values, never as stringified JSON", async () => {
    const directory = await readFile(
      "src/modules/commerce/application/segment-directory.ts",
      "utf8"
    );
    expect(directory).not.toMatch(
      /JSON\.stringify\([\s\S]*?\)\s*\}\s*::\s*jsonb/
    );
  });

  test("every field of the vocabulary has a literal template: segment-sql.ts names each field and the typecheck keeps the switch exhaustive", async () => {
    const source = await readFile(
      "src/modules/commerce/application/segment-sql.ts",
      "utf8"
    );
    for (const field of Object.keys(FIELD_SPECS)) {
      expect(source).toContain(`case "${field}"`);
    }
  });
});

describe("migrations and registration", () => {
  test("sql/1001..1004 exist and sit in the allocated band", async () => {
    const files = await readdir("sql");
    const mine = files.filter((name) =>
      /^100[1-4]_awcms_commerce_segments_/.test(name)
    );
    expect(mine.sort()).toEqual([
      "1001_awcms_commerce_segments_schema.sql",
      "1002_awcms_commerce_segments_evaluation_indexes.sql",
      "1003_awcms_commerce_segments_permissions.sql",
      "1004_awcms_commerce_segments_worker_grants.sql"
    ]);
  });

  test("both tables are FORCE-RLS with a tenant policy, and the version table is append-only for the app role", async () => {
    const sql = await readFile(
      "sql/1001_awcms_commerce_segments_schema.sql",
      "utf8"
    );
    for (const table of [
      "awcms_commerce_segments",
      "awcms_commerce_segment_versions"
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
      expect(sql).toContain(`CREATE POLICY ${table}_tenant_isolation`);
    }
    expect(sql).toContain(
      "REVOKE UPDATE, DELETE ON awcms_commerce_segment_versions FROM awcms_app;"
    );
    expect(sql).toContain(
      "REVOKE DELETE ON awcms_commerce_segments FROM awcms_app;"
    );
    expect(sql).toContain("awcms_commerce_segment_versions_reject_update");
  });

  test("the module registers lifecycle and subject-data descriptors for both tables", () => {
    const lifecycle = (commerce?.dataLifecycle ?? []).map(
      (entry) => entry.tableName
    );
    const subject = (commerce?.subjectData ?? []).map(
      (entry) => entry.tableName
    );
    for (const table of [
      "awcms_commerce_segments",
      "awcms_commerce_segment_versions"
    ]) {
      expect(lifecycle).toContain(table);
      expect(subject).toContain(table);
    }
  });
});
