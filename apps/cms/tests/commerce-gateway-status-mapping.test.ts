/**
 * Midtrans status-mapping unit tests (Issue #110, contract #106's D3). Pure
 * — `mapMidtransStatus` (`src/modules/commerce/domain/gateway-status-mapping.ts`).
 */
import { describe, expect, test } from "bun:test";

import { mapMidtransStatus } from "../src/modules/commerce/domain/gateway-status-mapping";

describe("mapMidtransStatus", () => {
  test("capture + fraud accept -> paid", () => {
    expect(mapMidtransStatus("capture", "accept")).toBe("paid");
  });

  test("capture + fraud deny -> failed", () => {
    expect(mapMidtransStatus("capture", "deny")).toBe("failed");
  });

  test("capture + fraud challenge -> pending", () => {
    expect(mapMidtransStatus("capture", "challenge")).toBe("pending");
  });

  test("capture with no fraud_status -> pending (never guesses paid)", () => {
    expect(mapMidtransStatus("capture", null)).toBe("pending");
  });

  test("settlement -> paid regardless of fraud_status", () => {
    expect(mapMidtransStatus("settlement", null)).toBe("paid");
  });

  test("pending -> pending", () => {
    expect(mapMidtransStatus("pending", null)).toBe("pending");
  });

  test("deny -> failed", () => {
    expect(mapMidtransStatus("deny", null)).toBe("failed");
  });

  test("cancel -> expired", () => {
    expect(mapMidtransStatus("cancel", null)).toBe("expired");
  });

  test("expire -> expired", () => {
    expect(mapMidtransStatus("expire", null)).toBe("expired");
  });

  test("refund -> refunded", () => {
    expect(mapMidtransStatus("refund", null)).toBe("refunded");
  });

  test("partial_refund -> refunded", () => {
    expect(mapMidtransStatus("partial_refund", null)).toBe("refunded");
  });

  test("an unrecognized status falls back to pending, never throws", () => {
    expect(mapMidtransStatus("something_new", null)).toBe("pending");
  });
});
