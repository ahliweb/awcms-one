/**
 * `src/lib/afiliasi-kontrak.ts` — the referral-capture contract (issue #93,
 * S3 of #32): code shape (exactly 8 unambiguous base32 characters, lenient
 * on case), the `{code, capturedAt}` storage shape, the 30-day TTL, and the
 * `localStorage` read/write themselves (unlike `akun-kontrak.ts`/
 * `akun-sesi.ts`'s two-file split, this file combines both — see its own
 * docblock for why).
 *
 * Bun's test runtime has no `window` at all (`akun-klien.test.ts`'s own
 * docblock already notes `bun -e "typeof window"` is `"undefined"`) — this
 * file installs the same minimal in-memory `localStorage` stand-in on
 * `globalThis.window` for the duration of these tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AFILIASI_STORAGE_KEY,
  AFILIASI_TTL_MS,
  bacaKodeAfiliasi,
  isAfiliasiKedaluwarsa,
  parseAfiliasi,
  simpanKodeAfiliasi,
  validasiKodeAfiliasi,
  validateAfiliasi
} from "../src/lib/afiliasi-kontrak";

const ORIGINAL_WINDOW = (globalThis as { window?: unknown }).window;

function installWindowStub(): Map<string, string> {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      }
    }
  };
  (globalThis as { window?: unknown }).window = fakeWindow;
  return store;
}

let store: Map<string, string>;

beforeEach(() => {
  store = installWindowStub();
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = ORIGINAL_WINDOW;
});

describe("afiliasi-kontrak: constants", () => {
  test("storage key is namespaced under awcms-one: and TTL is 30 days", () => {
    expect(AFILIASI_STORAGE_KEY).toBe("awcms-one:afiliasi:v1");
    expect(AFILIASI_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe("afiliasi-kontrak: validasiKodeAfiliasi (shape and case)", () => {
  test("accepts exactly 8 unambiguous base32 characters", () => {
    expect(validasiKodeAfiliasi("BUDK2X7Z")).toBe("BUDK2X7Z");
    expect(validasiKodeAfiliasi("23456789")).toBe("23456789");
  });

  test("is lenient on case — lower/mixed case is upper-cased", () => {
    expect(validasiKodeAfiliasi("budk2x7z")).toBe("BUDK2X7Z");
    expect(validasiKodeAfiliasi("BuDk2X7z")).toBe("BUDK2X7Z");
  });

  test("trims surrounding whitespace before validating", () => {
    expect(validasiKodeAfiliasi("  BUDK2X7Z  ")).toBe("BUDK2X7Z");
  });

  test("rejects the ambiguous characters I, O, 0, 1", () => {
    expect(validasiKodeAfiliasi("BUDI2K7I")).toBeNull();
    expect(validasiKodeAfiliasi("BUDI2K7O")).toBeNull();
    expect(validasiKodeAfiliasi("BUDI2K70")).toBeNull();
    expect(validasiKodeAfiliasi("BUDI2K71")).toBeNull();
  });

  test("rejects the wrong length", () => {
    expect(validasiKodeAfiliasi("BUDI2K7")).toBeNull();
    expect(validasiKodeAfiliasi("BUDK2X7ZX")).toBeNull();
    expect(validasiKodeAfiliasi("")).toBeNull();
  });

  test("rejects punctuation/whitespace inside the code, and non-strings", () => {
    expect(validasiKodeAfiliasi("BUDI-K7X")).toBeNull();
    expect(validasiKodeAfiliasi("BUDI 2K7")).toBeNull();
    expect(validasiKodeAfiliasi(12345678)).toBeNull();
    expect(validasiKodeAfiliasi(null)).toBeNull();
    expect(validasiKodeAfiliasi(undefined)).toBeNull();
  });
});

describe("afiliasi-kontrak: validateAfiliasi / parseAfiliasi", () => {
  const VALID = { code: "BUDK2X7Z", capturedAt: "2026-09-01T00:00:00.000Z" };

  test("accepts a well-shaped record", () => {
    expect(validateAfiliasi(VALID)).toEqual(VALID);
  });

  test("normalizes a lower-case code while validating", () => {
    expect(validateAfiliasi({ code: "budk2x7z", capturedAt: "2026-09-01T00:00:00.000Z" })).toEqual(VALID);
  });

  test("rejects null/non-object, a malformed code, or a bad capturedAt", () => {
    expect(validateAfiliasi(null)).toBeNull();
    expect(validateAfiliasi("not an object")).toBeNull();
    expect(validateAfiliasi({ ...VALID, code: "SHORT" })).toBeNull();
    expect(validateAfiliasi({ ...VALID, capturedAt: "not a date" })).toBeNull();
    expect(validateAfiliasi({ ...VALID, capturedAt: undefined })).toBeNull();
  });

  test("parseAfiliasi returns null for empty/malformed JSON, the parsed record for good JSON", () => {
    expect(parseAfiliasi(null)).toBeNull();
    expect(parseAfiliasi("")).toBeNull();
    expect(parseAfiliasi("not json")).toBeNull();
    expect(parseAfiliasi(JSON.stringify(VALID))).toEqual(VALID);
  });
});

describe("afiliasi-kontrak: isAfiliasiKedaluwarsa (TTL)", () => {
  test("false before 30 days have passed, true at/after", () => {
    const afiliasi = { code: "BUDK2X7Z", capturedAt: "2026-01-01T00:00:00.000Z" };
    const capturedAtMs = new Date(afiliasi.capturedAt).getTime();

    expect(isAfiliasiKedaluwarsa(afiliasi, capturedAtMs)).toBe(false);
    expect(isAfiliasiKedaluwarsa(afiliasi, capturedAtMs + AFILIASI_TTL_MS - 1)).toBe(false);
    expect(isAfiliasiKedaluwarsa(afiliasi, capturedAtMs + AFILIASI_TTL_MS)).toBe(true);
    expect(isAfiliasiKedaluwarsa(afiliasi, capturedAtMs + AFILIASI_TTL_MS + 1)).toBe(true);
  });
});

describe("afiliasi-kontrak: simpanKodeAfiliasi / bacaKodeAfiliasi (storage + cleanup)", () => {
  test("simpanKodeAfiliasi stores a validated, upper-cased code; bacaKodeAfiliasi reads it back", () => {
    simpanKodeAfiliasi("budk2x7z", "2026-09-01T00:00:00.000Z");

    expect(store.get(AFILIASI_STORAGE_KEY)).toBe(
      JSON.stringify({ code: "BUDK2X7Z", capturedAt: "2026-09-01T00:00:00.000Z" })
    );

    const now = new Date("2026-09-02T00:00:00.000Z").getTime();
    expect(bacaKodeAfiliasi(now)).toEqual({ code: "BUDK2X7Z", capturedAt: "2026-09-01T00:00:00.000Z" });
  });

  test("simpanKodeAfiliasi silently does nothing for an invalid code", () => {
    simpanKodeAfiliasi("short");
    expect(store.has(AFILIASI_STORAGE_KEY)).toBe(false);
  });

  test("a newer valid code replaces an older one", () => {
    simpanKodeAfiliasi("budk2x7z", "2026-09-01T00:00:00.000Z");
    simpanKodeAfiliasi("wxyz2345", "2026-09-05T00:00:00.000Z");

    const now = new Date("2026-09-06T00:00:00.000Z").getTime();
    expect(bacaKodeAfiliasi(now)).toEqual({ code: "WXYZ2345", capturedAt: "2026-09-05T00:00:00.000Z" });
  });

  test("bacaKodeAfiliasi drops an expired entry and removes it from storage", () => {
    simpanKodeAfiliasi("budk2x7z", "2026-01-01T00:00:00.000Z");
    const afterTtl = new Date("2026-01-01T00:00:00.000Z").getTime() + AFILIASI_TTL_MS + 1;

    expect(bacaKodeAfiliasi(afterTtl)).toBeNull();
    expect(store.has(AFILIASI_STORAGE_KEY)).toBe(false);
  });

  test("bacaKodeAfiliasi returns null (never throws) with no window/localStorage", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(bacaKodeAfiliasi()).toBeNull();
  });

  test("bacaKodeAfiliasi returns null (never throws) when localStorage.getItem throws", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
        removeItem: () => {}
      }
    };
    expect(bacaKodeAfiliasi()).toBeNull();
  });

  test("simpanKodeAfiliasi never throws when localStorage.setItem throws", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error("full");
        },
        removeItem: () => {}
      }
    };
    expect(() => simpanKodeAfiliasi("budk2x7z")).not.toThrow();
  });

  test("bacaKodeAfiliasi returns null for malformed JSON already in storage", () => {
    store.set(AFILIASI_STORAGE_KEY, "not json");
    expect(bacaKodeAfiliasi()).toBeNull();
  });
});
