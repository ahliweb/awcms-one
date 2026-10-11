/**
 * Loyalty eligibility by segment (Issue #361, ADR-0042 amendment) - the
 * database-free half: request validation, the contract between the migration,
 * the routes, the OpenAPI document and the earn path. The database half is
 * `tests/integration/commerce-loyalty-segment-eligibility.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import {
  DEFAULT_COMMERCE_FEATURES,
  resolveCommerceFeatures
} from "../src/modules/commerce/domain/commerce-features";
import {
  validateCreateLoyaltyProgram,
  validateLoyaltyProgramPatch
} from "../src/modules/commerce/domain/loyalty-validation";

const SEGMENT = "0a1b2c3d-0361-4a1a-8a1a-a1a1a1a1a1a1";
const BASE = { name: "P", earnUnitAmount: "10000", earnPointsPerUnit: 1 };

describe("program input: the eligibility fields", () => {
  test("absent means unrestricted, with both fields null", () => {
    const result = validateCreateLoyaltyProgram(BASE);
    expect(result.valid && result.value.eligibilitySegmentId).toBeNull();
    expect(result.valid && result.value.eligibilitySegmentVersion).toBeNull();
  });

  test("a segment id alone pins 'latest' (version null); a version is kept", () => {
    const latest = validateCreateLoyaltyProgram({
      ...BASE,
      eligibilitySegmentId: SEGMENT.toUpperCase()
    });
    expect(latest.valid && latest.value.eligibilitySegmentId).toBe(SEGMENT);
    expect(latest.valid && latest.value.eligibilitySegmentVersion).toBeNull();
    const pinned = validateCreateLoyaltyProgram({
      ...BASE,
      eligibilitySegmentId: SEGMENT,
      eligibilitySegmentVersion: 3
    });
    expect(pinned.valid && pinned.value.eligibilitySegmentVersion).toBe(3);
  });

  test("a version without an id, a non-uuid id and a bad version are refused by field name", () => {
    for (const [body, field] of [
      [{ eligibilitySegmentVersion: 2 }, "eligibilitySegmentVersion"],
      [{ eligibilitySegmentId: "not-a-uuid" }, "eligibilitySegmentId"],
      [{ eligibilitySegmentId: 7 }, "eligibilitySegmentId"],
      [
        { eligibilitySegmentId: SEGMENT, eligibilitySegmentVersion: 0 },
        "eligibilitySegmentVersion"
      ],
      [
        { eligibilitySegmentId: SEGMENT, eligibilitySegmentVersion: "2" },
        "eligibilitySegmentVersion"
      ]
    ] as const) {
      const result = validateCreateLoyaltyProgram({ ...BASE, ...body });
      expect(result.valid).toBe(false);
      expect(!result.valid && result.errors.map((e) => e.field)).toContain(
        field
      );
    }
  });

  test("a patch can set, re-point or clear the restriction, and an untouched patch leaves it out", () => {
    const set = validateLoyaltyProgramPatch({ eligibilitySegmentId: SEGMENT });
    expect(set.valid && set.value).toEqual({
      eligibilitySegmentId: SEGMENT,
      eligibilitySegmentVersion: null
    });
    const clear = validateLoyaltyProgramPatch({ eligibilitySegmentId: null });
    expect(clear.valid && clear.value).toEqual({
      eligibilitySegmentId: null,
      eligibilitySegmentVersion: null
    });
    const other = validateLoyaltyProgramPatch({ name: "x" });
    expect(other.valid && "eligibilitySegmentId" in other.value).toBe(false);
  });
});

describe("the loyaltySegments feature", () => {
  test("defaults OFF and is independent of loyalty and segments", () => {
    expect(DEFAULT_COMMERCE_FEATURES.loyaltySegments).toBe(false);
    const features = resolveCommerceFeatures({
      features: { loyalty: true, segments: true }
    });
    expect(features.loyaltySegments).toBe(false);
  });
});

describe("migration, routes, contract and earn wiring", () => {
  test("sql/1005 adds the pair, the composite FK, the CHECK and the draft-only trigger, and grants nothing", async () => {
    const sql = await readFile(
      "sql/1005_awcms_commerce_loyalty_segment_eligibility.sql",
      "utf8"
    );
    expect(sql).toContain("eligibility_segment_id uuid");
    expect(sql).toContain("eligibility_segment_version integer");
    expect(sql).toContain(
      "FOREIGN KEY (tenant_id, eligibility_segment_id, eligibility_segment_version)"
    );
    expect(sql).toContain(
      "REFERENCES awcms_commerce_segment_versions (tenant_id, segment_id, version)"
    );
    expect(sql).toContain(
      "(eligibility_segment_id IS NULL) = (eligibility_segment_version IS NULL)"
    );
    expect(sql).toContain("OLD.status <> 'draft'");
    expect(sql).not.toMatch(/\bGRANT\b/);
  });

  test("the earn path applies the restriction only behind the feature, after the replay guard, and consent is never read", async () => {
    const ledger = await readFile(
      "src/modules/commerce/application/loyalty-ledger.ts",
      "utf8"
    );
    const earn = ledger.slice(
      ledger.indexOf("export async function earnPointsForPaidOrder")
    );
    const check = earn.indexOf("features.loyaltySegments");
    expect(check).toBeGreaterThan(0);
    expect(earn.indexOf("earnEntryExists")).toBeGreaterThan(check);
    expect(earn.indexOf("decideProgramEligibility")).toBeGreaterThan(check);
    expect(earn.indexOf("computeEarnPoints(")).toBeGreaterThan(
      earn.indexOf("decideProgramEligibility")
    );
    // The consumer must keep going through the runtime's once-wrapper only.
    expect(ledger).not.toContain("applyConsumerEffectOnce(");

    const eligibility = await readFile(
      "src/modules/commerce/application/loyalty-eligibility.ts",
      "utf8"
    );
    expect(eligibility.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
      /consent/i
    );
  });

  test("the program routes resolve the reference through the one helper, which needs both features and commerce.segments.read", async () => {
    for (const path of [
      "src/pages/api/v1/commerce/loyalty/programs/index.ts",
      "src/pages/api/v1/commerce/loyalty/programs/[id]/index.ts"
    ]) {
      const route = await readFile(path, "utf8");
      expect(route).toContain("resolveEligibilityRequest");
    }
    const http = await readFile(
      "src/modules/commerce/application/loyalty-eligibility-http.ts",
      "utf8"
    );
    expect(http).toContain('"loyaltySegments"');
    expect(http).toContain('"segments"');
    expect(http).toContain("COMMERCE_SEGMENTS_ACTIVITY_CODE");
    expect(http).toContain("SEGMENT_NOT_FOUND");
  });

  test("the OpenAPI fragment documents the fields on input, output and patch, and the 422", async () => {
    const yaml = await readFile(
      "openapi/modules/commerce.openapi.yaml",
      "utf8"
    );
    expect(yaml.match(/eligibilitySegmentId:/g)?.length).toBeGreaterThanOrEqual(
      3
    );
    expect(yaml).toContain("SEGMENT_NOT_FOUND");
    const admin = await readFile(
      "src/pages/admin/commerce-loyalty.astro",
      "utf8"
    );
    expect(admin).toContain('name="eligibilitySegmentId"');
    expect(admin).toContain("segmentEligibility");
  });
});
