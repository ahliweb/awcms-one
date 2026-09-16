import { describe, expect, test } from "bun:test";
import {
  formatTanggalPanjangWIB,
  formatWaktuWIB,
  formatTanggalWaktuWIB,
  toDatetimeAttr,
  pernahDiperbaruiSetelahTerbit,
  formatBulanArsipWIB,
  arsipBulanWIB
} from "../src/lib/tanggal";

describe("lib/tanggal: WIB formatting (issue #28)", () => {
  test("formatTanggalPanjangWIB renders a full Indonesian date, converted to Asia/Jakarta", () => {
    // 2026-01-01T17:30:00Z is 2026-01-02T00:30 WIB (UTC+7) — the calendar
    // DAY itself must shift, proving this is a real timezone conversion,
    // not a UTC slice with a label pasted on.
    expect(formatTanggalPanjangWIB("2026-01-01T17:30:00.000Z")).toBe("2 Januari 2026");
  });

  test("formatWaktuWIB renders 24-hour time suffixed with WIB", () => {
    expect(formatWaktuWIB("2026-01-01T07:05:00.000Z")).toBe("14.05 WIB");
  });

  test("formatTanggalWaktuWIB combines both, comma-separated", () => {
    expect(formatTanggalWaktuWIB("2026-01-01T07:05:00.000Z")).toBe("1 Januari 2026, 14.05 WIB");
  });

  test("toDatetimeAttr is a full-precision ISO string, independent of WIB display", () => {
    expect(toDatetimeAttr("2026-01-01T07:05:00.000Z")).toBe("2026-01-01T07:05:00.000Z");
  });

  test("an unparseable date throws rather than silently printing 'Invalid Date'", () => {
    expect(() => formatTanggalPanjangWIB("not-a-date")).toThrow();
    expect(() => toDatetimeAttr("not-a-date")).toThrow();
  });
});

describe("lib/tanggal: pernahDiperbaruiSetelahTerbit", () => {
  test("true when updatedAt is strictly after publishedAt", () => {
    expect(pernahDiperbaruiSetelahTerbit("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z")).toBe(true);
  });

  test("false when they are identical — awcms stamps both together on publish", () => {
    expect(pernahDiperbaruiSetelahTerbit("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(false);
  });

  test("false when publishedAt is null", () => {
    expect(pernahDiperbaruiSetelahTerbit(null, "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("lib/tanggal: monthly archive helpers", () => {
  test("formatBulanArsipWIB renders 'Month Year' in Indonesian", () => {
    expect(formatBulanArsipWIB("2026", "09")).toBe("September 2026");
  });

  test("formatBulanArsipWIB rejects an out-of-range month", () => {
    expect(() => formatBulanArsipWIB("2026", "13")).toThrow();
    expect(() => formatBulanArsipWIB("2026", "00")).toThrow();
  });

  test("arsipBulanWIB derives the WIB calendar month, shifting across a UTC day/month boundary", () => {
    // 2026-01-31T18:00:00Z is 2026-02-01T01:00 WIB — the MONTH changes.
    expect(arsipBulanWIB("2026-01-31T18:00:00.000Z")).toEqual({ yyyy: "2026", mm: "02" });
  });
});
