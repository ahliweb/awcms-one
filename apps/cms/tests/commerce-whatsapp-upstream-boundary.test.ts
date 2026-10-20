import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * ADR-0133 section 6, END CONDITION 1, made checkable before the end condition
 * itself (Issue #392): "every commerce caller - customer OTP, order-paid,
 * campaigns, and document delivery - enqueues through the upstream port,
 * verified by a downstream test that fails if a commerce file imports its own
 * WhatsApp table or provider".
 *
 * While the `legacy` mode exists, commerce still owns a WhatsApp table, a
 * provider and a dispatcher, so the rule cannot yet be "no commerce file names
 * them". It is stated in the two halves that ARE true today, and the second half
 * shrinks to nothing when the legacy path is deleted:
 *
 *   1. The files on the `upstream` path name no commerce WhatsApp table, provider,
 *      dispatcher, purge or legacy writer, and import nothing from outside the
 *      port, the `whatsapp_delivery` adapter/config/templates and commerce's own
 *      pure `domain/`.
 *   2. Only an explicit allowlist of legacy files names the legacy tables; every
 *      commerce CALLER reaches WhatsApp through `./whatsapp-enqueue` (the mode
 *      router) and nothing else, so none of them can bypass the router into the
 *      legacy queue, and no new file can start writing it.
 */
const COMMERCE = resolve(import.meta.dir, "../src/modules/commerce");

/** Every file on the upstream path: it may name only what the header above allows. */
const UPSTREAM_PATH_FILES = [
  "application/whatsapp-upstream-enqueue.ts",
  "application/whatsapp-upstream-status.ts",
  "domain/whatsapp-upstream-templates.ts"
];

/** The files that legitimately name a legacy WhatsApp table; deleted with the legacy mode. */
const LEGACY_TABLE_FILES = new Set([
  "application/whatsapp-enqueue-legacy.ts",
  "application/whatsapp-dispatch.ts",
  "application/whatsapp-queue-purge.ts",
  "application/whatsapp-message-directory.ts",
  // The retention/subject-data descriptors of the two tables.
  "module.ts"
]);

/** Commerce files that SEND a WhatsApp message. Each must go through the router. */
const CALLERS = [
  "application/whatsapp-otp-channel-adapter.ts",
  "application/campaign-dispatch.ts",
  "application/document-delivery-directory.ts"
];

const LEGACY_TABLE = /awcms_commerce_whatsapp_(messages|delivery_attempts)/;
const IMPORT_SPECIFIER =
  /^\s*(?:import|export)\b[^"';]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm;

function read(relative: string): string {
  return readFileSync(join(COMMERCE, relative), "utf8");
}

function specifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(
    (match) => (match[1] ?? match[2])!
  );
}

/** Lines that are not comments: a docblock may EXPLAIN what it refuses to import. */
function code(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

function allCommerceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts")) out.push(path.slice(COMMERCE.length + 1));
    }
  };
  walk(COMMERCE);

  return out;
}

describe("the upstream path never names commerce's own WhatsApp table or provider (ADR-0133 section 6)", () => {
  test("the scanner finds the imports it is supposed to guard", () => {
    // A regex that silently stopped matching would make everything below pass
    // while checking nothing.
    expect(
      specifiers(read("application/whatsapp-upstream-enqueue.ts"))
    ).toContain("../../whatsapp-delivery/application/whatsapp-enqueue");
    expect(specifiers(read("module.ts"))).toContain(
      "./domain/whatsapp-upstream-templates"
    );
  });

  for (const file of UPSTREAM_PATH_FILES) {
    test(`${file} imports only the port, whatsapp_delivery and commerce's pure domain`, () => {
      for (const specifier of specifiers(read(file))) {
        const allowed =
          specifier.startsWith("node:") ||
          specifier === "../../_shared/ports/whatsapp-delivery-port" ||
          // The in-process adapter, the config and the template registry.
          /^\.\.\/\.\.\/whatsapp-delivery\/(application\/whatsapp-enqueue|domain\/whatsapp-templates)$/.test(
            specifier
          ) ||
          // Commerce's own pure files: types, the template wording, the mode.
          /^(\.\/|\.\.\/domain\/)(document-delivery|whatsapp-enqueue-types|whatsapp-templates|whatsapp-mode|whatsapp-upstream-templates)$/.test(
            specifier
          );

        expect({ file, specifier, allowed }).toEqual({
          file,
          specifier,
          allowed: true
        });
      }
    });

    test(`${file} names no legacy table, provider, dispatcher, purge or writer`, () => {
      const body = code(read(file));

      expect(body).not.toMatch(LEGACY_TABLE);
      expect(body).not.toMatch(
        /whatsapp-(dispatch|queue-purge|enqueue-legacy|message-directory|provider|config)|fonnte|meta-whatsapp|enqueueLegacyWhatsappMessage|dispatchWhatsappQueue/
      );
    });
  }

  test("the mode reader is on the path too and reads only the settings row", () => {
    const body = code(read("application/whatsapp-mode.ts"));

    expect(body).not.toMatch(LEGACY_TABLE);
    expect(body).toContain("awcms_commerce_store_settings");
    expect(specifiers(read("application/whatsapp-mode.ts"))).toEqual([
      "../domain/whatsapp-mode"
    ]);
  });
});

describe("every commerce WhatsApp caller goes through the mode router (ADR-0133 section 6, end condition 1)", () => {
  for (const file of CALLERS) {
    test(`${file} reaches WhatsApp only through ./whatsapp-enqueue`, () => {
      const imported = specifiers(read(file));

      expect(imported).toContain("./whatsapp-enqueue");
      expect(
        imported.filter((specifier) =>
          /whatsapp-(dispatch|queue-purge|enqueue-legacy|provider)|fonnte|meta-whatsapp/.test(
            specifier
          )
        )
      ).toEqual([]);
      expect(code(read(file))).not.toMatch(LEGACY_TABLE);
    });
  }

  test("only the allowlisted legacy files name a legacy WhatsApp table, so no new file can start writing the legacy queue", () => {
    const offenders = allCommerceFiles().filter(
      (file) =>
        LEGACY_TABLE.test(code(read(file))) && !LEGACY_TABLE_FILES.has(file)
    );

    expect(offenders).toEqual([]);
    // The allowlist is not stale either: each entry still names a table.
    for (const file of LEGACY_TABLE_FILES) {
      expect({ file, names: LEGACY_TABLE.test(code(read(file))) }).toEqual({
        file,
        names: true
      });
    }
  });

  test("the legacy writer is imported by the router and by nothing else", () => {
    const importers = allCommerceFiles().filter((file) =>
      specifiers(read(file)).some((specifier) =>
        specifier.endsWith("whatsapp-enqueue-legacy")
      )
    );

    expect(importers).toEqual(["application/whatsapp-enqueue.ts"]);
  });
});

describe("the mode has exactly one writer (Issue #393)", () => {
  // A statement that SETs the mode column, or INSERTs the settings row with it.
  const MODE_WRITE =
    /\bSET\s+whatsapp_mode\b|\bwhatsapp_mode_changed_at\s*=|INSERT INTO awcms_commerce_store_settings[^`;]*\bwhatsapp_mode\b/;

  test("only the guarded flip writes whatsapp_mode, so nothing can move a tenant between queues around its drain check", () => {
    const writers = allCommerceFiles().filter((file) =>
      MODE_WRITE.test(code(read(file)))
    );

    expect(writers).toEqual(["application/whatsapp-mode-flip.ts"]);
  });

  test("the writer takes the exclusive mode lock and does not name the legacy table (it counts through the directory)", () => {
    const body = code(read("application/whatsapp-mode-flip.ts"));

    expect(body).toContain("lockWhatsappModeExclusive(tx, tenantId)");
    expect(body).not.toMatch(LEGACY_TABLE);
    expect(body).not.toContain("awcms_whatsapp_messages");
    expect(specifiers(read("application/whatsapp-mode-flip.ts"))).toContain(
      "../../whatsapp-delivery/application/whatsapp-diagnostics"
    );
  });

  test("no script or route writes the mode itself: both call flipWhatsappMode", () => {
    const route = readFileSync(
      resolve(import.meta.dir, "../src/pages/api/v1/commerce/whatsapp/mode.ts"),
      "utf8"
    );
    const cli = readFileSync(
      resolve(import.meta.dir, "../scripts/commerce-whatsapp-cutover.ts"),
      "utf8"
    );

    for (const source of [route, cli]) {
      expect(code(source)).toContain("flipWhatsappMode(");
      expect(code(source)).not.toMatch(MODE_WRITE);
    }
  });
});
