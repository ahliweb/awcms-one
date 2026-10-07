/**
 * The guard that keeps issue #72's rule true after every future `git subtree
 * pull`: every commerce migration lives in the reserved `900`-`9999` range,
 * and no non-commerce (upstream-owned) migration does. See
 * `docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md` in
 * awcms-one and `AGENTS.md`'s subtree section.
 *
 * The band was `900`-`999` until upstream's `db-migrate` accepted four-digit
 * prefixes ordered numerically (ahliweb/awcms#911, upstream ADR-0130). Per
 * awcms-one ADR-0037 D3 it widened to `9999` in the sync that brought that
 * change; commerce continues at `1000`. Upstream still owns `001`-`899`.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

const SQL_DIR = path.resolve(import.meta.dir, "..", "sql");
const FILE_PATTERN = /^(\d{3,4})_awcms_([a-z0-9_]+)\.sql$/;

function migrationFiles(): {
  name: string;
  prefix: number;
  isCommerce: boolean;
}[] {
  return readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = FILE_PATTERN.exec(name);

      if (!match) {
        throw new Error(`Unexpected migration file name: ${name}`);
      }

      const [, prefix, area] = match as unknown as [string, string, string];

      return {
        name,
        prefix: Number(prefix),
        isCommerce: area.startsWith("commerce_") || area === "commerce"
      };
    });
}

describe("commerce migrations stay in the reserved 900-9999 range", () => {
  test("every commerce migration has a prefix in 900-9999", () => {
    for (const file of migrationFiles().filter((f) => f.isCommerce)) {
      expect(file.prefix).toBeGreaterThanOrEqual(900);
      expect(file.prefix).toBeLessThanOrEqual(9999);
    }
  });

  test("every non-commerce migration has a 3-digit prefix below 900", () => {
    for (const file of migrationFiles().filter((f) => !f.isCommerce)) {
      expect(file.name).toMatch(/^\d{3}_/);
      expect(file.prefix).toBeLessThan(900);
    }
  });

  test("at least the sixteen known commerce migrations are present", () => {
    const commerceFiles = migrationFiles().filter((f) => f.isCommerce);

    expect(commerceFiles.length).toBeGreaterThanOrEqual(16);
  });
});
