/**
 * The deposits screen's paging rules (Issue #385 follow-up #448, "Deposits
 * screen limit"): the cursor round-trips, an unreadable one is the first page
 * (never an error, never an injected value), and the constants say what the
 * screen promises. The database side is
 * `tests/integration/commerce-booking-deposit-list.integration.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import {
  DEPOSIT_LIST_PAGE_SIZE,
  SERVICE_PRODUCT_SELECTOR_LIMIT,
  decodeDepositListCursor,
  encodeDepositListCursor
} from "../src/modules/commerce/domain/booking-deposit-list";

const ID = "0192f3a0-1b2c-4d5e-8f90-abcdef012345";

describe("deposit list cursor", () => {
  test("round-trips a name with spaces, quotes, accents and separators", () => {
    for (const name of [
      "Villa Kamar",
      'Kamar "A"',
      "Pondok|1",
      "Sesi pijat é",
      ""
    ]) {
      expect(
        decodeDepositListCursor(encodeDepositListCursor({ name, id: ID }))
      ).toEqual({ name, id: ID });
    }
  });

  test("is URL-safe", () => {
    const cursor = encodeDepositListCursor({ name: "a/b+c?d=e&f", id: ID });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("an unreadable cursor is the first page", () => {
    const bad = [
      null,
      undefined,
      "",
      "not-base64-json!!",
      Buffer.from("[]").toString("base64url"),
      Buffer.from('["x"]').toString("base64url"),
      Buffer.from('["x", 5]').toString("base64url"),
      Buffer.from('["x", "not-a-uuid"]').toString("base64url"),
      Buffer.from('{"name":"x","id":"' + ID + '"}').toString("base64url"),
      "A".repeat(2000)
    ];
    for (const raw of bad) expect(decodeDepositListCursor(raw)).toBeNull();
  });
});

test("the page is smaller than the selector cap, which stays 200", () => {
  expect(DEPOSIT_LIST_PAGE_SIZE).toBe(50);
  expect(SERVICE_PRODUCT_SELECTOR_LIMIT).toBe(200);
});
