/**
 * `commerce:campaigns:dispatch` is a composition root of the descriptor-declared
 * extension points (ADR-0164) that upstream's own list
 * (`COMPOSITION_ROOTS` in `scripts/extension-points-check.ts`) does not know:
 * it renders the `derived.commerce_campaign` e-mail category and enqueues the
 * `commerce.campaign` WhatsApp template, both declared in the commerce
 * descriptor, and a process that installed no source throws at the first
 * lookup (fail closed, but every campaign tick would fail).
 *
 * Static, no database: the script must call `installExtensionPointSource`, and
 * with that installed the descriptor declarations resolve in a fresh process.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CMS_ROOT = resolve(import.meta.dir, "..");

describe("commerce:campaigns:dispatch installs the extension-point source", () => {
  test("the script calls installExtensionPointSource(listModules)", () => {
    const text = readFileSync(
      join(CMS_ROOT, "scripts/commerce-campaigns-dispatch.ts"),
      "utf8"
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(text).toMatch(
      /\binstallExtensionPointSource\s*\(\s*listModules\s*\)/
    );
  });

  test("with the source installed the campaign category and template resolve in a fresh process", async () => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        const { installExtensionPointSource } = await import("./src/modules/_shared/extension-point-source.ts");
        const { listModules } = await import("./src/modules/index.ts");
        installExtensionPointSource(listModules);
        const { getAllowedVariablesForCategory } = await import("./src/modules/email/domain/email-template-categories.ts");
        const { getWhatsappTemplate } = await import("./src/modules/whatsapp-delivery/domain/whatsapp-templates.ts");
        console.log(JSON.stringify({
          email: getAllowedVariablesForCategory("derived.commerce_campaign"),
          whatsapp: getWhatsappTemplate("commerce.campaign")?.purpose ?? null
        }));
        `
      ],
      {
        cwd: CMS_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, DATABASE_URL: "", EMAIL_ENABLED: "false" }
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited
    ]);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual({
      email: ["subject", "body"],
      whatsapp: "marketing"
    });
  });
});
