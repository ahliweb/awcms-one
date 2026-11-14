/**
 * The pure half of `/akun/privasi` (issue #529, ADR-0055): refusal reading and
 * wording, the erasure summary, the export file name and the code shape.
 */
import { describe, expect, test } from "bun:test";
import {
  KODE_PENOLAKAN,
  PESAN_KODE_SALAH,
  PESAN_PENOLAKAN,
  PESAN_PENYIMPANAN,
  bacaPenolakan,
  bacaRingkasanPenghapusan,
  kodeValid,
  namaBerkasEkspor,
  pesanGalat
} from "../src/lib/privasi-kontrak";
import { TokoApiError } from "../src/lib/toko-permintaan";

describe("refusals", () => {
  test("every server refusal code has Indonesian wording", () => {
    for (const code of KODE_PENOLAKAN) expect(PESAN_PENOLAKAN[code].length).toBeGreaterThan(10);
    expect(Object.keys(PESAN_PENOLAKAN).sort()).toEqual([...KODE_PENOLAKAN].sort());
  });

  test("bacaPenolakan reads only ERASURE_REFUSED and drops unknown codes", () => {
    const refused = new TokoApiError("m", 409, "ERASURE_REFUSED", {
      refusals: [{ code: "OPEN_BOOKING" }, { code: "nope" }, null, { code: "PENDING_REFUND" }]
    });
    expect(bacaPenolakan(refused)).toEqual(["OPEN_BOOKING", "PENDING_REFUND"]);
    expect(bacaPenolakan(new TokoApiError("m", 409, "OTHER", { refusals: [{ code: "OPEN_ORDER" }] }))).toEqual([]);
    expect(bacaPenolakan(new Error("x"))).toEqual([]);
    expect(bacaPenolakan(new TokoApiError("m", 409, "ERASURE_REFUSED"))).toEqual([]);
  });

  test("pesanGalat: one generic answer for a code failure, the refusals joined, the rate limit with its wait", () => {
    expect(pesanGalat(new TokoApiError("server detail", 400, "OTP_INVALID"))).toBe(PESAN_KODE_SALAH);
    expect(
      pesanGalat(new TokoApiError("m", 409, "ERASURE_REFUSED", { refusals: [{ code: "OPEN_ORDER" }, { code: "STORED_VALUE_BALANCE" }] }))
    ).toBe(`${PESAN_PENOLAKAN.OPEN_ORDER} ${PESAN_PENOLAKAN.STORED_VALUE_BALANCE}`);
    expect(pesanGalat(new TokoApiError("m", 429, "RATE_LIMITED", { retryAfter: 30 }))).toContain("30 detik");
    expect(pesanGalat(new TokoApiError("pesan sendiri", 500, "INTERNAL"))).toBe("pesan sendiri");
    expect(pesanGalat("bukan galat")).toBe("Terjadi kesalahan yang tidak terduga.");
  });
});

describe("the erasure summary", () => {
  test("reads the documented shape and refuses anything else", () => {
    expect(
      bacaRingkasanPenghapusan({
        erased: true,
        replayed: false,
        summary: { retained: { sections: ["orders", "documents"], orders: 3 } }
      })
    ).toEqual({ replayed: false, retainedSections: ["orders", "documents"], orders: 3 });
    expect(bacaRingkasanPenghapusan({ erased: false })).toBeNull();
    expect(bacaRingkasanPenghapusan(null)).toBeNull();
    expect(bacaRingkasanPenghapusan({ erased: true })).toEqual({ replayed: false, retainedSections: [], orders: 0 });
  });

  test("the page never claims everything is deleted", () => {
    expect(PESAN_PENYIMPANAN).toContain("tetap disimpan");
    expect(PESAN_PENYIMPANAN).not.toMatch(/semua data (anda )?(telah )?dihapus/i);
  });
});

describe("the export file and the code", () => {
  test("the file is named by a short id and the day, never by a name or a contact", () => {
    const name = namaBerkasEkspor({ customerId: "12345678-aaaa-bbbb-cccc-1234567890ab" }, new Date("2026-11-14T10:00:00Z"));
    expect(name).toBe("data-saya-12345678-2026-11-14.json");
    expect(namaBerkasEkspor({}, new Date("2026-11-14T10:00:00Z"))).toBe("data-saya-akun-2026-11-14.json");
  });

  test("a code is six digits", () => {
    expect(kodeValid("012345")).toBe(true);
    expect(kodeValid(" 012345 ")).toBe(true);
    expect(kodeValid("12345")).toBe(false);
    expect(kodeValid("abcdef")).toBe(false);
  });
});
