/**
 * `src/lib/akun-kontrak.ts` — the pure customer-session contract (issue #88).
 * Mirrors `tests/wishlist-kontrak.test.ts`'s own shape: validate/parse/expiry,
 * no DOM, no `localStorage`.
 */
import { describe, expect, test } from "bun:test";
import {
  AKUN_EVENT_NAME,
  AKUN_STORAGE_KEY,
  isSesiKedaluwarsa,
  parseSesi,
  validateAkun,
  validateSesi,
  type SesiAkun
} from "../src/lib/akun-kontrak";

const AKUN_VALID = {
  id: "acc-1",
  name: "Budi Santoso",
  email: "budi@example.test",
  phone: "+6281234567890",
  level: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  historyFrom: "2026-01-01T00:00:00.000Z"
};

const SESI_VALID: SesiAkun = {
  token: "cs_stub_1",
  expiresAt: "2026-10-18T00:00:00.000Z",
  account: AKUN_VALID
};

describe("akun-kontrak: constants", () => {
  test("storage key and event name are namespaced under awcms-one:", () => {
    expect(AKUN_STORAGE_KEY).toBe("awcms-one:akun:v1");
    expect(AKUN_EVENT_NAME).toBe("akun:berubah");
  });
});

describe("akun-kontrak: validateAkun", () => {
  test("accepts a well-shaped account", () => {
    expect(validateAkun(AKUN_VALID)).toEqual(AKUN_VALID);
  });

  test("rejects null/non-object/missing fields/wrong types", () => {
    expect(validateAkun(null)).toBeNull();
    expect(validateAkun("not an object")).toBeNull();
    expect(validateAkun({ ...AKUN_VALID, id: "" })).toBeNull();
    expect(validateAkun({ ...AKUN_VALID, name: undefined })).toBeNull();
    expect(validateAkun({ ...AKUN_VALID, level: "1" })).toBeNull();
    expect(validateAkun({ ...AKUN_VALID, createdAt: "not a date" })).toBeNull();
    expect(validateAkun({ ...AKUN_VALID, historyFrom: 123 })).toBeNull();
  });
});

describe("akun-kontrak: validateSesi / parseSesi", () => {
  test("accepts a well-shaped session", () => {
    expect(validateSesi(SESI_VALID)).toEqual(SESI_VALID);
  });

  test("rejects a session with a malformed account, missing token, or bad expiresAt", () => {
    expect(validateSesi({ ...SESI_VALID, account: { ...AKUN_VALID, id: "" } })).toBeNull();
    expect(validateSesi({ ...SESI_VALID, token: "" })).toBeNull();
    expect(validateSesi({ ...SESI_VALID, expiresAt: "not a date" })).toBeNull();
    expect(validateSesi(null)).toBeNull();
  });

  test("parseSesi returns null for empty/malformed JSON, the parsed session for good JSON", () => {
    expect(parseSesi(null)).toBeNull();
    expect(parseSesi("")).toBeNull();
    expect(parseSesi("not json")).toBeNull();
    expect(parseSesi(JSON.stringify(SESI_VALID))).toEqual(SESI_VALID);
  });
});

describe("akun-kontrak: isSesiKedaluwarsa", () => {
  test("false before expiresAt, true at/after it", () => {
    const sesi: SesiAkun = { ...SESI_VALID, expiresAt: "2026-01-15T00:00:00.000Z" };
    const before = new Date("2026-01-14T23:59:59.000Z").getTime();
    const atExpiry = new Date("2026-01-15T00:00:00.000Z").getTime();
    const after = new Date("2026-01-16T00:00:00.000Z").getTime();

    expect(isSesiKedaluwarsa(sesi, before)).toBe(false);
    expect(isSesiKedaluwarsa(sesi, atExpiry)).toBe(true);
    expect(isSesiKedaluwarsa(sesi, after)).toBe(true);
  });
});
