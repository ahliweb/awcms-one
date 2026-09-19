/**
 * tools/seed-borneojek-mart.ts — DEPRECATED shim (issue #139).
 *
 * This file used to BE the seeder. Its logic moved to `tools/seed-cms.ts`,
 * which generalizes it behind `--profil <toko|berita|landing|
 * contoh:borneojek-mart>` — the exact same pipeline this file used to run,
 * now the `contoh:borneojek-mart` profile (the default, so
 * `bun run db:seed:cms` with no flags is unchanged for the live reference
 * deployment — see `tools/seed-cms.ts`'s own docblock and ADR-0018 D6).
 *
 * Kept for ONE release as a deprecation shim, per this issue's own
 * contract — delete it (and this note) once every place that invoked this
 * file directly has moved to `tools/seed-cms.ts` (or `bun run db:seed:cms`,
 * which already points at it). `docs/template.md`'s "What it removes"
 * section for `template:init` (issue #138) already names this file's
 * eventual removal.
 */
console.error(
  "tools/seed-borneojek-mart.ts is deprecated — it now delegates to " +
    "`tools/seed-cms.ts --profil contoh:borneojek-mart`. Run that directly " +
    "(or `bun run db:seed:cms`, which already points at it) instead. This " +
    "shim will be removed in a future release."
);

const { main } = await import("./seed-cms.ts");
await main(["--profil", "contoh:borneojek-mart", ...process.argv.slice(2)]).catch((error: unknown) => {
  console.error(`db:seed:cms failed — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
