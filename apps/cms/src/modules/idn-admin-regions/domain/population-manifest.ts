/**
 * The per-dataset manifest of a BPS population publication (awcms-one
 * ADR-0051): `data/idn-population/datasets/<dataset_code>.json`, beside the
 * `<dataset_code>.csv` it describes.
 *
 * The manifest is the provenance record. Its field rules mirror the CHECK
 * constraints of `awcms_idn_population_datasets` (`sql/882`) so a bad manifest
 * is reported by name before it reaches the database as an anonymous
 * constraint violation. Pure: parses an already-decoded JSON value.
 */

export type PopulationPublicationSeries =
  | "provinsi_dalam_angka"
  | "kabupaten_kota_dalam_angka"
  | "kecamatan_dalam_angka";

export type PopulationDatasetManifest = {
  datasetCode: string;
  publicationSeries: PopulationPublicationSeries;
  coverageRegionCode: string;
  coverageRegionLevel: number;
  publicationTitle: string;
  publisherName: string;
  publisherDomain: string;
  publisherWebsite: string;
  attribution: string;
  catalogueNumber: string | null;
  publicationNumber: string | null;
  issn: string | null;
  publicationYear: number;
  releaseDate: string | null;
  publicationUrl: string;
  sourceFileSha256: string;
  sourceFileBytes: number;
  termsOfUse: string;
  csvPath: string | null;
  csvSha256: string;
};

const SERIES: readonly PopulationPublicationSeries[] = [
  "provinsi_dalam_angka",
  "kabupaten_kota_dalam_angka",
  "kecamatan_dalam_angka"
];

export const DATASET_CODE_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

export type ManifestParseResult =
  | { ok: true; manifest: PopulationDatasetManifest }
  | { ok: false; errors: string[] };

/** Validates a decoded manifest. Unknown extra fields (tablesUsed, knownGaps, ...) are allowed and ignored. */
export function parsePopulationManifest(input: unknown): ManifestParseResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["The manifest must be a JSON object."] };
  }
  const raw = input as Record<string, unknown>;

  const text = (name: string): string => {
    const value = raw[name];
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push(`${name} must be a non-empty string.`);
      return "";
    }
    return value;
  };
  const optionalText = (name: string): string | null => {
    const value = raw[name];
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") {
      errors.push(`${name} must be a string or null.`);
      return null;
    }
    return value;
  };
  const matching = (name: string, shape: RegExp, hint: string): string => {
    const value = text(name);
    if (value !== "" && !shape.test(value)) errors.push(`${name} ${hint}.`);
    return value;
  };

  const datasetCode = matching(
    "datasetCode",
    DATASET_CODE_SHAPE,
    "must be lowercase letters, digits and hyphens"
  );

  const series = text("publicationSeries");
  if (series !== "" && !(SERIES as readonly string[]).includes(series)) {
    errors.push(`publicationSeries must be one of ${SERIES.join(", ")}.`);
  }

  const coverageRegionCode = matching(
    "coverageRegionCode",
    /^\d{2}(\.\d{2}(\.\d{2}(\.\d{4})?)?)?$/,
    "must be a dotted Kemendagri code"
  );
  const coverageRegionLevel = raw.coverageRegionLevel;
  if (
    typeof coverageRegionLevel !== "number" ||
    !Number.isInteger(coverageRegionLevel) ||
    coverageRegionLevel < 1 ||
    coverageRegionLevel > 4
  ) {
    errors.push("coverageRegionLevel must be an integer 1..4.");
  } else if (
    coverageRegionCode !== "" &&
    coverageRegionCode.split(".").length !== coverageRegionLevel
  ) {
    errors.push("coverageRegionLevel does not match coverageRegionCode.");
  }

  const publicationYear = raw.publicationYear;
  if (
    typeof publicationYear !== "number" ||
    !Number.isInteger(publicationYear) ||
    publicationYear < 1961 ||
    publicationYear > 2100
  ) {
    errors.push("publicationYear must be an integer year.");
  }

  const releaseDate = optionalText("releaseDate");
  if (releaseDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    errors.push("releaseDate must be YYYY-MM-DD or null.");
  }

  const sourceFileBytes = raw.sourceFileBytes;
  if (
    typeof sourceFileBytes !== "number" ||
    !Number.isSafeInteger(sourceFileBytes) ||
    sourceFileBytes <= 0
  ) {
    errors.push("sourceFileBytes must be a positive integer.");
  }

  const manifest: PopulationDatasetManifest = {
    datasetCode,
    publicationSeries: series as PopulationPublicationSeries,
    coverageRegionCode,
    coverageRegionLevel: coverageRegionLevel as number,
    publicationTitle: text("publicationTitle"),
    publisherName: text("publisherName"),
    publisherDomain: matching(
      "publisherDomain",
      /^[0-9]{4}$/,
      "must be four digits"
    ),
    publisherWebsite: matching(
      "publisherWebsite",
      /^https:\/\/([a-z0-9-]+\.)?bps\.go\.id$/,
      "must be the https:// address of an official bps.go.id website"
    ),
    attribution: text("attribution"),
    catalogueNumber: optionalText("catalogueNumber"),
    publicationNumber: optionalText("publicationNumber"),
    issn: optionalText("issn"),
    publicationYear: publicationYear as number,
    releaseDate,
    publicationUrl: matching(
      "publicationUrl",
      /^https:\/\//,
      "must start with https://"
    ),
    sourceFileSha256: matching(
      "sourceFileSha256",
      /^[0-9a-f]{64}$/,
      "must be 64 lowercase hex digits"
    ),
    sourceFileBytes: sourceFileBytes as number,
    termsOfUse: text("termsOfUse"),
    csvPath: optionalText("csvPath"),
    csvSha256: matching(
      "csvSha256",
      /^[0-9a-f]{64}$/,
      "must be 64 lowercase hex digits"
    )
  };

  // The attribution is the row's statement that the figures came from the
  // official site; it must name that site, not merely claim it.
  if (
    manifest.publisherWebsite !== "" &&
    manifest.attribution !== "" &&
    !manifest.attribution.includes(manifest.publisherWebsite)
  ) {
    errors.push("attribution must name the publisherWebsite address.");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest };
}
