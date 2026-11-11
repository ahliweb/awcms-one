/**
 * Test helper for the Kepmendagri population importer (awcms-one ADR-0053):
 * stages a throwaway `rootDir` holding `data/idn-admin-regions/manifest.json`,
 * `checksums.sha256` and the two dumps, with checksums that agree — unless a test
 * asks for them not to.
 *
 * The two fixture dumps beside this file copy the vendored files' SHAPE (header,
 * DDL, `INSERT … VALUES`, a split statement in the area file, the national row,
 * two float-truncated area codes and one abbreviated name) with made-up figures
 * for four regions: province 62 and regencies 62.01, 62.10 and 62.71.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  AREA_FILE_PATH,
  AREA_SOURCE_REFERENCE,
  POPULATION_CHECKSUMS_PATH,
  POPULATION_DATA_DIR,
  POPULATION_DECREE_REFERENCE,
  POPULATION_FILE_PATH,
  POPULATION_IMPORTED_BY
} from "../../../src/modules/idn-admin-regions/domain/population-source";
import { IDN_ADMIN_REGIONS_SOURCE_REPOSITORY } from "../../../src/modules/idn-admin-regions/domain/source-provenance";

export const FIXTURE_UPSTREAM_COMMIT =
  "0123456789abcdef0123456789abcdef01234567";

/** The four regions the fixtures describe, as `parseWilayahDump` rows. */
export const FIXTURE_REGION_ROWS = [
  { code: "62", name: "Provinsi Uji", lineNumber: 1 },
  { code: "62.01", name: "Kabupaten Uji Satu", lineNumber: 2 },
  { code: "62.10", name: "Kabupaten Uji Sepuluh", lineNumber: 3 },
  { code: "62.71", name: "Kota Uji Dua", lineNumber: 4 }
];

export async function readFixture(
  name: "wilayah_penduduk.sql" | "wilayah_luas.sql"
): Promise<string> {
  return readFile(path.join(import.meta.dir, name), "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type StageOptions = {
  /** Replacement population dump text (default: the fixture). */
  population?: string;
  /** Replacement area dump text (default: the fixture). */
  area?: string;
  /** Change this file's bytes AFTER the checksums were recorded. */
  tamper?: "population" | "area";
  /** Record a wrong digest for this file in checksums.sha256 only. */
  staleChecksumsLine?: "population" | "area";
  /** Merged into the population file's manifest entry. */
  populationEntry?: Record<string, unknown>;
};

/** Writes a self-consistent source tree into a new temp directory and returns it. */
export async function stageSources(
  options: StageOptions = {}
): Promise<string> {
  const rootDir = await mkdtemp(path.join(tmpdir(), "idn-population-test-"));
  const dataDir = path.join(rootDir, POPULATION_DATA_DIR);
  const texts = {
    population:
      options.population ?? (await readFixture("wilayah_penduduk.sql")),
    area: options.area ?? (await readFixture("wilayah_luas.sql"))
  };
  const paths = { population: POPULATION_FILE_PATH, area: AREA_FILE_PATH };

  await mkdir(path.join(dataDir, path.dirname(POPULATION_FILE_PATH)), {
    recursive: true
  });

  const manifest = {
    upstream: {
      repository: IDN_ADMIN_REGIONS_SOURCE_REPOSITORY,
      commit: FIXTURE_UPSTREAM_COMMIT,
      license: "MIT"
    },
    files: [
      {
        path: POPULATION_FILE_PATH,
        sha256: sha256(texts.population),
        bytes: Buffer.byteLength(texts.population),
        role: "raw-upstream-sql",
        importedBy: POPULATION_IMPORTED_BY,
        decreeReference: POPULATION_DECREE_REFERENCE,
        upstreamLastEdit: "2025-07-04 07:58:13",
        ...options.populationEntry
      },
      {
        path: AREA_FILE_PATH,
        sha256: sha256(texts.area),
        bytes: Buffer.byteLength(texts.area),
        role: "raw-upstream-sql",
        importedBy: POPULATION_IMPORTED_BY,
        decreeReference: POPULATION_DECREE_REFERENCE,
        areaSourceReference: AREA_SOURCE_REFERENCE,
        upstreamLastEdit: "2025-07-06 15:09:55"
      }
    ]
  };
  await writeFile(
    path.join(dataDir, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );

  const checksumDir = path.posix.dirname(POPULATION_CHECKSUMS_PATH);
  const line = (which: "population" | "area") =>
    `${options.staleChecksumsLine === which ? "f".repeat(64) : sha256(texts[which])}  ${paths[which].slice(checksumDir.length + 1)}`;
  await writeFile(
    path.join(dataDir, POPULATION_CHECKSUMS_PATH),
    `${line("population")}\n${line("area")}\n`
  );

  for (const which of ["population", "area"] as const) {
    const text =
      options.tamper === which ? `${texts[which]}-- tampered\n` : texts[which];
    await writeFile(path.join(dataDir, paths[which]), text);
  }

  return rootDir;
}
