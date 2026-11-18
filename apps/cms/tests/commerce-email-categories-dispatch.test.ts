import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { COMMERCE_DERIVED_EMAIL_CATEGORIES } from "../src/modules/commerce/domain/email-template-categories";

/**
 * Issue #311, now through the descriptor mechanism (ADR-0164). The
 * `email:dispatch` worker is its own process and renders each queued message at
 * send time; `renderEmailTemplate` substitutes NO variable for a category the
 * process cannot resolve, which once sent every OTP e-mail without its code.
 * The `derived.commerce_*` categories are declared in the commerce descriptor
 * and resolved from the installed descriptor source, which the dispatcher script
 * installs itself, so no upstream-owned file imports a commerce file for its
 * side effect any more (that divergence of `email-dispatch.ts` retired).
 *
 * These tests prove it from a FRESH process that installs the source exactly as
 * `scripts/email-dispatch.ts` does, which an in-process test cannot (the
 * registry is already populated here by whatever else the test file imported).
 */
const CMS_ROOT = resolve(import.meta.dir, "..");
const DISPATCH_SCRIPT = join(CMS_ROOT, "scripts/email-dispatch.ts");
const SOURCE_MODULE = join(
  CMS_ROOT,
  "src/modules/_shared/extension-point-source.ts"
);
const MODULE_LIST = join(CMS_ROOT, "src/modules/index.ts");
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
  test("a fresh process that installs the descriptor source resolves every derived.commerce_* allow-list", async () => {
    const names = COMMERCE_DERIVED_EMAIL_CATEGORIES.map(([name]) => name);
    const resolved = (await inFreshProcess(`
      const { installExtensionPointSource } = await import(${JSON.stringify(SOURCE_MODULE)});
      const { listModules } = await import(${JSON.stringify(MODULE_LIST)});
      installExtensionPointSource(listModules);
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
      const { installExtensionPointSource } = await import(${JSON.stringify(SOURCE_MODULE)});
      const { listModules } = await import(${JSON.stringify(MODULE_LIST)});
      installExtensionPointSource(listModules);
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

  test("the dispatcher script installs the source, and nothing under src/ registers a derived category by hand outside email's own registry", () => {
    expect(
      readFileSync(DISPATCH_SCRIPT, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
    ).toMatch(/\binstallExtensionPointSource\s*\(\s*listModules\s*\)/);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
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

    expect(offenders).toEqual([
      "src/modules/email/domain/email-template-categories.ts"
    ]);
  });

  test("the commerce descriptor declares exactly this list, the campaign category as the only worker insert", async () => {
    const { listModules } = await import("../src/modules");
    const commerce = listModules().find((m) => m.key === "commerce")!;

    expect(
      Object.fromEntries(
        (commerce.emailTemplateCategories ?? []).map((e) => [
          e.category,
          [...e.allowedVariables]
        ])
      )
    ).toEqual(
      Object.fromEntries(
        COMMERCE_DERIVED_EMAIL_CATEGORIES.map(([name, variables]) => [
          name,
          [...variables]
        ])
      )
    );
    expect(
      (commerce.emailTemplateCategories ?? [])
        .filter((e) => e.workerInsert === true)
        .map((e) => e.category)
    ).toEqual(["derived.commerce_campaign"]);
  });
});
