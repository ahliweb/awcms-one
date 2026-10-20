// Guard for ADR-0050 (issue #445): the Lynx direction is documented, not implemented.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const adr = "docs/adr/0050-lynxjs-for-separate-persona-apps-astro-stays-for-admin-and-public-profiles";
const read = (p) => readFileSync(join(root, p), "utf8");
const LYNX = /@lynx-js|\blynx-js\b|"@lynx\//i;

describe("ADR-0050 Lynx direction", () => {
  test("both languages carry the status and the decision", () => {
    for (const f of [`${adr}.md`, `${adr}.id.md`]) {
      const t = read(f);
      expect(t).toContain("- **Status:** Accepted as direction; not implemented");
      expect(t).toContain("ahliweb/awcms#1133");
      expect(t).toContain("ADR-0024");
    }
  });

  test("no workspace manifest depends on Lynx (claim stays 'not implemented')", () => {
    const manifests = ["package.json", "apps/storefront/package.json"];
    for (const m of manifests) {
      if (existsSync(join(root, m))) expect(LYNX.test(read(m))).toBe(false);
    }
    const apps = readdirSync(join(root, "apps"));
    expect(apps.some((a) => /lynx/i.test(a))).toBe(false);
  });

  test("fixture: a claim that the template ships a Lynx client is rejected", () => {
    const bad = "This template ships a Lynx client and the admin has migrated to Lynx.";
    const claimsShipped = /ships a Lynx client|admin has migrated to Lynx|storefront has migrated to Lynx/i;
    expect(claimsShipped.test(bad)).toBe(true);
    for (const f of ["AGENTS.md", "docs/status.md", "docs/template.md", `${adr}.md`]) {
      expect(claimsShipped.test(read(f))).toBe(false);
    }
  });
});
