/**
 * `src/lib/booking-kontrak.ts` - the booking pages' pure contract (issue #386).
 * No DOM, no fetch: the status vocabulary, the countdown arithmetic and its
 * announcement thresholds, the date messages, the return-address round trip and
 * the refusal copy of `docs/booking-ux-flows.md` section 2.5.
 */
import { describe, expect, test } from "bun:test";
import {
  BOOKING_AKTIF_KEY,
  buatHoldAktif,
  buatPathPesan,
  formatSisa,
  formatTanggalPendek,
  isNol,
  labelPembayaran,
  labelStatusReservasi,
  labelZonaWaktu,
  parseHoldAktif,
  parseParamCari,
  parseParamPesan,
  pengumumanAmbang,
  periksaTanggal,
  pesanGalatBooking,
  sidikPermintaan,
  sisaDetik,
  statusEfektif,
  tanggalLokal,
  teksSisa,
  tujuanSesiGateway,
  type PermintaanReservasi,
  type RingkasanPembayaranBooking
} from "../src/lib/booking-kontrak";

const OFFERING = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";

const settlement = (overrides: Partial<RingkasanPembayaranBooking> = {}): RingkasanPembayaranBooking => ({
  total: "900000.00",
  paid: "0.00",
  reversed: "0.00",
  settled: "0.00",
  outstanding: "900000.00",
  overpaid: "0.00",
  paymentStatus: "unpaid",
  deposit: "270000.00",
  balanceDue: "900000.00",
  settledAt: null,
  ...overrides
});

const rupiah = (nilai: string) => `Rp${nilai}`;

describe("status vocabulary (UX 2.4, 3.3)", () => {
  test("every upstream state has its Indonesian label; an unknown one is a neutral generic, never the raw enum", () => {
    expect(labelStatusReservasi("held")).toEqual({ label: "Menunggu pembayaran uang muka", tone: "warning" });
    expect(labelStatusReservasi("confirmed").label).toBe("Terkonfirmasi");
    expect(labelStatusReservasi("checked_in").label).toBe("Sedang menginap");
    expect(labelStatusReservasi("completed").label).toBe("Selesai");
    expect(labelStatusReservasi("expired").label).toBe("Penahanan habis");
    expect(labelStatusReservasi("cancelled")).toEqual({ label: "Dibatalkan", tone: "danger" });
    expect(labelStatusReservasi("rescheduled").label).toBe("Dijadwalkan ulang");
    expect(labelStatusReservasi("no_show").label).toBe("Tidak hadir");
    expect(labelStatusReservasi("brand_new_state")).toEqual({ label: "Status diperbarui", tone: "neutral" });
  });

  test("payment label: awaiting, deposit paid with the server's remaining balance, paid in full", () => {
    expect(labelPembayaran({ status: "held", settlement: settlement() }, rupiah)).toEqual({
      label: "Menunggu pembayaran",
      tone: "warning"
    });
    expect(
      labelPembayaran(
        {
          status: "confirmed",
          settlement: settlement({ settled: "270000.00", paid: "270000.00", outstanding: "630000.00", balanceDue: "630000.00", paymentStatus: "dp_paid" })
        },
        rupiah
      )
    ).toEqual({ label: "Uang muka dibayar, sisa Rp630000.00", tone: "info" });
    expect(
      labelPembayaran(
        {
          status: "confirmed",
          settlement: settlement({ settled: "900000.00", paid: "900000.00", outstanding: "0.00", balanceDue: "0.00", paymentStatus: "paid" })
        },
        rupiah
      )
    ).toEqual({ label: "Lunas", tone: "success" });
    expect(labelPembayaran({ status: "expired", settlement: settlement() }, rupiah).label).toBe("Tidak ada pembayaran");
  });

  test("isNol is a string test and handles the numeric(14,2) shapes", () => {
    expect(isNol("0.00")).toBe(true);
    expect(isNol("0")).toBe(true);
    expect(isNol("")).toBe(true);
    expect(isNol(undefined)).toBe(true);
    expect(isNol("0.01")).toBe(false);
    expect(isNol("270000.00")).toBe(false);
  });

  test("which gateway session may be asked for follows the server's facts, and manual tenders never get one", () => {
    const base = { status: "held", settlement: settlement() };
    expect(tujuanSesiGateway({ ...base, paymentMethod: "gateway" })).toBe("full");
    expect(tujuanSesiGateway({ ...base, paymentMethod: "dp" })).toBe("deposit");
    expect(tujuanSesiGateway({ ...base, paymentMethod: "manual_bank" })).toBeNull();
    expect(tujuanSesiGateway({ ...base, paymentMethod: "manual_qris" })).toBeNull();
    // After the deposit the server has confirmed the reservation: the balance is what remains.
    expect(
      tujuanSesiGateway({
        status: "confirmed",
        paymentMethod: "dp",
        settlement: settlement({ settled: "270000.00", outstanding: "630000.00", balanceDue: "630000.00" })
      })
    ).toBe("balance");
    expect(
      tujuanSesiGateway({
        status: "confirmed",
        paymentMethod: "dp",
        settlement: settlement({ settled: "900000.00", outstanding: "0.00", balanceDue: "0.00" })
      })
    ).toBeNull();
    // A lapsed or cancelled reservation offers nothing.
    for (const status of ["expired", "cancelled", "no_show", "completed"]) {
      expect(tujuanSesiGateway({ status, paymentMethod: "dp", settlement: settlement() })).toBeNull();
    }
  });
});

describe("the hold countdown (UX 2.2)", () => {
  test("remaining time is the difference of the SERVER's two instants minus elapsed monotonic time - no device clock", () => {
    const expiresAt = "2026-10-18T10:15:00.000Z";
    const serverNow = "2026-10-18T10:00:00.000Z";
    expect(sisaDetik(expiresAt, serverNow, 0)).toBe(900);
    expect(sisaDetik(expiresAt, serverNow, 1_000)).toBe(899);
    expect(sisaDetik(expiresAt, serverNow, 899_500)).toBe(1);
    expect(sisaDetik(expiresAt, serverNow, 900_000)).toBe(0);
    expect(sisaDetik(expiresAt, serverNow, 2_000_000)).toBe(0);
    // A negative elapsed (a monotonic clock never goes back) cannot add time.
    expect(sisaDetik(expiresAt, serverNow, -5_000)).toBe(900);
    // Garbage in is "no time left", never NaN on screen.
    expect(sisaDetik("not-a-date", serverNow, 0)).toBe(0);
    expect(sisaDetik(expiresAt, "nope", 0)).toBe(0);
  });

  test("mm:ss, and hh:mm:ss above one hour", () => {
    expect(formatSisa(872)).toBe("14:32");
    expect(formatSisa(59)).toBe("00:59");
    expect(formatSisa(0)).toBe("00:00");
    expect(formatSisa(3600)).toBe("01:00:00");
    expect(formatSisa(3723)).toBe("01:02:03");
    expect(formatSisa(-4)).toBe("00:00");
  });

  test("the visible text gains the words 'kurang dari 1 menit' below a minute, not only a colour", () => {
    expect(teksSisa(872)).toBe("Kamar ditahan untuk Anda selama 14:32");
    expect(teksSisa(60)).toBe("Kamar ditahan untuk Anda selama 01:00");
    expect(teksSisa(59)).toContain("kurang dari 1 menit");
    expect(teksSisa(0)).toBe("Waktu penahanan habis");
  });

  test("announcements fire only at the thresholds, never per tick; the minute and expiry ones are urgent", () => {
    expect(pengumumanAmbang(null, 900, 900)).toEqual({ kind: "mulai", message: "Kamar ditahan selama 15 menit.", urgent: false });
    const fired: string[] = [];
    let previous: number | null = null;
    for (let sisa = 900; sisa >= 0; sisa -= 1) {
      const announcement = pengumumanAmbang(previous, sisa, 900);
      if (announcement) fired.push(`${announcement.kind}@${sisa}:${announcement.urgent}`);
      previous = sisa;
    }
    expect(fired).toEqual(["mulai@900:false", "lima-menit@300:false", "satu-menit@60:true", "habis@0:true"]);
    // Nothing between thresholds.
    expect(pengumumanAmbang(500, 499, 900)).toBeNull();
    // A tab that slept through a threshold still announces the one it crossed, once.
    expect(pengumumanAmbang(400, 30, 900)?.kind).toBe("satu-menit");
    expect(pengumumanAmbang(30, 0, 900)?.kind).toBe("habis");
    // A hold that is already over when first seen is announced as over.
    expect(pengumumanAmbang(null, 0, 900)?.kind).toBe("habis");
  });
});

describe("the status to show while Booking's expiry sweep has not run yet", () => {
  const base = { holdExpiresAt: "2026-10-18T10:15:00.000Z", serverNow: "2026-10-18T10:00:00.000Z", settlement: settlement() };

  test("a held row past its server-clock expiry with nothing settled reads as expired; before it, as held", () => {
    expect(statusEfektif({ ...base, status: "held" }, 0)).toBe("held");
    expect(statusEfektif({ ...base, status: "held" }, 899_000)).toBe("held");
    expect(statusEfektif({ ...base, status: "held" }, 900_000)).toBe("expired");
  });

  test("money wins and other states are never rewritten", () => {
    const paid = settlement({ settled: "270000.00", paid: "270000.00", outstanding: "630000.00" });
    expect(statusEfektif({ ...base, status: "held", settlement: paid }, 2_000_000)).toBe("held");
    for (const status of ["confirmed", "expired", "cancelled", "checked_in"]) {
      expect(statusEfektif({ ...base, status }, 2_000_000)).toBe(status);
    }
    expect(statusEfektif({ ...base, status: "held", holdExpiresAt: null }, 2_000_000)).toBe("held");
  });
});

describe("date inputs (UX 2.1, 2.5)", () => {
  test("the messages of section 2.5, each tied to the field it concerns", () => {
    const today = "2026-10-18";
    expect(periksaTanggal("2026-10-20", "2026-10-22", today)).toBeNull();
    expect(periksaTanggal("2026-10-18", "2026-10-19", today)).toBeNull();
    expect(periksaTanggal("2026-10-17", "2026-10-19", today)).toEqual({
      field: "checkInDate",
      message: "Tanggal masuk tidak boleh sebelum hari ini."
    });
    expect(periksaTanggal("2026-10-22", "2026-10-22", today)).toEqual({
      field: "checkOutDate",
      message: "Tanggal keluar harus setelah tanggal masuk."
    });
    expect(periksaTanggal("2026-10-22", "2026-10-20", today)?.field).toBe("checkOutDate");
    expect(periksaTanggal("2026-11-01", "2027-11-03", today)).toEqual({
      field: "checkOutDate",
      message: "Lama menginap maksimal 366 malam."
    });
    expect(periksaTanggal("2026-11-01", "2027-11-02", today)).toBeNull();
    expect(periksaTanggal("2026-02-30", "2026-03-02", today)?.field).toBe("checkInDate");
    expect(periksaTanggal("", "2026-03-02", today)?.field).toBe("checkInDate");
  });

  test("the local date is the device's calendar day, not the UTC one", () => {
    expect(tanggalLokal(new Date(2026, 9, 18, 0, 30))).toBe("2026-10-18");
    expect(tanggalLokal(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  test("a plain date is shown in Indonesian without a zone shift", () => {
    expect(formatTanggalPendek("2026-10-12")).toBe("12 Okt 2026");
    expect(formatTanggalPendek("2026-12-31")).toBe("31 Des 2026");
    expect(formatTanggalPendek("not-a-date")).toBe("not-a-date");
  });

  test("Indonesian zones get their short names; any other is shown as the server sent it", () => {
    expect(labelZonaWaktu("Asia/Pontianak")).toBe("WIB");
    expect(labelZonaWaktu("Asia/Makassar")).toBe("WITA");
    expect(labelZonaWaktu("Asia/Jayapura")).toBe("WIT");
    expect(labelZonaWaktu("Europe/Paris")).toBe("Europe/Paris");
  });
});

describe("refusal copy (UX 2.5): safe, Indonesian, with the next action", () => {
  test("a lost race, an expired hold, a rate limit and an expired session each map to their row", () => {
    expect(pesanGalatBooking("SLOT_UNAVAILABLE")).toEqual({
      message: "Maaf, kamar untuk tanggal ini baru saja terisi. Silakan pilih tanggal lain.",
      next: "pilih-tanggal"
    });
    expect(pesanGalatBooking("HOLD_EXPIRED")).toEqual({ message: "Waktu penahanan habis.", next: "mulai-ulang" });
    expect(pesanGalatBooking("RATE_LIMITED").next).toBe("tunggu");
    expect(pesanGalatBooking("HOLD_LIMIT_EXCEEDED").next).toBe("tunggu");
    expect(pesanGalatBooking("UNAUTHENTICATED")).toEqual({
      message: "Sesi Anda berakhir. Masuk lagi untuk melanjutkan.",
      next: "masuk"
    });
  });

  test("an unknown code is the generic row; no message ever contains a raw code or an internal word", () => {
    expect(pesanGalatBooking("SOMETHING_NEW")).toEqual({ message: "Terjadi gangguan. Coba lagi.", next: "coba-lagi" });
    for (const code of [
      "SLOT_UNAVAILABLE",
      "HOLD_EXPIRED",
      "RATE_LIMITED",
      "UNAUTHENTICATED",
      "OFFERING_NOT_LINKED",
      "CART_CHANGED",
      "NOT_FOUND",
      "IDEMPOTENCY_CONFLICT",
      "SOMETHING_NEW"
    ]) {
      const { message } = pesanGalatBooking(code);
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
      expect(message.toLowerCase()).not.toContain("tenant");
      expect(message.toLowerCase()).not.toContain("stack");
    }
  });
});

describe("the return address carries ids and dates, never an amount (UX 7)", () => {
  const param = { offeringId: OFFERING, resourceId: RESOURCE, masuk: "2026-11-01", keluar: "2026-11-03", tamu: 2 };

  test("round trip", () => {
    const path = buatPathPesan(param);
    expect(path.startsWith("/booking/pesan?")).toBe(true);
    expect(parseParamPesan(path.slice(path.indexOf("?")))).toEqual(param);
    expect(path).not.toMatch(/amount|price|total|nights|harga/i);
  });

  test("anything off is refused as a whole: bad ids, reversed or impossible dates, over 366 nights, a silly guest count", () => {
    const query = (extra: Record<string, string>) =>
      "?" + new URLSearchParams({ o: OFFERING, r: RESOURCE, in: "2026-11-01", out: "2026-11-03", n: "2", ...extra }).toString();
    expect(parseParamPesan(query({}))).not.toBeNull();
    expect(parseParamPesan(query({ o: "x" }))).toBeNull();
    expect(parseParamPesan(query({ r: "" }))).toBeNull();
    expect(parseParamPesan(query({ out: "2026-11-01" }))).toBeNull();
    expect(parseParamPesan(query({ out: "2026-10-30" }))).toBeNull();
    expect(parseParamPesan(query({ in: "2026-02-30" }))).toBeNull();
    expect(parseParamPesan(query({ out: "2027-11-03" }))).toBeNull();
    expect(parseParamPesan(query({ n: "0" }))).toBeNull();
    expect(parseParamPesan(query({ n: "-1" }))).toBeNull();
    expect(parseParamPesan(query({ n: "9999" }))).toBeNull();
    expect(parseParamPesan("")).toBeNull();
  });

  test("the search page reads the same query leniently, keeping only what is valid on its own", () => {
    expect(parseParamCari(`?o=${OFFERING}&in=2026-11-01&out=bad&n=3`)).toEqual({
      offeringId: OFFERING,
      masuk: "2026-11-01",
      tamu: 3
    });
    expect(parseParamCari("?o=nope&n=0")).toEqual({});
  });

  test("the pointer to this tab's hold is only trusted for the SAME stay", () => {
    const aktif = { kode: "BJM-20261018-0001", offeringId: OFFERING, masuk: "2026-11-01", keluar: "2026-11-03" };
    expect(parseHoldAktif(buatHoldAktif(aktif))).toEqual(aktif);
    expect(parseHoldAktif(null)).toBeNull();
    expect(parseHoldAktif("a|b")).toBeNull();
    expect(parseHoldAktif(`${buatHoldAktif(aktif)}|extra`)).toBeNull();
    expect(parseHoldAktif(buatHoldAktif({ ...aktif, kode: "x y" }))).toBeNull();
    expect(BOOKING_AKTIF_KEY).toBe("awcms-one:booking:aktif");
  });

  test("a retry of the same request keeps its fingerprint; a changed one does not", () => {
    const base: PermintaanReservasi = {
      offeringId: OFFERING,
      resourceId: RESOURCE,
      stay: { checkInDate: "2026-11-01", checkOutDate: "2026-11-03" },
      partySize: 2,
      payment: { method: "dp" },
      notes: null
    };
    expect(sidikPermintaan(base)).toBe(sidikPermintaan({ ...base }));
    expect(sidikPermintaan(base)).not.toBe(sidikPermintaan({ ...base, payment: { method: "gateway" } }));
    expect(sidikPermintaan(base)).not.toBe(sidikPermintaan({ ...base, notes: "lantai bawah" }));
    expect(sidikPermintaan(base)).not.toBe(
      sidikPermintaan({ ...base, stay: { checkInDate: "2026-11-01", checkOutDate: "2026-11-04" } })
    );
  });
});
