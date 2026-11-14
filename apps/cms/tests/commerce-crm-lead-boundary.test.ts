/**
 * `commerce` never reads or imports `crm_leads` (Issue #463, ADR-0056 D2), and
 * never matches a lead to a customer on a contact value (D3).
 *
 * Both are properties of the SOURCE, so they are asserted over the source:
 * nothing under `src/modules/commerce`, `src/pages/api/v1/commerce` or the
 * commerce admin screens may
 *
 *   - name a table owned by `crm_leads` (`awcms_crm_*`),
 *   - import, require or dynamically import anything under `crm-leads/`,
 *
 * and the one place that names `crm_leads`' concrete adapter is the composition
 * root `src/lib/composition/crm-lead-port.ts` (outside both module directories,
 * the same shape as the booking port). The migrations get the same treatment: no
 * commerce-band migration declares a foreign key into, or a grant on, an
 * `awcms_crm_*` table, because the worker role deliberately holds nothing there.
 *
 * The link code never compares a phone, an e-mail, a handle or a name: it takes
 * two ids from a person and reads a commerce fact.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");

function sourceFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), {
    withFileTypes: true
  })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(relative, extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(relative);
    }
  }
  return out;
}

const COMMERCE_SOURCES = [
  ...sourceFiles("src/modules/commerce", [".ts"]),
  ...sourceFiles("src/pages/api/v1/commerce", [".ts"]),
  ...sourceFiles("src/pages/admin", [".astro"]).filter((file) =>
    path.basename(file).startsWith("commerce")
  ),
  ...sourceFiles("src/lib/ui", [".ts"]).filter((file) =>
    path.basename(file).startsWith("commerce")
  )
];

const COMPOSITION_ROOT = "src/lib/composition/crm-lead-port.ts";
const CRM_DIRECTORY_REFERENCE = /["'`][^"'`\n]*\/crm-leads\/[^"'`\n]*["'`]/g;
const CRM_TABLE_REFERENCE = /awcms_crm_[a-z_]+/g;

const LINK_FILES = [
  "src/modules/commerce/application/crm-lead-link-directory.ts",
  "src/modules/commerce/application/crm-lead-link-http.ts",
  "src/modules/commerce/domain/crm-lead-link.ts",
  "src/pages/api/v1/commerce/crm-lead-links/index.ts",
  "src/pages/api/v1/commerce/crm-lead-links/[id]/reverse.ts"
];

const code = (file: string) =>
  readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

describe("commerce source files never reach into crm_leads", () => {
  test("the scan is not vacuous", () => {
    expect(COMMERCE_SOURCES.length).toBeGreaterThan(150);
    for (const file of LINK_FILES) expect(COMMERCE_SOURCES).toContain(file);
  });

  test("no commerce file names a crm_leads table or imports crm-leads/ code", () => {
    const offenders: string[] = [];
    for (const file of COMMERCE_SOURCES) {
      const text = readFileSync(path.join(root, file), "utf8");
      for (const match of text.matchAll(CRM_TABLE_REFERENCE)) {
        offenders.push(`${file}: ${match[0]}`);
      }
      for (const match of text.matchAll(CRM_DIRECTORY_REFERENCE)) {
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the composition root imports exactly the concrete adapter and nothing else from crm-leads", () => {
    const text = readFileSync(path.join(root, COMPOSITION_ROOT), "utf8");
    const specifiers = [...text.matchAll(CRM_DIRECTORY_REFERENCE)].map(
      (match) => match[0].slice(1, -1)
    );
    expect(specifiers).toEqual([
      "../../modules/crm-leads/application/crm-lead-port-adapter"
    ]);
  });

  test("only the two link routes import the composition root", () => {
    const importers = [
      ...COMMERCE_SOURCES,
      ...sourceFiles("src/pages", [".ts", ".astro"]),
      ...sourceFiles("src/modules", [".ts"]),
      ...sourceFiles("scripts", [".ts"])
    ].filter((file) =>
      /from\s+["'][^"']*lib\/composition\/crm-lead-port["']/.test(
        readFileSync(path.join(root, file), "utf8")
      )
    );
    expect([...new Set(importers)].sort()).toEqual([
      "src/pages/api/v1/commerce/crm-lead-links/[id]/reverse.ts",
      "src/pages/api/v1/commerce/crm-lead-links/index.ts"
    ]);
  });

  test("the directory depends on the port TYPE, never on the adapter", () => {
    const text = code(
      "src/modules/commerce/application/crm-lead-link-directory.ts"
    );
    expect(text).toContain("_shared/ports/crm-lead-port");
    expect(text).not.toMatch(/createCrmLeadPortAdapter|crm-lead-port-adapter/);
  });
});

describe("a lead is never matched to a customer on a contact value", () => {
  test("the link code compares no phone, e-mail, handle or name", () => {
    for (const file of LINK_FILES) {
      const text = code(file);
      expect(text).not.toMatch(
        /\b(ILIKE|LIKE|similarity|levenshtein|soundex)\b/i
      );
      expect(text).not.toMatch(
        /\b(phone|email_normalized|handle|display_name|name)\s*(=|<>|!=)\s*/
      );
      expect(text).not.toMatch(/awcms_commerce_customers[^`]*\bphone\b/i);
    }
  });

  test("the link request accepts ids only", () => {
    const text = code("src/modules/commerce/domain/crm-lead-link.ts");
    expect(text).toContain('"leadId"');
    expect(text).toContain('"customerId"');
    expect(text).not.toMatch(/record\.(phone|email|handle|name)\b/);
  });

  test("the only trigger of a conversion is a person's POST: no consumer calls the port", () => {
    const module = readFileSync(
      path.join(root, "src/modules/commerce/module.ts"),
      "utf8"
    );
    expect(module).not.toMatch(
      /confirmConversion|reverseConversion|composedCrmLeadPort/
    );
    const directory = code(
      "src/modules/commerce/application/crm-lead-link-directory.ts"
    );
    const flagStart = directory.indexOf(
      "export async function flagLinksForOrder"
    );
    const flaggers = directory.slice(flagStart);
    expect(flaggers).not.toMatch(/port\.|confirmConversion|reverseConversion/);
  });
});

describe("commerce migrations never constrain against, or grant on, a crm_leads table", () => {
  const COMMERCE_MIGRATION =
    /^(88\d|89\d|9\d\d|1\d{3})_awcms_commerce_.*\.sql$/;

  test("no commerce-band migration references or grants an awcms_crm_ table in a statement", () => {
    const files = readdirSync(path.join(root, "sql")).filter((name) =>
      COMMERCE_MIGRATION.test(name)
    );
    expect(files.length).toBeGreaterThan(80);
    const offenders: string[] = [];
    for (const name of files) {
      const text = readFileSync(path.join(root, "sql", name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n");
      if (/awcms_crm_/i.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
