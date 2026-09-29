/**
 * Issue #268 (IRMbyDUS: media-library private object class + presigned GET)
 * — pure unit coverage for the visibility class itself and the two
 * predicates that gate on it. No DB; the DB-backed regression proving the
 * exclusion holds end-to-end through the actual resolver is
 * `tests/integration/media-object-resolve.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  isMediaVisibility,
  MEDIA_VISIBILITIES
} from "../src/modules/media-library/domain/media-visibility";
import {
  isMediaObjectDownloadable,
  isNewsMediaObjectSafeForPublicReference
} from "../src/modules/media-library/application/media-object-directory";

describe("MEDIA_VISIBILITIES / isMediaVisibility", () => {
  test("accepts exactly public and private", () => {
    expect(MEDIA_VISIBILITIES).toEqual(["public", "private"]);
    expect(isMediaVisibility("public")).toBe(true);
    expect(isMediaVisibility("private")).toBe(true);
  });

  test("rejects anything else, including near-misses", () => {
    expect(isMediaVisibility("Public")).toBe(false);
    expect(isMediaVisibility("PRIVATE")).toBe(false);
    expect(isMediaVisibility("")).toBe(false);
    expect(isMediaVisibility(null)).toBe(false);
    expect(isMediaVisibility(undefined)).toBe(false);
    expect(isMediaVisibility(1)).toBe(false);
  });
});

describe("isNewsMediaObjectSafeForPublicReference (Issue #268 — now requires visibility)", () => {
  test("a verified/attached PUBLIC object is safe", () => {
    expect(isNewsMediaObjectSafeForPublicReference("verified", "public")).toBe(
      true
    );
    expect(isNewsMediaObjectSafeForPublicReference("attached", "public")).toBe(
      true
    );
  });

  test("a verified/attached PRIVATE object is NEVER safe — the whole point of this issue", () => {
    expect(isNewsMediaObjectSafeForPublicReference("verified", "private")).toBe(
      false
    );
    expect(isNewsMediaObjectSafeForPublicReference("attached", "private")).toBe(
      false
    );
  });

  test("an unsafe status stays unsafe regardless of visibility", () => {
    for (const visibility of MEDIA_VISIBILITIES) {
      expect(
        isNewsMediaObjectSafeForPublicReference("pending_upload", visibility)
      ).toBe(false);
      expect(
        isNewsMediaObjectSafeForPublicReference("uploaded", visibility)
      ).toBe(false);
      expect(
        isNewsMediaObjectSafeForPublicReference("failed", visibility)
      ).toBe(false);
      expect(
        isNewsMediaObjectSafeForPublicReference("orphaned", visibility)
      ).toBe(false);
      expect(
        isNewsMediaObjectSafeForPublicReference("deleted", visibility)
      ).toBe(false);
    }
  });
});

describe("isMediaObjectDownloadable (Issue #268 — status only, deliberately visibility-blind)", () => {
  test("verified/attached are downloadable regardless of visibility", () => {
    expect(isMediaObjectDownloadable("verified")).toBe(true);
    expect(isMediaObjectDownloadable("attached")).toBe(true);
  });

  test("every other status is not downloadable", () => {
    expect(isMediaObjectDownloadable("pending_upload")).toBe(false);
    expect(isMediaObjectDownloadable("uploaded")).toBe(false);
    expect(isMediaObjectDownloadable("failed")).toBe(false);
    expect(isMediaObjectDownloadable("orphaned")).toBe(false);
    expect(isMediaObjectDownloadable("deleted")).toBe(false);
  });
});
