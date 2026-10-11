/**
 * `src/lib/poin-kontrak.ts` - the loyalty-points checkout contract (awcms-one
 * issue #363, ADR-0043). Pure; no DOM, no network. Also pins, structurally,
 * the three things the storefront must never do with points: send anything
 * but a whole number, send a cookie, or invent a second session.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  bacaPoinInput,
  bolehPakaiPoin,
  parsePoinAkun,
  perkiraanDiskonPoin,
  pesanKesalahanPoin
} from "../src/lib/poin-kontrak";

describe("parsePoinAkun", () => {
  test("accepts the CMS's balance and point value", () => {
    expect(
      parsePoinAkun({ balance: 1200, redemption: { rupiahPerPoint: 100, maxGoodsPercent: 50 }, history: {} })
    ).toEqual({ balance: 1200, redemption: { rupiahPerPoint: 100, maxGoodsPercent: 50 } });
    expect(parsePoinAkun({ balance: 5, redemption: { rupiahPerPoint: 1 } })).toEqual({
      balance: 5,
      redemption: { rupiahPerPoint: 1, maxGoodsPercent: null }
    });
  });

  test("a null or absent redemption means points cannot be spent here", () => {
    expect(parsePoinAkun({ balance: 5, redemption: null })).toEqual({ balance: 5, redemption: null });
    expect(parsePoinAkun({ balance: 5 })).toEqual({ balance: 5, redemption: null });
  });

  test("drops anything malformed instead of trusting it", () => {
    for (const bad of [
      null,
      "x",
      {},
      { balance: "5" },
      { balance: 1.5 },
      { balance: 5, redemption: { rupiahPerPoint: 0 } },
      { balance: 5, redemption: { rupiahPerPoint: 1.5 } },
      { balance: 5, redemption: { rupiahPerPoint: 10, maxGoodsPercent: 0 } },
      { balance: 5, redemption: { rupiahPerPoint: 10, maxGoodsPercent: 101 } },
      { balance: 5, redemption: "yes" }
    ]) {
      expect(parsePoinAkun(bad)).toBeNull();
    }
  });
});

describe("bolehPakaiPoin", () => {
  test("needs a point value AND a positive balance", () => {
    const terms = { rupiahPerPoint: 100, maxGoodsPercent: null };
    expect(bolehPakaiPoin({ balance: 10, redemption: terms })).toBe(true);
    expect(bolehPakaiPoin({ balance: 0, redemption: terms })).toBe(false);
    expect(bolehPakaiPoin({ balance: -5, redemption: terms })).toBe(false);
    expect(bolehPakaiPoin({ balance: 10, redemption: null })).toBe(false);
    expect(bolehPakaiPoin(null)).toBe(false);
  });
});

describe("bacaPoinInput", () => {
  test("blank is no redemption; a positive whole number is the points", () => {
    expect(bacaPoinInput("")).toBeNull();
    expect(bacaPoinInput("   ")).toBeNull();
    expect(bacaPoinInput("250")).toBe(250);
    expect(bacaPoinInput(" 7 ")).toBe(7);
  });

  test("a fraction, a negative, zero, an exponent or text is rejected (NaN), never rounded", () => {
    for (const raw of ["1.5", "-3", "0", "00", "1e3", "abc", "10 poin", "1,000", "9999999999999"]) {
      expect(Number.isNaN(bacaPoinInput(raw) as number)).toBe(true);
    }
  });
});

describe("perkiraanDiskonPoin", () => {
  test("is points x rupiah-per-point (display only)", () => {
    expect(perkiraanDiskonPoin(250, 100)).toBe(25000);
  });
});

describe("pesanKesalahanPoin", () => {
  test("maps every CMS refusal code to Indonesian copy and is null for anything else", () => {
    for (const code of [
      "LOYALTY_REDEMPTION_UNAVAILABLE",
      "LOYALTY_REDEMPTION_REQUIRES_ACCOUNT",
      "LOYALTY_REDEMPTION_DEPOSIT_CONFLICT",
      "LOYALTY_REDEMPTION_CUSTOMER_UNAVAILABLE",
      "LOYALTY_REDEMPTION_EXCEEDS_LIMIT",
      "INSUFFICIENT_POINTS"
    ]) {
      expect(typeof pesanKesalahanPoin(code)).toBe("string");
    }
    expect(pesanKesalahanPoin("CART_CHANGED")).toBeNull();
    expect(pesanKesalahanPoin("RATE_LIMITED")).toBeNull();
  });

  test("tells the shopper the largest number that fits and their balance", () => {
    expect(
      pesanKesalahanPoin("LOYALTY_REDEMPTION_EXCEEDS_LIMIT", { reason: "cap", maxPoints: 40 })
    ).toContain("40");
    expect(pesanKesalahanPoin("INSUFFICIENT_POINTS", { balance: 12, requested: 99 })).toContain("12");
  });
});

describe("the checkout never sends more than whole points, and never a cookie", () => {
  const read = (relative: string): string =>
    readFileSync(path.resolve(import.meta.dir, "..", relative), "utf8");

  test("the order request carries { points } only - no discount, rate, total or account", () => {
    const script = read("src/scripts/checkout.ts");
    expect(script).toContain("loyaltyRedemption: { points: typedPoints }");
    expect(script).not.toMatch(/loyaltyRedemption:\s*\{[^}]*(discount|rate|rupiah|total|account)/i);
  });

  test("the points call reuses the one bearer plumbing, with no cookie and no second session shape", () => {
    const klien = read("src/lib/akun-klien.ts");
    expect(klien).toContain('"/account/loyalty?limit=1"');
    expect(klien).toContain("authHeader()");
    const permintaan = read("src/lib/toko-permintaan.ts");
    expect(permintaan).toContain('credentials: "omit"');
    const kontrak = read("src/lib/poin-kontrak.ts");
    expect(kontrak).not.toMatch(/localStorage|document\.cookie|Set-Cookie/);
  });
});
