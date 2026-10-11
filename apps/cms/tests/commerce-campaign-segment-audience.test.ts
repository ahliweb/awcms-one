/**
 * Campaign segment audience (Issue #362, ADR-0042 Amendment) - DB-free
 * contract and domain tests. The live behaviour is
 * `integration/commerce-campaign-segment-audience*.integration.test.ts`.
 *
 *   - request validation: a segment id/version is accepted only as a UUID and a
 *     positive integer, a version without an id is refused, a segment and the
 *     legacy filters are mutually exclusive, and a body without the new keys
 *     validates exactly as before;
 *   - the three-flag gate and the new flag's default;
 *   - the refusal mapping for a bounded evaluation (busy, too expensive, gone);
 *   - the SQL appends consent and the channel address AFTER the rule, builds no
 *     SQL text from a rule, and the dispatcher defers (never finalises) a
 *     refused page;
 *   - each segment-aware campaign route runs the gate, the legacy routes still
 *     work without it, and migration 1007 is in the allocated band.
 */
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import {
  validateCreateCampaignInput,
  validateUpdateCampaignInput
} from "../src/modules/commerce/domain/campaign-validation";
import {
  DEFAULT_COMMERCE_FEATURES,
  resolveCommerceFeatures
} from "../src/modules/commerce/domain/commerce-features";
import { firstDisabledSegmentAudienceFeature } from "../src/modules/commerce/application/campaign-segment-audience";
import { audienceRefusalResponse } from "../src/modules/commerce/application/campaign-segment-http";

const SEGMENT_ID = "3b7e2f4a-9c1d-4e6b-8a5f-0d2c1b9a7e63";
const BASE = { channel: "email", subject: "Hi", body: "Hello" };
const EMPTY = { levels: [], hasAccount: null, lastOrderSince: null };

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("create-campaign validation with a segment", () => {
  test("a body without the new keys validates exactly as before and carries no segment", () => {
    const result = validateCreateCampaignInput({ ...BASE, audience: EMPTY });
    expect(result.valid).toBe(true);
    if (result.valid) expect("segment" in result.value).toBe(false);
  });

  test("segmentId alone, and segmentId with a version, are accepted", () => {
    const latest = validateCreateCampaignInput({
      ...BASE,
      segmentId: SEGMENT_ID
    });
    expect(latest.valid && latest.value.segment).toEqual({
      segmentId: SEGMENT_ID,
      segmentVersion: null
    });
    const pinned = validateCreateCampaignInput({
      ...BASE,
      segmentId: SEGMENT_ID,
      segmentVersion: 3
    });
    expect(pinned.valid && pinned.value.segment).toEqual({
      segmentId: SEGMENT_ID,
      segmentVersion: 3
    });
  });

  test("a bad id, a non-positive or fractional version, a version without an id and a null id are refused by field", () => {
    const fields = (body: Record<string, unknown>): string[] => {
      const result = validateCreateCampaignInput({ ...BASE, ...body });
      if (result.valid) return [];
      return result.errors.map((e) => e.field);
    };
    expect(fields({ segmentId: "x" })).toContain("segmentId");
    expect(fields({ segmentId: 7 })).toContain("segmentId");
    expect(fields({ segmentId: null })).toContain("segmentId");
    expect(fields({ segmentId: SEGMENT_ID, segmentVersion: 0 })).toContain(
      "segmentVersion"
    );
    expect(fields({ segmentId: SEGMENT_ID, segmentVersion: 1.5 })).toContain(
      "segmentVersion"
    );
    expect(fields({ segmentId: SEGMENT_ID, segmentVersion: "2" })).toContain(
      "segmentVersion"
    );
    expect(fields({ segmentVersion: 2 })).toContain("segmentId");
  });

  test("a segment and legacy filters are mutually exclusive; an empty audience is fine", () => {
    for (const audience of [
      { ...EMPTY, levels: [1] },
      { ...EMPTY, hasAccount: true },
      { ...EMPTY, lastOrderSince: "2026-01-01T00:00:00.000Z" }
    ]) {
      const result = validateCreateCampaignInput({
        ...BASE,
        segmentId: SEGMENT_ID,
        audience
      });
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.errors.map((e) => e.field)).toContain("audience");
      }
    }
    expect(
      validateCreateCampaignInput({
        ...BASE,
        segmentId: SEGMENT_ID,
        audience: EMPTY
      }).valid
    ).toBe(true);
  });
});

describe("update-campaign validation with a segment", () => {
  test("not mentioning a segment leaves it undefined (the legacy PATCH); null detaches; an id attaches", () => {
    const plain = validateUpdateCampaignInput({ subject: "x" });
    expect(plain.valid && plain.value.segment).toBeUndefined();
    const detach = validateUpdateCampaignInput({ segmentId: null });
    expect(detach.valid && detach.value.segment).toBeNull();
    const attach = validateUpdateCampaignInput({ segmentId: SEGMENT_ID });
    expect(attach.valid && attach.value.segment).toEqual({
      segmentId: SEGMENT_ID,
      segmentVersion: null
    });
  });

  test("attaching with legacy filters in the same body is refused; detaching with filters is allowed", () => {
    expect(
      validateUpdateCampaignInput({
        segmentId: SEGMENT_ID,
        audience: { ...EMPTY, levels: [2] }
      }).valid
    ).toBe(false);
    expect(
      validateUpdateCampaignInput({
        segmentId: null,
        audience: { ...EMPTY, levels: [2] }
      }).valid
    ).toBe(true);
  });

  test("a version with a null id is refused", () => {
    expect(
      validateUpdateCampaignInput({ segmentId: null, segmentVersion: 2 }).valid
    ).toBe(false);
  });
});

describe("the feature gate", () => {
  test("campaignSegmentAudience defaults OFF and a stored settings row without it still reads OFF", () => {
    expect(DEFAULT_COMMERCE_FEATURES.campaignSegmentAudience).toBe(false);
    expect(
      resolveCommerceFeatures({ features: { segments: true, campaigns: true } })
        .campaignSegmentAudience
    ).toBe(false);
  });

  test("the first disabled of campaigns, segments, campaignSegmentAudience is named; none when all are on", () => {
    const on = resolveCommerceFeatures({
      features: { segments: true, campaignSegmentAudience: true }
    });
    expect(firstDisabledSegmentAudienceFeature(on)).toBeNull();
    expect(
      firstDisabledSegmentAudienceFeature({ ...on, campaigns: false })
    ).toBe("campaigns");
    expect(
      firstDisabledSegmentAudienceFeature({ ...on, segments: false })
    ).toBe("segments");
    expect(
      firstDisabledSegmentAudienceFeature({
        ...on,
        campaignSegmentAudience: false
      })
    ).toBe("campaignSegmentAudience");
  });
});

describe("refusals of a bounded evaluation surface as stable codes", () => {
  test("busy is 429, too expensive is 422, a vanished segment is 409, a number is not a refusal", async () => {
    const busy = audienceRefusalResponse({ kind: "busy" });
    expect(busy?.status).toBe(429);
    expect(busy?.headers.get("retry-after")).toBe("2");
    expect(
      ((await busy?.json()) as { error: { code: string } }).error.code
    ).toBe("SEGMENT_EVALUATION_BUSY");
    const expensive = audienceRefusalResponse({ kind: "too_expensive" });
    expect(expensive?.status).toBe(422);
    expect(
      ((await expensive?.json()) as { error: { code: string } }).error.code
    ).toBe("SEGMENT_TOO_EXPENSIVE");
    const gone = audienceRefusalResponse({ kind: "segment_missing" });
    expect(gone?.status).toBe(409);
    expect(audienceRefusalResponse({ kind: "ok" })).toBeNull();
  });
});

describe("static contract", () => {
  test("the campaign reach is appended after the rule and builds no SQL text", async () => {
    const sql = await source("src/modules/commerce/application/segment-sql.ts");
    const tail = sql.slice(sql.indexOf("function segmentTail"));
    expect(tail.indexOf("nodePredicate(tx, input.node")).toBeLessThan(
      tail.indexOf("reachPredicate(tx, input.tenantId, reach)")
    );
    expect(sql).toContain("ca.marketing_consent_at IS NOT NULL");
    expect(sql).toContain("ca.status = 'active'");
    expect(sql).not.toContain("unsafe(");
  });

  test("the dispatcher defers a refused segment page and never finalises it as drained", async () => {
    const dispatch = await source(
      "src/modules/commerce/application/campaign-dispatch.ts"
    );
    expect(dispatch).toContain("deferred: segmentPage.reason");
    // The deferred branch breaks out of the page loop before `exhausted` can be set.
    const deferredAt = dispatch.indexOf("if (pageResult.deferred)");
    const exhaustedAt = dispatch.indexOf("exhausted = true");
    expect(deferredAt).toBeGreaterThan(0);
    expect(deferredAt).toBeLessThan(exhaustedAt);
    // The claim keeps FOR UPDATE SKIP LOCKED and stamps the as-of exactly once.
    expect(dispatch).toContain("FOR UPDATE SKIP LOCKED");
    expect(dispatch).toContain("COALESCE(segment_as_of, now())");
  });

  test("every segment-aware campaign route runs the gate and the legacy routes name no segment unless the body does", async () => {
    const create = await source("src/pages/api/v1/commerce/campaigns/index.ts");
    expect(create).toContain("attachSegmentToDraft");
    expect(create).toContain("if (prepared.segment)");
    const edit = await source(
      "src/pages/api/v1/commerce/campaigns/[id]/index.ts"
    );
    expect(edit).toContain("attachSegmentToDraft");
    const preview = await source(
      "src/pages/api/v1/commerce/campaigns/[id]/preview.ts"
    );
    expect(preview).toContain("requireSegmentPreviewsRead");
    expect(preview).toContain("requireCampaignSegmentAudienceFeature");
    expect(preview).toContain("throttlePreview");
    const send = await source(
      "src/pages/api/v1/commerce/campaigns/[id]/send.ts"
    );
    expect(send).toContain("requireCampaignSegmentAudienceFeature");
    expect(send).toContain("countCampaignSegmentAudience");
  });

  test("migration 1007 is the campaign segment audience columns, in the band ADR-0037 allocated", async () => {
    const migration = await source(
      "sql/1007_awcms_commerce_campaign_segment_audience.sql"
    );
    expect(migration).toContain("segment_as_of");
    expect(migration).toContain(
      "REFERENCES awcms_commerce_segment_versions (tenant_id, segment_id, version)"
    );
    // No new table, hence nothing for RLS or lifecycle coverage to register.
    expect(migration).not.toContain("CREATE TABLE");
  });
});
