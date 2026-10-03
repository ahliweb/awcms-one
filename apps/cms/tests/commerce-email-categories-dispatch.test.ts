import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { COMMERCE_DERIVED_EMAIL_CATEGORIES } from "../src/modules/commerce/domain/email-template-categories";

/**
 * Issue #311 — the `email:dispatch` worker is its own process and renders each
 * queued message at send time. `renderEmailTemplate` substitutes NO variable
 * for a category missing from the per-process registry, so a `derived.commerce_*`
 * category registered only as an import side effect of commerce application
 * files (which the dispatcher never imports) sent every OTP e-mail without its
 * code. These tests prove the registration from a FRESH process that imports
 * only the dispatcher module, which an in-process test cannot (the registry
 * is already populated there by whatever else the test file imported).
 */
const CMS_ROOT = resolve(import.meta.dir, "..");
const DISPATCH_MODULE = join(
  CMS_ROOT,
  "src/modules/email/application/email-dispatch.ts"
);
const CATEGORIES_MODULE = join(
  CMS_ROOT,
  "src/modules/email/domain/email-template-categories.ts"
);
const RENDER_MODULE = join(
  CMS_ROOT,
  "src/modules/email/domain/email-template-render.ts"
);

async function inFreshProcess(script: string): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, "-e", script], {
    cwd: CMS_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, DATABASE_URL: "", EMAIL_ENABLED: "false" }
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout.trim().split("\n").pop()!);
}

describe("derived e-mail categories in the email:dispatch process (Issue #311)", () => {
  test("a fresh process importing only the dispatcher resolves every derived.commerce_* allow-list", async () => {
    const names = COMMERCE_DERIVED_EMAIL_CATEGORIES.map(([name]) => name);
    const resolved = (await inFreshProcess(`
      await import(${JSON.stringify(DISPATCH_MODULE)});
      const { getAllowedVariablesForCategory } = await import(${JSON.stringify(CATEGORIES_MODULE)});
      const out = {};
      for (const name of ${JSON.stringify(names)}) out[name] = getAllowedVariablesForCategory(name);
      out["derived.unregistered_probe"] = getAllowedVariablesForCategory("derived.unregistered_probe");
      console.log(JSON.stringify(out));
    `)) as Record<string, string[] | null>;

    expect([...names].sort()).toEqual([
      "derived.commerce_campaign",
      "derived.commerce_conversation_reply",
      "derived.commerce_customer_otp"
    ]);
    for (const [name, variables] of COMMERCE_DERIVED_EMAIL_CATEGORIES) {
      expect(resolved[name]).toEqual([...variables]);
    }
    // The allow-list semantics are untouched: an unknown category stays unknown.
    expect(resolved["derived.unregistered_probe"]).toBeNull();
  });

  test("renderEmailTemplate in that fresh process substitutes the OTP code", async () => {
    // Generated at runtime: no token-shaped literal in the source.
    const code = String(100000 + Math.floor(Math.random() * 900000));
    const rendered = (await inFreshProcess(`
      await import(${JSON.stringify(DISPATCH_MODULE)});
      const { renderEmailTemplate } = await import(${JSON.stringify(RENDER_MODULE)});
      const out = renderEmailTemplate({
        subjectTemplate: { en: "Code {{code}}" },
        textBodyTemplate: { en: "Your code is {{code}} ({{expiresInMinutes}} min) {{storeName}}" },
        htmlBodyTemplate: null
      }, { code: ${JSON.stringify(code)}, expiresInMinutes: "10", storeName: "Toko" },
      "derived.commerce_customer_otp", "en");
      console.log(JSON.stringify(out));
    `)) as { subject: string; textBody?: string };

    expect(rendered.subject).toBe(`Code ${code}`);
    expect(rendered.textBody).toBe(`Your code is ${code} (10 min) Toko`);
  });

  test("every derived.* registration under src/ lives in the one commerce side-effect file", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (
          path.endsWith(".ts") &&
          /registerDerivedEmailTemplateCategory\(/.test(
            readFileSync(path, "utf8")
          )
        ) {
          offenders.push(path.slice(CMS_ROOT.length + 1));
        }
      }
    };
    walk(join(CMS_ROOT, "src"));

    expect(offenders.sort()).toEqual([
      "src/modules/commerce/domain/email-template-categories.ts",
      "src/modules/email/domain/email-template-categories.ts"
    ]);
  });
});
