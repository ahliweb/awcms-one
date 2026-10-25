/**
 * `src/lib/booking-kontrak.ts` - the booking pages' pure contract (issue #386).
 * No DOM, no fetch: the status vocabulary, the countdown arithmetic and its
 * announcement thresholds, the date messages, the return-address round trip and
 * the refusal copy of `docs/booking-ux-flows.md` section 2.5.
 */
import { describe, expect, test } from "bun:test";
import {
  alasanTidakBisaBatal,
  bandingkanUang,
  barisUang,
  BOOKING_AKTIF_KEY,
  buatPathDetailReservasi,
  catatanPembayaran,
  formatPersen,
  labelPengembalian,
  parseHasilPembatalan,
  parseKodeDetail,
  parseKuotaPembatalan,
  parseRefundReservasi,
  pesanBerhasilBatal,
  pesanGalatPembatalan,
  rincianPembatalan,
  teksMenginap,
  TEKS_TANPA_KEBIJAKAN,
  uangDitahan,
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
  type KuotaPembatalan,
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

// ---------------------------------------------------------------------------
// Issue #387 - Surface B (the order view) and Surface C (cancellation and refund)
// ---------------------------------------------------------------------------

describe("order view money rows (UX 3.1, 3.3)", () => {
  const depositHeld = settlement({ total: "900000.00", deposit: "270000.00", balanceDue: "900000.00", outstanding: "900000.00" });
  const depositPaid = settlement({
    paid: "270000.00",
    settled: "270000.00",
    outstanding: "630000.00",
    balanceDue: "630000.00",
    paymentStatus: "dp_paid"
  });

  test("a deposit order not yet paid shows 'Uang muka yang harus dibayar sekarang' with the server's deposit and the whole balance", () => {
    const rows = barisUang({ status: "held", settlement: depositHeld }, rupiah);
    expect(rows.map((r) => r.key)).toEqual(["total", "uangMuka", "dibayar", "sisa"]);
    expect(rows.find((r) => r.key === "uangMuka")).toEqual({ key: "uangMuka", label: "Uang muka yang harus dibayar sekarang", value: "Rp270000.00" });
    expect(rows.find((r) => r.key === "sisa")?.value).toBe("Rp900000.00");
  });

  test("after the deposit the row reads 'Uang muka', 'Sudah dibayar' is what the ledger settled and the balance is the server's", () => {
    const rows = barisUang({ status: "confirmed", settlement: depositPaid }, rupiah);
    expect(rows.find((r) => r.key === "uangMuka")?.label).toBe("Uang muka");
    expect(rows.find((r) => r.key === "dibayar")?.value).toBe("Rp270000.00");
    expect(rows.find((r) => r.key === "sisa")).toEqual({ key: "sisa", label: "Sisa pembayaran", value: "Rp630000.00" });
  });

  test("a product with no deposit policy hides the deposit row and says 'Bayar penuh'; a paid balance reads 'Lunas'", () => {
    const rows = barisUang({ status: "held", settlement: settlement({ deposit: "900000.00" }) }, rupiah);
    expect(rows.map((r) => r.key)).toEqual(["total", "pembayaran", "dibayar", "sisa"]);
    expect(rows.find((r) => r.key === "pembayaran")?.value).toBe("Bayar penuh");
    const paid = barisUang(
      { status: "confirmed", settlement: settlement({ deposit: "900000.00", paid: "900000.00", settled: "900000.00", outstanding: "0.00", balanceDue: "0.00", paymentStatus: "paid" }) },
      rupiah
    );
    expect(paid.find((r) => r.key === "sisa")?.value).toBe("Lunas");
  });

  test("a cancelled or expired reservation owes nothing: no balance row; a returned amount gets its own row; no row is ever a security deposit", () => {
    const cancelled = barisUang(
      { status: "cancelled", settlement: settlement({ ...depositPaid, reversed: "135000.00", settled: "135000.00" }) },
      rupiah
    );
    expect(cancelled.map((r) => r.key)).toEqual(["total", "uangMuka", "dibayar", "dikembalikan"]);
    expect(barisUang({ status: "expired", settlement: depositHeld }, rupiah).some((r) => r.key === "sisa")).toBe(false);
    for (const row of [...cancelled, ...barisUang({ status: "held", settlement: depositHeld }, rupiah)]) {
      expect(`${row.label} ${row.value}`.toLowerCase()).not.toContain("jaminan");
    }
  });

  test("payment notes follow the UX 3.2 return states the view can show, and never claim confirmation for an expired hold", () => {
    const confirmed = catatanPembayaran({ status: "confirmed", orderCode: "BJM-1", settlement: depositPaid }, rupiah);
    expect(confirmed).toEqual({
      message: "Uang muka diterima. Reservasi Anda terkonfirmasi. Sisa pembayaran Rp630000.00 dibayar saat check-in atau lebih awal.",
      tone: "success"
    });
    const expired = catatanPembayaran({ status: "expired", orderCode: "BJM-1", settlement: depositHeld }, rupiah);
    expect(expired?.tone).toBe("warning");
    expect(expired?.message).toContain("Nomor pesanan: BJM-1");
    expect(expired?.message).not.toContain("terkonfirmasi");
    expect(catatanPembayaran({ status: "held", orderCode: "BJM-1", settlement: depositHeld }, rupiah)).toBeNull();
  });

  test("a cancelled reservation that still holds money is not labelled 'Lunas'", () => {
    const settled = settlement({ paid: "900000.00", settled: "900000.00", outstanding: "0.00", balanceDue: "0.00", paymentStatus: "paid" });
    expect(labelPembayaran({ status: "cancelled", settlement: settled }, rupiah).label).toBe("Dibayar, pengembalian dana mengikuti kebijakan");
    expect(labelPembayaran({ status: "cancelled", settlement: settlement({ paymentStatus: "refunded", reversed: "900000.00" }) }, rupiah).label).toBe(
      "Dikembalikan seluruhnya"
    );
  });

  test("the refund line: nothing before a cancellation, 'sedang diproses' until the ledger shows it returned, zero is plain text", () => {
    expect(labelPengembalian(null, { reversed: "0.00" }, rupiah)).toBeNull();
    expect(labelPengembalian({ finalRefund: "135000.00", adjusted: false }, { reversed: "0.00" }, rupiah)).toEqual({
      label: "Pengembalian dana Rp135000.00 sedang diproses.",
      tone: "info"
    });
    expect(labelPengembalian({ finalRefund: "135000.00", adjusted: false }, { reversed: "135000.00" }, rupiah)).toEqual({
      label: "Pengembalian dana Rp135000.00 selesai.",
      tone: "success"
    });
    expect(labelPengembalian({ finalRefund: "0.00", adjusted: false }, { reversed: "0.00" }, rupiah)?.label).toBe("Tidak ada pengembalian dana.");
    // An override by staff is acknowledged without a reason or an actor (UX 4.3).
    expect(labelPengembalian({ finalRefund: "100000.00", adjusted: true }, { reversed: "0.00" }, rupiah)?.label).toContain("Disesuaikan oleh tim kami.");
  });

  test("the refund body parses strictly; the success message is the recorded figure", () => {
    expect(parseRefundReservasi({ finalRefund: "135000.00", adjusted: true })).toEqual({ finalRefund: "135000.00", adjusted: true });
    expect(parseRefundReservasi(null)).toBeNull();
    expect(parseRefundReservasi({ finalRefund: 135000 })).toBeNull();
    expect(parseRefundReservasi({ finalRefund: "abc" })).toBeNull();
    expect(pesanBerhasilBatal("135000.00", rupiah)).toBe("Reservasi dibatalkan. Pengembalian dana Rp135000.00 sedang diproses.");
    expect(pesanBerhasilBatal("0.00", rupiah)).toBe("Reservasi dibatalkan. Tidak ada pengembalian dana.");
  });

  test("the address of a detail is a plain code, parsed back strictly", () => {
    expect(buatPathDetailReservasi("BJM-20261024-ABC")).toBe("/akun/reservasi?kode=BJM-20261024-ABC");
    expect(parseKodeDetail("?kode=BJM-20261024-ABC")).toBe("BJM-20261024-ABC");
    expect(parseKodeDetail("?kode=")).toBeNull();
    expect(parseKodeDetail("?kode=a b")).toBeNull();
    expect(parseKodeDetail("?kode=../x")).toBeNull();
    expect(parseKodeDetail("")).toBeNull();
  });

  test("stay text: dates plus the server's night count", () => {
    expect(teksMenginap("2026-10-12T07:00:00.000Z", 3)).toBe("12 Okt 2026 sampai 15 Okt 2026 (3 malam)");
    expect(teksMenginap("2026-10-12T07:00:00.000Z", null)).toBe("12 Okt 2026");
  });
});

describe("money strings are compared and display-subtracted exactly, never as floats", () => {
  test("bandingkanUang is decimal-exact and null for non-money", () => {
    expect(bandingkanUang("10.10", "10.1")).toBe(0);
    expect(bandingkanUang("0.30", "0.3")).toBe(0);
    expect(bandingkanUang("135000.00", "135000.01")).toBe(-1);
    expect(bandingkanUang("2.00", "1.99")).toBe(1);
    expect(bandingkanUang("x", "1.00")).toBeNull();
    expect(bandingkanUang(undefined, "1.00")).toBeNull();
  });

  test("uangDitahan is paid minus refund, floored at zero, and null for a malformed figure", () => {
    expect(uangDitahan("270000.00", "135000.00")).toBe("135000.00");
    expect(uangDitahan("270000.00", "270000.00")).toBe("0.00");
    expect(uangDitahan("0.10", "0.30")).toBe("0.00");
    expect(uangDitahan("0.30", "0.10")).toBe("0.20");
    expect(uangDitahan("abc", "1.00")).toBeNull();
  });

  test("percentages are the server's, trimmed for reading", () => {
    expect(formatPersen("50.00")).toBe("50");
    expect(formatPersen("100.00")).toBe("100");
    expect(formatPersen("33.50")).toBe("33,5");
    expect(formatPersen("0.00")).toBe("0");
  });
});

describe("the cancellation quote (UX 4.2): parsed strictly, shown as the server computed it", () => {
  const quote = (overrides: Partial<KuotaPembatalan> = {}): KuotaPembatalan => ({
    quotedAt: "2026-10-24T08:00:00.000Z",
    startsAt: "2026-11-03T07:00:00.000Z",
    hoursBeforeStart: 239,
    reservationStatus: "confirmed",
    policySource: "product",
    policyId: "b3870000-0000-4000-8000-000000000001",
    policyVersion: 1,
    refundBasis: "whole_stay",
    refundablePercent: "50.00",
    amountPaid: "270000.00",
    computedRefund: "135000.00",
    ...overrides
  });

  test("the OpenAPI body parses; anything the dialog must not trust is null", () => {
    expect(parseKuotaPembatalan(quote())).toEqual(quote());
    expect(parseKuotaPembatalan(null)).toBeNull();
    expect(parseKuotaPembatalan({ ...quote(), computedRefund: 135000 })).toBeNull();
    expect(parseKuotaPembatalan({ ...quote(), computedRefund: "12,5" })).toBeNull();
    expect(parseKuotaPembatalan({ ...quote(), hoursBeforeStart: 1.5 })).toBeNull();
    expect(parseKuotaPembatalan({ ...quote(), policySource: "somewhere" })).toBeNull();
    expect(parseKuotaPembatalan({ ...quote(), amountPaid: undefined })).toBeNull();
    expect(parseHasilPembatalan({ status: "cancelled", finalRefund: "135000.00" })).toEqual({ status: "cancelled", finalRefund: "135000.00" });
    expect(parseHasilPembatalan({ status: "held", finalRefund: "1.00" })).toBeNull();
    expect(parseHasilPembatalan({ status: "cancelled" })).toBeNull();
  });

  test("the dialog rows follow UX 4.2 in order and the refund is the quote's computedRefund verbatim", () => {
    const r = rincianPembatalan(quote(), rupiah);
    expect(r.baris.map((b) => b.label)).toEqual([
      "Sudah dibayar",
      "Kebijakan yang berlaku",
      "Dana yang dikembalikan",
      "Ditahan sesuai kebijakan",
      "Tujuan pengembalian"
    ]);
    expect(r.baris[0].value).toBe("Rp270000.00");
    expect(r.baris[1].value).toBe("Kebijakan yang berlaku: batal 9 hari sebelum check-in, dana kembali 50%.");
    expect(r.baris[2].value).toBe("Rp135000.00");
    expect(r.baris[3].value).toBe("Rp135000.00");
    expect(r.baris[4].value).toBe("Dikembalikan ke metode pembayaran asal");
    expect(r.labelKonfirmasi).toBe("Ya, batalkan dan ajukan pengembalian");
    expect(r.tanpaPengembalian).toBe(false);
    // The percentage is shown, never applied: a quote whose percentage disagrees with its refund still shows the refund it carries.
    expect(rincianPembatalan(quote({ refundablePercent: "99.00" }), rupiah).baris[2].value).toBe("Rp135000.00");
  });

  test("a zero refund changes the confirm button and surfaces the retained amount - a forfeit is never discovered afterwards", () => {
    const r = rincianPembatalan(quote({ refundablePercent: "0.00", computedRefund: "0.00", hoursBeforeStart: 20 }), rupiah);
    expect(r.tanpaPengembalian).toBe(true);
    expect(r.labelKonfirmasi).toBe("Ya, batalkan tanpa pengembalian");
    expect(r.ditahan).toBe("Rp270000.00");
    expect(r.baris[1].value).toBe("Kebijakan yang berlaku: batal 20 jam sebelum check-in, dana kembali 0%.");
    expect(r.baris.some((b) => b.label === "Tujuan pengembalian")).toBe(false);
  });

  test("nothing paid cancels plainly; a per-night policy says so; after arrival the window is named as such", () => {
    const none = rincianPembatalan(quote({ amountPaid: "0.00", computedRefund: "0.00" }), rupiah);
    expect(none.labelKonfirmasi).toBe("Ya, batalkan reservasi");
    expect(none.ditahan).toBeNull();
    expect(rincianPembatalan(quote({ refundBasis: "per_night" }), rupiah).baris[1].value).toContain("(dihitung per malam)");
    expect(rincianPembatalan(quote({ hoursBeforeStart: -3 }), rupiah).baris[1].value).toContain("batal setelah waktu check-in");
  });

  test("no resolved policy: the spec's sentence, no self-service path implied (UX 4.1)", () => {
    const r = rincianPembatalan(quote({ policySource: "none", policyId: null, policyVersion: null, refundablePercent: "0.00", computedRefund: "0.00" }), rupiah);
    expect(r.tanpaKebijakan).toBe(true);
    expect(r.ringkasan).toBe("Kebijakan pembatalan belum ditetapkan. Hubungi kami sebelum membatalkan.");
    expect(TEKS_TANPA_KEBIJAKAN).toBe(r.ringkasan);
  });

  test("a reservation that cannot be cancelled gets a plain-text reason instead of a button; held and confirmed get none", () => {
    expect(alasanTidakBisaBatal("held")).toBeNull();
    expect(alasanTidakBisaBatal("confirmed")).toBeNull();
    expect(alasanTidakBisaBatal("completed")).toBe("Reservasi ini sudah selesai dan tidak dapat dibatalkan.");
    for (const status of ["checked_in", "cancelled", "expired", "no_show", "rescheduled", "something_new"]) {
      expect(alasanTidakBisaBatal(status)).toMatch(/\S/);
    }
  });
});

describe("cancellation refusals map to the UX copy (409, 422, 429 and the rest)", () => {
  test("409 QUOTE_CHANGED asks for a fresh confirmation and says nothing was cancelled", () => {
    const m = pesanGalatPembatalan("QUOTE_CHANGED", 409, "batal");
    expect(m.next).toBe("tinjau-ulang");
    expect(m.message).toContain("Tidak ada yang dibatalkan");
  });

  test("409 INVALID_STATE re-reads the reservation instead of inviting a second cancel", () => {
    expect(pesanGalatPembatalan("INVALID_STATE", 409, "batal").next).toBe("muat-ulang");
    expect(pesanGalatPembatalan("INVALID_STATE", 409, "kuota").next).toBe("muat-ulang");
  });

  test("409 IDEMPOTENCY_CONFLICT reuses the booking copy and asks for a review", () => {
    expect(pesanGalatPembatalan("IDEMPOTENCY_CONFLICT", 409, "batal")).toEqual({
      message: "Permintaan berubah. Periksa rincian lalu kirim ulang.",
      next: "tinjau-ulang"
    });
  });

  test("other 409s (a feature or service account the tenant has not set up) point to the store", () => {
    expect(pesanGalatPembatalan("BOOKING_SERVICE_ACTOR_NOT_CONFIGURED", 409, "batal").next).toBe("hubungi");
    expect(pesanGalatPembatalan("FEATURE_DISABLED", 409, "batal").next).toBe("hubungi");
  });

  test("422 and 400 are 'cannot be processed' with a reload, never a raw code", () => {
    for (const [code, status] of [["VALIDATION_ERROR", 400], ["UNPROCESSABLE", 422], ["SOMETHING_NEW", 422]] as const) {
      const m = pesanGalatPembatalan(code, status, "batal");
      expect(m.message).toBe("Permintaan pembatalan tidak dapat diproses. Muat ulang halaman, lalu coba lagi.");
      expect(m.message).not.toContain(code);
    }
  });

  test("429 waits, with the server's seconds when it sent them", () => {
    expect(pesanGalatPembatalan("RATE_LIMITED", 429, "batal")).toEqual({
      message: "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
      next: "tunggu"
    });
    expect(pesanGalatPembatalan("RATE_LIMITED", 429, "batal", 30).message).toBe("Terlalu banyak percobaan. Tunggu 30 detik, lalu coba lagi.");
  });

  test("401 sends to sign-in, 404 is the neutral not-found, 403 blocked points to the store", () => {
    expect(pesanGalatPembatalan("UNAUTHENTICATED", 401, "batal")).toEqual({ message: "Sesi Anda berakhir. Masuk lagi untuk melanjutkan.", next: "masuk" });
    expect(pesanGalatPembatalan("NOT_FOUND", 404, "kuota")).toEqual({ message: "Pemesanan tidak ditemukan.", next: "muat-ulang" });
    expect(pesanGalatPembatalan("ACCOUNT_BLOCKED", 403, "batal").next).toBe("hubungi");
  });

  test("a dropped connection says the quote cannot be computed, or that the cancel result is unknown and the retry is safe", () => {
    expect(pesanGalatPembatalan("NETWORK_ERROR", 0, "kuota")).toEqual({ message: "Tidak dapat menghitung pengembalian dana. Coba lagi.", next: "coba-lagi" });
    const batal = pesanGalatPembatalan("NETWORK_ERROR", 0, "batal");
    expect(batal.next).toBe("coba-lagi");
    expect(batal.message).toContain("tidak akan diproses dua kali");
  });

  test("an unknown code is a generic retry in both phases", () => {
    expect(pesanGalatPembatalan("SOMETHING_NEW", 500, "kuota").message).toBe("Tidak dapat menghitung pengembalian dana. Coba lagi.");
    expect(pesanGalatPembatalan("SOMETHING_NEW", 500, "batal").next).toBe("coba-lagi");
  });
});
