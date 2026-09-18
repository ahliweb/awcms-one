#!/usr/bin/env bun
/**
 * commerce:migrations:renumber — one-off compatibility script for issue #72.
 *
 * ## Why this exists
 *
 * This repo's own `commerce` module originally shipped sixteen migrations as
 * `sql/153_awcms_commerce_schema.sql` … `sql/168_awcms_commerce_orders_expire_worker_write_grants.sql`,
 * inside upstream `ahliweb/awcms`'s own `001`-`899` numbering range. Upstream
 * has since started adding its own `sql/153`, `154`, … and will keep doing so,
 * colliding with ours forever. Issue #72 renumbers the sixteen commerce
 * migrations into a reserved `901`-`916` range (offset +748) that upstream
 * will never reach; future commerce migrations continue at `917`. See
 * `docs/adr/0015-commerce-migrations-live-in-the-reserved-9xx-range.md`.
 *
 * The migration files themselves were moved with `git mv` in the same change
 * that added this script — a fresh database that has never run `db:migrate`
 * needs nothing else, because it will simply apply the sixteen files under
 * their new names.
 *
 * A database that ALREADY ran `db:migrate` against the old file names has
 * sixteen rows in `awcms_schema_migrations` keyed by the OLD filename and
 * checksum. `apps/cms/scripts/db-migrate.ts` (upstream — never edited locally)
 * applies files in lexical order and keys applied rows by full filename, so
 * without this script such a database would try to re-apply all sixteen
 * migrations under their new names — `CREATE TABLE` on tables that already
 * exist, and worse.
 *
 * This script is the one-off fix: for each of the sixteen old names still
 * present in `awcms_schema_migrations`, it updates that row's
 * `migration_name` to the new filename and its `checksum` to the checksum of
 * the NEW file on disk (the file's bytes are unchanged by the rename, so the
 * checksum is unchanged too — this is a defensive recompute, not a
 * correction). One transaction, all-or-nothing.
 *
 * ## Why the two helpers are copied, not imported
 *
 * `./db-migrate` exports `computeMigrationChecksum` and
 * `discoverMigrationFiles` with no side effects on import (its `main()` only
 * runs behind `if (import.meta.main)`), so both could be imported directly.
 * They are copied here instead, verbatim, so this one-off compatibility
 * script has no runtime dependency on the upstream migration runner file at
 * all — the two files can now evolve (or be deleted, once every database has
 * run this script once) completely independently. `stripOptionalTransactionWrapper`
 * is not needed here: this script never executes migration SQL, only hashes
 * file contents that `discoverMigrationFiles`'s equivalent below already
 * strips before hashing, matching `db-migrate.ts`'s own checksum shape
 * exactly.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { redactSecretsInText } from "../src/modules/_shared/redaction";

const SQL_DIR = path.resolve(process.cwd(), "sql");

/** Copied from `./db-migrate.ts`'s `computeMigrationChecksum` — see this file's own header for why. */
function computeMigrationChecksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

/** Copied from `./db-migrate.ts`'s `stripOptionalTransactionWrapper` — see this file's own header for why. */
function stripOptionalTransactionWrapper(sql: string): string {
  return sql
    .trim()
    .replace(/^(BEGIN|START\s+TRANSACTION)\s*;\s*/i, "")
    .replace(/\s*(COMMIT|ROLLBACK)\s*;\s*$/i, "")
    .trim();
}

/** The sixteen commerce migrations, old name -> new name, offset +748 (issue #72). */
export const OLD_TO_NEW: Readonly<Record<string, string>> = Object.freeze({
  "153_awcms_commerce_schema.sql": "901_awcms_commerce_schema.sql",
  "154_awcms_commerce_permissions.sql": "902_awcms_commerce_permissions.sql",
  "155_awcms_commerce_worker_lifecycle_purge_grants.sql":
    "903_awcms_commerce_worker_lifecycle_purge_grants.sql",
  "156_awcms_commerce_product_columns.sql":
    "904_awcms_commerce_product_columns.sql",
  "157_awcms_commerce_product_images_variants.sql":
    "905_awcms_commerce_product_images_variants.sql",
  "158_awcms_commerce_restore_permissions.sql":
    "906_awcms_commerce_restore_permissions.sql",
  "159_awcms_commerce_list_filter_indexes.sql":
    "907_awcms_commerce_list_filter_indexes.sql",
  "160_awcms_commerce_relations_worker_lifecycle_purge_grants.sql":
    "908_awcms_commerce_relations_worker_lifecycle_purge_grants.sql",
  "161_awcms_commerce_marketing_schema.sql":
    "909_awcms_commerce_marketing_schema.sql",
  "162_awcms_commerce_store_settings.sql":
    "910_awcms_commerce_store_settings.sql",
  "163_awcms_commerce_marketing_permissions.sql":
    "911_awcms_commerce_marketing_permissions.sql",
  "164_awcms_commerce_marketing_worker_lifecycle_purge_grants.sql":
    "912_awcms_commerce_marketing_worker_lifecycle_purge_grants.sql",
  "165_awcms_commerce_customers_orders_schema.sql":
    "913_awcms_commerce_customers_orders_schema.sql",
  "166_awcms_commerce_customers_orders_permissions.sql":
    "914_awcms_commerce_customers_orders_permissions.sql",
  "167_awcms_commerce_customers_orders_worker_lifecycle_purge_grants.sql":
    "915_awcms_commerce_customers_orders_worker_lifecycle_purge_grants.sql",
  "168_awcms_commerce_orders_expire_worker_write_grants.sql":
    "916_awcms_commerce_orders_expire_worker_write_grants.sql"
});

export type RenamePlan = {
  /** [oldName, newName] pairs to apply — the old name is applied, the new name is not. */
  rename: [string, string][];
  /** New names that are already applied — nothing to do for that migration. */
  skip: string[];
  /** Migrations where BOTH the old and new name are applied — refuse, no writes. */
  conflicts: [string, string][];
};

/**
 * Pure planning function, unit-testable without a database. `appliedNames` is
 * the full set of `migration_name` values currently in
 * `awcms_schema_migrations` (any migration, not just commerce ones — this
 * function only looks at names inside `OLD_TO_NEW`).
 */
export function planRenames(appliedNames: string[]): RenamePlan {
  const applied = new Set(appliedNames);
  const rename: [string, string][] = [];
  const skip: string[] = [];
  const conflicts: [string, string][] = [];

  for (const [oldName, newName] of Object.entries(OLD_TO_NEW)) {
    const oldApplied = applied.has(oldName);
    const newApplied = applied.has(newName);

    if (oldApplied && newApplied) {
      conflicts.push([oldName, newName]);
    } else if (oldApplied) {
      rename.push([oldName, newName]);
    } else if (newApplied) {
      skip.push(newName);
    }
    // Neither applied: nothing to do for this migration (fresh database, or
    // this migration was never reached yet — `db:migrate` will apply the new
    // file directly).
  }

  return { rename, skip, conflicts };
}

function maskUrlPassword(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);

    if (url.password) url.password = "****";

    return url.toString();
  } catch {
    return databaseUrl;
  }
}

function redactDatabaseUrl(input: string, databaseUrl: string): string {
  if (!databaseUrl) return input;

  return input
    .split(databaseUrl)
    .join("[redacted DATABASE_URL]")
    .split(maskUrlPassword(databaseUrl))
    .join("[redacted DATABASE_URL]");
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required to run commerce:migrations:renumber."
    );
  }

  if (!databaseUrl.startsWith("postgres://")) {
    throw new Error("DATABASE_URL must use the postgres:// protocol.");
  }

  return databaseUrl;
}

function safeErrorMessage(error: unknown, databaseUrl: string): string {
  const message = error instanceof Error ? error.message : String(error);

  return redactSecretsInText(redactDatabaseUrl(message, databaseUrl));
}

async function checksumOf(newName: string): Promise<string> {
  const filePath = path.join(SQL_DIR, newName);
  const raw = await readFile(filePath, "utf8");

  return computeMigrationChecksum(stripOptionalTransactionWrapper(raw));
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let databaseUrl = "";
  let sql: Bun.SQL | undefined;

  try {
    databaseUrl = getDatabaseUrl();
    sql = new Bun.SQL(databaseUrl, { max: 1 });

    const appliedRows = await sql<{ migration_name: string }[]>`
      SELECT migration_name FROM awcms_schema_migrations
      WHERE migration_name = ANY(${Object.keys(OLD_TO_NEW).concat(
        Object.values(OLD_TO_NEW)
      )})
    `;

    const plan = planRenames(appliedRows.map((r) => r.migration_name));

    if (plan.conflicts.length > 0) {
      console.error(
        "db:commerce:renumber refused — both the old and new name are applied for:"
      );
      for (const [oldName, newName] of plan.conflicts) {
        console.error(`  ${oldName} AND ${newName}`);
      }
      process.exitCode = 1;
      return;
    }

    if (plan.rename.length === 0) {
      console.log("db:commerce:renumber — nothing to do");
      return;
    }

    console.log(
      `db:commerce:renumber — planned renames (${plan.rename.length}):`
    );
    for (const [oldName, newName] of plan.rename) {
      console.log(`  ${oldName} -> ${newName}`);
    }
    if (plan.skip.length > 0) {
      console.log(
        `db:commerce:renumber — already renamed, skipping: ${plan.skip.join(", ")}`
      );
    }

    if (dryRun) {
      console.log("db:commerce:renumber — dry run, no writes made");
      return;
    }

    await sql.begin(async (tx) => {
      for (const [oldName, newName] of plan.rename) {
        const checksum = await checksumOf(newName);

        await tx`
          UPDATE awcms_schema_migrations
          SET migration_name = ${newName}, checksum = ${checksum}
          WHERE migration_name = ${oldName}
        `;
      }
    });

    console.log(
      `db:commerce:renumber complete — ${plan.rename.length} renamed`
    );
  } catch (error) {
    console.error(
      `db:commerce:renumber failed — ${safeErrorMessage(error, databaseUrl)}`
    );
    process.exitCode = 1;
  } finally {
    await sql?.close({ timeout: 1 });
  }
}

if (import.meta.main) {
  await main();
}
