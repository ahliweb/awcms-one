/**
 * `src/lib/kunci-idempotensi.ts` (issue #513, decision 3): the key's shape, its
 * stability across retries of one attempt, its rotation after a definitive
 * answer, and the header that carries it.
 */
import { describe, expect, test } from "bun:test";
import {
  buatKunciBaru,
  buatPengelolaKunci,
  galatKonflikKunci,
  jawabanFinal,
  kunciHeader,
  kunciValid,
  NAMA_HEADER_KUNCI,
  POLA_KUNCI_IDEMPOTENSI
} from "../src/lib/kunci-idempotensi";
import { TokoApiError } from "../src/lib/toko-permintaan";

describe("the key", () => {
  test("crypto.randomUUID() output matches the contract shape, and keys differ", () => {
    const a = buatKunciBaru();
    const b = buatKunciBaru();
    expect(a).toMatch(POLA_KUNCI_IDEMPOTENSI);
    expect(a).not.toBe(b);
  });

  test("the fallback (no randomUUID) is 22 base64url characters and valid", () => {
    const kripto = {
      getRandomValues: <T extends ArrayBufferView | null>(isi: T): T => {
        const bita = isi as unknown as Uint8Array;
        for (let i = 0; i < bita.length; i += 1) bita[i] = 250 - i;
        return isi;
      }
    } as unknown as Pick<Crypto, "randomUUID" | "getRandomValues">;
    const kunci = buatKunciBaru(kripto);
    expect(kunci).toHaveLength(22);
    expect(kunciValid(kunci)).toBe(true);
  });

  test("no random source at all is a loud error, never a guessable key", () => {
    expect(() => buatKunciBaru({} as unknown as Crypto)).toThrow(/acak/);
  });

  test("kunciValid enforces [A-Za-z0-9_-]{16,128}", () => {
    expect(kunciValid("a".repeat(16))).toBe(true);
    expect(kunciValid("a".repeat(128))).toBe(true);
    expect(kunciValid("a".repeat(15))).toBe(false);
    expect(kunciValid("a".repeat(129))).toBe(false);
    expect(kunciValid("abcdefghijklmnop qrs")).toBe(false);
    expect(kunciValid("abcdefghijklmnopqrs.")).toBe(false);
    expect(kunciValid("")).toBe(false);
  });
});

describe("kunciHeader", () => {
  test("no key, no header (safe for a server that ignores it, and for callers that never opt in)", () => {
    expect(kunciHeader()).toEqual({});
    expect(kunciHeader(undefined)).toEqual({});
  });

  test("a valid key becomes the Idempotency-Key header", () => {
    const kunci = buatKunciBaru();
    expect(kunciHeader(kunci)).toEqual({ [NAMA_HEADER_KUNCI]: kunci });
    expect(NAMA_HEADER_KUNCI).toBe("Idempotency-Key");
  });

  test("a malformed key never reaches the network", () => {
    expect(() => kunciHeader("pendek")).toThrow(TypeError);
  });
});

describe("jawabanFinal and the conflict code", () => {
  const galat = (status: number, code: string) => new TokoApiError("x", status, code);

  test("an HTTP answer below 500 is final", () => {
    for (const status of [200, 201, 400, 401, 404, 409, 422, 429]) expect(jawabanFinal(galat(status, "X"))).toBe(true);
  });

  test("no response, a 5xx, a timeout and a non-error are ambiguous", () => {
    expect(jawabanFinal(galat(0, "NETWORK_ERROR"))).toBe(false);
    expect(jawabanFinal(galat(500, "INTERNAL"))).toBe(false);
    expect(jawabanFinal(galat(503, "UNAVAILABLE"))).toBe(false);
    expect(jawabanFinal(galat(408, "TIMEOUT"))).toBe(false);
    expect(jawabanFinal(new Error("x"))).toBe(false);
    expect(jawabanFinal(null)).toBe(false);
  });

  test("galatKonflikKunci recognises the 409 IDEMPOTENCY_CONFLICT code only", () => {
    expect(galatKonflikKunci(galat(409, "IDEMPOTENCY_CONFLICT"))).toBe(true);
    expect(galatKonflikKunci(galat(409, "PHONE_ALREADY_REGISTERED"))).toBe(false);
    expect(galatKonflikKunci(new Error("x"))).toBe(false);
  });
});

describe("buatPengelolaKunci", () => {
  function pengelola() {
    let n = 0;
    return buatPengelolaKunci(() => `kunci-percobaan-${(n += 1).toString().padStart(4, "0")}`);
  }

  test("stable across retries of the same attempt", () => {
    const p = pengelola();
    const pertama = p.untuk("badan-A");
    expect(p.untuk("badan-A")).toBe(pertama);
    expect(p.untuk("badan-A")).toBe(pertama);
  });

  test("an edited request is a different attempt and takes a fresh key", () => {
    const p = pengelola();
    const a = p.untuk("badan-A");
    const b = p.untuk("badan-B");
    expect(b).not.toBe(a);
    // Going back is a NEW attempt too: the old key is not resurrected.
    expect(p.untuk("badan-A")).not.toBe(a);
  });

  test("rotates after a success", () => {
    const p = pengelola();
    const a = p.untuk("badan-A");
    p.sesudahBerhasil();
    expect(p.ada()).toBe(false);
    expect(p.untuk("badan-A")).not.toBe(a);
  });

  test("rotates after a definitive error answer, keeps the key after an ambiguous one", () => {
    const p = pengelola();
    const a = p.untuk("badan-A");
    p.sesudahGalat(new TokoApiError("jaringan", 0, "NETWORK_ERROR"));
    expect(p.untuk("badan-A")).toBe(a);
    p.sesudahGalat(new TokoApiError("server", 502, "BAD_GATEWAY"));
    expect(p.untuk("badan-A")).toBe(a);
    p.sesudahGalat(new TokoApiError("kode salah", 401, "OTP_INVALID"));
    expect(p.untuk("badan-A")).not.toBe(a);
  });

  test("the default generator produces contract-shaped keys", () => {
    const p = buatPengelolaKunci();
    expect(p.untuk("x")).toMatch(POLA_KUNCI_IDEMPOTENSI);
  });
});
