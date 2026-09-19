/**
 * Midtrans webhook signature unit tests (Issue #110, contract #106's D3).
 * Pure, no I/O — `computeMidtransSignature`/`verifyMidtransSignature`
 * (`src/modules/commerce/domain/midtrans-signature.ts`).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  computeMidtransSignature,
  verifyMidtransSignature
} from "../src/modules/commerce/domain/midtrans-signature";

const SAMPLE = {
  orderId: "ORD-1-1",
  statusCode: "200",
  grossAmount: "150000.00",
  serverKey: "SB-Mid-server-abc123"
};

function expectedSignature(): string {
  return createHash("sha512")
    .update(
      `${SAMPLE.orderId}${SAMPLE.statusCode}${SAMPLE.grossAmount}${SAMPLE.serverKey}`
    )
    .digest("hex");
}

describe("computeMidtransSignature", () => {
  test("matches sha512(order_id + status_code + gross_amount + ServerKey)", () => {
    expect(computeMidtransSignature(SAMPLE)).toBe(expectedSignature());
  });

  test("is deterministic", () => {
    expect(computeMidtransSignature(SAMPLE)).toBe(
      computeMidtransSignature(SAMPLE)
    );
  });

  test("changes when any input changes", () => {
    const base = computeMidtransSignature(SAMPLE);
    expect(
      computeMidtransSignature({ ...SAMPLE, orderId: "ORD-1-2" })
    ).not.toBe(base);
    expect(computeMidtransSignature({ ...SAMPLE, statusCode: "201" })).not.toBe(
      base
    );
    expect(
      computeMidtransSignature({ ...SAMPLE, grossAmount: "150001.00" })
    ).not.toBe(base);
    expect(
      computeMidtransSignature({ ...SAMPLE, serverKey: "different" })
    ).not.toBe(base);
  });
});

describe("verifyMidtransSignature", () => {
  test("accepts the correct signature", () => {
    expect(
      verifyMidtransSignature({ ...SAMPLE, signatureKey: expectedSignature() })
    ).toBe(true);
  });

  test("accepts a correct signature regardless of hex casing", () => {
    expect(
      verifyMidtransSignature({
        ...SAMPLE,
        signatureKey: expectedSignature().toUpperCase()
      })
    ).toBe(true);
  });

  test("rejects a wrong signature of the correct length", () => {
    const wrong = "0".repeat(128);
    expect(verifyMidtransSignature({ ...SAMPLE, signatureKey: wrong })).toBe(
      false
    );
  });

  test("rejects a malformed (wrong length) signature without throwing", () => {
    expect(
      verifyMidtransSignature({ ...SAMPLE, signatureKey: "too-short" })
    ).toBe(false);
  });

  test("rejects a non-hex signature of the right length without throwing", () => {
    const nonHex = "z".repeat(128);
    expect(verifyMidtransSignature({ ...SAMPLE, signatureKey: nonHex })).toBe(
      false
    );
  });

  test("rejects an empty signature", () => {
    expect(verifyMidtransSignature({ ...SAMPLE, signatureKey: "" })).toBe(
      false
    );
  });

  test("rejects when any other input differs from what the signature was computed over", () => {
    const signatureKey = expectedSignature();
    expect(
      verifyMidtransSignature({
        ...SAMPLE,
        grossAmount: "150001.00",
        signatureKey
      })
    ).toBe(false);
  });
});
