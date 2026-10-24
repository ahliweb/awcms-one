/**
 * The booking pages' PURE contract (issue #386, `docs/booking-ux-flows.md`
 * sections 2 and 3, ADR-0045): the response shapes of the CMS's four booking
 * reads and the hold, the status vocabulary, the countdown arithmetic, the
 * date-input messages, and the return-address round trip. No `window`, no
 * `fetch`, no clock of its own - every function takes what it needs, so
 * `tests/booking-kontrak.test.ts` exercises all of it without a DOM. The thin
 * browser halves are `toko-klien.ts` / `akun-klien.ts` (requests) and
 * `src/scripts/booking-*.ts` / `akun-reservasi.ts` (DOM).
 *
 * Issue #387 adds Surface B's order view (the deposit rows, the refund line)
 * and Surface C (the cancellation quote and its dialog copy, the refusal copy)
 * to the same contract, under the same rule.
 *
 * ## The one rule this file enforces by construction
 *
 * Nights, prices, totals, deposits and balances are NEVER computed here. They
 * arrive from the server (`KuotaBooking`, `ReservasiSaya.settlement`) as
 * `numeric(14,2)` strings and are shown as they are (`harga.ts` formats them for
 * display only). The only arithmetic in this file is on TIME - the hold
 * countdown, which is a difference of two server instants plus the elapsed time
 * on this device's monotonic clock, so a wrong device clock cannot lengthen or
 * shorten a hold (UX 2.2).
 */

// ---------------------------------------------------------------------------
// Response shapes (apps/cms openapi: CommerceStorefrontBooking*)
// ---------------------------------------------------------------------------

export type GambarBooking = { url: string; alt: string };

export type TawaranBooking = {
  offeringId: string;
  granularity: "stay" | "time";
  quantityBasis: "nights" | "booking";
  name: string;
  slug: string | null;
  image: GambarBooking | null;
  unitPrice: string;
  minNights: number | null;
  maxNights: number | null;
  minParty: number;
  maxParty: number;
  durationSeconds: number | null;
  /** The ids to probe for THIS offering: the resource(s) its link names (issue #437), else every active resource of the mode. Never another offering's. */
  resourceIds: string[];
};

/** `GET …/booking/availability` for a stay. A slot answer is not used by these pages. */
export type KetersediaanMenginap = {
  mode: "stay";
  timezone: string;
  checkInDate: string;
  checkOutDate: string;
  nights: number | null;
  available: boolean;
  freeUnits: number;
  reason?: "SLOT_UNAVAILABLE";
};

export type KuotaBooking = {
  offeringId: string;
  granularity: "stay" | "time";
  nights: number | null;
  quantity: number;
  product: { name: string; slug: string | null; image: GambarBooking | null };
  unitPrice: string;
  subtotal: string;
  tax: { active: boolean; percent: number; amount: string };
  total: string;
  deposit: { available: boolean; amount: string; balanceDue: string };
  paymentMethods: { method: string; available: boolean }[];
  canCheckout: boolean;
  quotedAt: string;
};

export type RingkasanPembayaranBooking = {
  total: string;
  paid: string;
  reversed: string;
  settled: string;
  outstanding: string;
  overpaid: string;
  paymentStatus: string;
  deposit?: string;
  balanceDue?: string;
  settledAt?: string | null;
};

/** One reservation, as `POST …/booking/reservations` (`reservation` + `settlement`) and the own list return it, normalised. */
export type ReservasiSaya = {
  serverNow: string;
  reservationId: string;
  reservationNo: string;
  orderId: string;
  orderCode: string;
  orderStatus: string;
  status: string;
  linkStatus: string;
  holdExpiresAt: string | null;
  startsAt: string;
  endsAt: string;
  settlement: RingkasanPembayaranBooking;
  productName: string;
  nights: number | null;
  paymentMethod: string;
};

export type HalamanReservasiSaya = { items: ReservasiSaya[]; nextCursor: string | null };

/** The `201`/`200` body of `POST …/booking/reservations`. */
export type ReservasiDibuat = {
  replayed: boolean;
  serverNow: string;
  orderId: string;
  orderCode: string;
  reservation: {
    id: string;
    reservationNo: string;
    status: string;
    holdExpiresAt: string | null;
    startsAt: string;
    endsAt: string;
  };
  settlement: RingkasanPembayaranBooking;
};

export type PermintaanReservasi = {
  offeringId: string;
  resourceId: string;
  stay: { checkInDate: string; checkOutDate: string };
  partySize: number;
  payment: { method: MetodeBayarBooking };
  notes: string | null;
};

export type MetodeBayarBooking = "gateway" | "dp" | "manual_bank" | "manual_qris";

// ---------------------------------------------------------------------------
// Status vocabulary (UX 2.4 and 3.3) - labels are text, the pill colour reinforces
// ---------------------------------------------------------------------------

export type NadaPil = "warning" | "success" | "info" | "neutral" | "danger";

const STATUS_RESERVASI: Record<string, { label: string; tone: NadaPil }> = {
  held: { label: "Menunggu pembayaran uang muka", tone: "warning" },
  confirmed: { label: "Terkonfirmasi", tone: "success" },
  checked_in: { label: "Sedang menginap", tone: "info" },
  completed: { label: "Selesai", tone: "neutral" },
  expired: { label: "Penahanan habis", tone: "neutral" },
  cancelled: { label: "Dibatalkan", tone: "danger" },
  rescheduled: { label: "Dijadwalkan ulang", tone: "neutral" },
  no_show: { label: "Tidak hadir", tone: "danger" }
};

/** A label for a Booking status; an unknown future value is shown as a neutral generic, never the raw enum. */
export function labelStatusReservasi(status: string): { label: string; tone: NadaPil } {
  return STATUS_RESERVASI[status] ?? { label: "Status diperbarui", tone: "neutral" };
}

/**
 * The payment-state label of a reservation (UX 3.3): derived from the server's
 * settlement strings only. `Rp X` is the server's `balanceDue`, formatted by the
 * caller, so it is passed in rather than computed.
 */
export function labelPembayaran(
  item: Pick<ReservasiSaya, "status" | "settlement">,
  formatUang: (nilai: string) => string
): { label: string; tone: NadaPil } {
  const { settlement } = item;
  const balance = settlement.balanceDue ?? settlement.outstanding;
  const terbayar = settlement.paymentStatus === "paid" || isNol(balance);

  if (settlement.paymentStatus === "refunded") return { label: "Dikembalikan seluruhnya", tone: "neutral" };
  if (settlement.paymentStatus === "partially_refunded") return { label: "Dikembalikan sebagian", tone: "neutral" };
  // A cancelled reservation that still holds money is not "paid in full": what comes back is the refund line's to say.
  if (item.status === "cancelled" && !isNol(settlement.settled)) {
    return { label: "Dibayar, pengembalian dana mengikuti kebijakan", tone: "neutral" };
  }
  if (terbayar && !isNol(settlement.settled)) return { label: "Lunas", tone: "success" };
  if (!isNol(settlement.settled)) {
    return { label: `Uang muka dibayar, sisa ${formatUang(balance)}`, tone: "info" };
  }
  if (item.status === "expired" || item.status === "cancelled") return { label: "Tidak ada pembayaran", tone: "neutral" };
  return { label: "Menunggu pembayaran", tone: "warning" };
}

/** `"0.00"`/`"0"`/empty - a string test, not arithmetic (money is never parsed into a float here). */
export function isNol(nilai: string | undefined | null): boolean {
  if (nilai === undefined || nilai === null || nilai === "") return true;
  return /^-?0+(\.0+)?$/.test(nilai);
}

/**
 * The status to SHOW for a reservation. Booking keeps a hold `held` until its
 * expiry sweep runs, so a row whose absolute expiry has passed (on the server's
 * clock, carried by `serverNow`) and that holds no money reads as expired
 * without waiting for the sweep. Money wins: a held row with anything settled
 * stays as the server says, and the server is asked again either way.
 */
export function statusEfektif(
  item: Pick<ReservasiSaya, "status" | "holdExpiresAt" | "serverNow" | "settlement">,
  sejakDiterimaMs: number
): string {
  if (
    item.status === "held" &&
    item.holdExpiresAt &&
    sisaDetik(item.holdExpiresAt, item.serverNow, sejakDiterimaMs) <= 0 &&
    isNol(item.settlement.settled)
  ) {
    return "expired";
  }
  return item.status;
}

/**
 * Which gateway session the shopper can ask for now, from the server's own
 * facts only (UX 3.2, ADR-0041 D1). A whole-total `gateway` order admits `full`
 * while nothing is settled. A deposit (`dp`) order admits `deposit` while its
 * reservation is still `held` (the server confirms a reservation exactly when
 * the deposit threshold is reached) and `balance` afterwards while anything is
 * owed. Anything else - a manual tender, a lapsed or cancelled reservation,
 * nothing owed - is `null`: no button. The server stays the authority and
 * refuses a purpose the ledger does not admit.
 */
export function tujuanSesiGateway(
  item: Pick<ReservasiSaya, "status" | "paymentMethod" | "settlement">
): "full" | "deposit" | "balance" | null {
  if (item.status !== "held" && item.status !== "confirmed") return null;
  const { settlement } = item;
  const sisa = settlement.balanceDue ?? settlement.outstanding;
  if (item.paymentMethod === "gateway") {
    return item.status === "held" && isNol(settlement.settled) ? "full" : null;
  }
  if (item.paymentMethod === "dp") {
    if (item.status === "held") return "deposit";
    return isNol(sisa) ? null : "balance";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date inputs (UX 2.1 and 2.5)
// ---------------------------------------------------------------------------

const TANGGAL_LOKAL = /^\d{4}-\d{2}-\d{2}$/;

function nomorHari(tanggal: string): number | null {
  if (!TANGGAL_LOKAL.test(tanggal)) return null;
  const ms = Date.parse(`${tanggal}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== tanggal) return null;
  return Math.round(ms / 86_400_000);
}

export const MAKS_MALAM = 366;

export type GalatTanggal = { field: "checkInDate" | "checkOutDate"; message: string };

/**
 * The client-side pre-check of a stay range, in the words of UX 2.5. It only
 * decides whether to ASK the server: it never produces a night count the page
 * shows (the night count is the server quote's). `hariIni` is the local date
 * `YYYY-MM-DD` of the caller. `null` = nothing wrong that can be known locally.
 */
export function periksaTanggal(
  masuk: string,
  keluar: string,
  hariIni: string
): GalatTanggal | null {
  const mulai = nomorHari(masuk);
  const selesai = nomorHari(keluar);
  const hari = nomorHari(hariIni);
  if (mulai === null) return { field: "checkInDate", message: "Isi tanggal masuk dengan tanggal yang valid." };
  if (selesai === null) return { field: "checkOutDate", message: "Isi tanggal keluar dengan tanggal yang valid." };
  if (hari !== null && mulai < hari) {
    return { field: "checkInDate", message: "Tanggal masuk tidak boleh sebelum hari ini." };
  }
  if (selesai <= mulai) {
    return { field: "checkOutDate", message: "Tanggal keluar harus setelah tanggal masuk." };
  }
  if (selesai - mulai > MAKS_MALAM) {
    return { field: "checkOutDate", message: `Lama menginap maksimal ${MAKS_MALAM} malam.` };
  }
  return null;
}

/** The local calendar date of `date` as `YYYY-MM-DD` (never `toISOString`, which is UTC and would be yesterday for a guest east of UTC after midnight). */
export function tanggalLokal(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** "12 Okt 2026" for a plain `YYYY-MM-DD`, in Indonesian, without a time zone shift. */
export function formatTanggalPendek(tanggal: string): string {
  const hari = nomorHari(tanggal);
  if (hari === null) return tanggal;
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(hari * 86_400_000)
  );
}

// ---------------------------------------------------------------------------
// Server refusals and failures -> copy (UX 2.5)
// ---------------------------------------------------------------------------

/** The next action a refusal calls for. */
export type TindakLanjut = "pilih-tanggal" | "coba-lagi" | "masuk" | "tunggu" | "mulai-ulang";

export type PesanGalat = { message: string; next: TindakLanjut };

/**
 * Maps a server error `code` (and HTTP status) to the copy of UX 2.5. The page
 * never shows a raw code, a stack, or whether another guest's reference exists.
 */
export function pesanGalatBooking(code: string, status = 0): PesanGalat {
  switch (code) {
    case "SLOT_UNAVAILABLE":
    case "STAY_UNAVAILABLE":
      return {
        message: "Maaf, kamar untuk tanggal ini baru saja terisi. Silakan pilih tanggal lain.",
        next: "pilih-tanggal"
      };
    case "HOLD_EXPIRED":
      return { message: "Waktu penahanan habis.", next: "mulai-ulang" };
    case "RATE_LIMITED":
    case "HOLD_LIMIT_EXCEEDED":
      return { message: "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.", next: "tunggu" };
    case "UNAUTHENTICATED":
      return { message: "Sesi Anda berakhir. Masuk lagi untuk melanjutkan.", next: "masuk" };
    case "ACCOUNT_BLOCKED":
      return { message: "Akun Anda tidak dapat melakukan pemesanan. Hubungi kami untuk bantuan.", next: "coba-lagi" };
    case "OFFERING_NOT_LINKED":
    case "OFFERING_NOT_LINKABLE":
    case "NOT_FOUND":
    case "RESOURCE_NOT_FOUND":
      return { message: "Layanan ini tidak tersedia untuk dipesan saat ini.", next: "pilih-tanggal" };
    case "CART_CHANGED":
      return { message: "Harga atau ketersediaan berubah. Periksa kembali rincian lalu coba lagi.", next: "pilih-tanggal" };
    case "PAYMENT_METHOD_UNAVAILABLE":
      return { message: "Metode pembayaran itu sedang tidak tersedia. Pilih metode lain.", next: "coba-lagi" };
    case "IDEMPOTENCY_CONFLICT":
      return { message: "Permintaan berubah. Periksa rincian lalu kirim ulang.", next: "coba-lagi" };
    case "VALIDATION_ERROR":
      return { message: "Periksa kembali isian Anda.", next: "coba-lagi" };
    default:
      return { message: "Terjadi gangguan. Coba lagi.", next: status === 0 ? "coba-lagi" : "coba-lagi" };
  }
}

// ---------------------------------------------------------------------------
// The hold countdown (UX 2.2)
// ---------------------------------------------------------------------------

/**
 * Whole seconds left on a hold. `holdExpiresAt` and `serverNow` are the SERVER's
 * two instants from the same response; `sejakDiterimaMs` is the time elapsed on
 * this device's MONOTONIC clock since that response arrived. The device's
 * wall clock is never consulted, so a skewed device clock does not matter.
 * Never negative.
 */
export function sisaDetik(holdExpiresAt: string, serverNow: string, sejakDiterimaMs: number): number {
  const kedaluwarsa = Date.parse(holdExpiresAt);
  const sekarangServer = Date.parse(serverNow);
  if (Number.isNaN(kedaluwarsa) || Number.isNaN(sekarangServer)) return 0;
  const sisaMs = kedaluwarsa - sekarangServer - Math.max(0, sejakDiterimaMs);
  return sisaMs <= 0 ? 0 : Math.ceil(sisaMs / 1000);
}

/** `mm:ss`, or `hh:mm:ss` above one hour. */
export function formatSisa(detik: number): string {
  const total = Math.max(0, Math.trunc(detik));
  const jam = Math.floor(total / 3600);
  const menit = Math.floor((total % 3600) / 60);
  const dtk = total % 60;
  const dua = (n: number) => String(n).padStart(2, "0");
  return jam > 0 ? `${dua(jam)}:${dua(menit)}:${dua(dtk)}` : `${dua(menit)}:${dua(dtk)}`;
}

export type Pengumuman = { kind: "mulai" | "lima-menit" | "satu-menit" | "habis"; message: string; urgent: boolean };

/**
 * The threshold announcements of the visually-hidden status region (WCAG
 * 4.1.3 / 2.2.1): NOT per tick. Given the previous and current remaining
 * seconds, returns the announcement that this tick crossed, if any. The
 * one-minute and expiry announcements are urgent (`role="alert"`).
 * `prev === null` is the first tick after a hold starts.
 */
export function pengumumanAmbang(prev: number | null, sisa: number, durasiAwalDetik: number): Pengumuman | null {
  if (prev === null) {
    const menit = Math.max(1, Math.round(durasiAwalDetik / 60));
    if (sisa <= 0) return { kind: "habis", message: "Waktu penahanan habis. Kamar dilepas.", urgent: true };
    return { kind: "mulai", message: `Kamar ditahan selama ${menit} menit.`, urgent: false };
  }
  if (prev > 0 && sisa <= 0) return { kind: "habis", message: "Waktu penahanan habis. Kamar dilepas.", urgent: true };
  if (prev > 60 && sisa <= 60) {
    return { kind: "satu-menit", message: "Kurang dari 1 menit lagi sebelum penahanan habis.", urgent: true };
  }
  if (prev > 300 && sisa <= 300) {
    return { kind: "lima-menit", message: "Sisa waktu penahanan 5 menit.", urgent: false };
  }
  return null;
}

/** Below a minute the visible text gains a warning style AND the words (UX 2.2) - never colour alone. */
export function teksSisa(detik: number): string {
  if (detik <= 0) return "Waktu penahanan habis";
  const dasar = `Kamar ditahan untuk Anda selama ${formatSisa(detik)}`;
  return detik < 60 ? `${dasar} (kurang dari 1 menit)` : dasar;
}

// ---------------------------------------------------------------------------
// The return address (UX 7): plain ids and dates, never an amount
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParamPesan = {
  offeringId: string;
  resourceId: string;
  masuk: string;
  keluar: string;
  tamu: number;
};

/** The query of `/booking/pesan`: `o` offering, `r` resource, `in`, `out`, `n` party size. `null` when any value is not what it must be. */
export function parseParamPesan(search: string): ParamPesan | null {
  const params = new URLSearchParams(search);
  const offeringId = params.get("o") ?? "";
  const resourceId = params.get("r") ?? "";
  const masuk = params.get("in") ?? "";
  const keluar = params.get("out") ?? "";
  const tamuMentah = params.get("n") ?? "1";
  if (!UUID.test(offeringId) || !UUID.test(resourceId)) return null;
  const mulai = nomorHari(masuk);
  const selesai = nomorHari(keluar);
  if (mulai === null || selesai === null || selesai <= mulai || selesai - mulai > MAKS_MALAM) return null;
  if (!/^\d{1,3}$/.test(tamuMentah)) return null;
  const tamu = Number.parseInt(tamuMentah, 10);
  if (tamu < 1 || tamu > 500) return null;
  return { offeringId, resourceId, masuk, keluar, tamu };
}

export type ParamCari = { offeringId?: string; masuk?: string; keluar?: string; tamu?: number };

/** The same query read leniently for `/booking` (the "start again with the same dates" return from an expired hold): each value is kept only if it is valid on its own. */
export function parseParamCari(search: string): ParamCari {
  const params = new URLSearchParams(search);
  const hasil: ParamCari = {};
  const offeringId = params.get("o") ?? "";
  if (UUID.test(offeringId)) hasil.offeringId = offeringId;
  const masuk = params.get("in") ?? "";
  const keluar = params.get("out") ?? "";
  if (nomorHari(masuk) !== null) hasil.masuk = masuk;
  if (nomorHari(keluar) !== null) hasil.keluar = keluar;
  const tamu = params.get("n") ?? "";
  if (/^\d{1,3}$/.test(tamu) && Number.parseInt(tamu, 10) >= 1) hasil.tamu = Number.parseInt(tamu, 10);
  return hasil;
}

/** "WIB" / "WITA" / "WIT" for the Indonesian IANA zones, else the zone name as the server sent it. */
export function labelZonaWaktu(zona: string): string {
  const peta: Record<string, string> = {
    "Asia/Jakarta": "WIB",
    "Asia/Pontianak": "WIB",
    "Asia/Makassar": "WITA",
    "Asia/Jayapura": "WIT"
  };
  return peta[zona] ?? zona;
}

export function buatPathPesan(param: ParamPesan): string {
  const query = new URLSearchParams({
    o: param.offeringId,
    r: param.resourceId,
    in: param.masuk,
    out: param.keluar,
    n: String(param.tamu)
  });
  return `/booking/pesan?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// The active hold pointer (sessionStorage - survives a reload, not a closed tab)
// ---------------------------------------------------------------------------

/** `sessionStorage` key: which hold THIS tab just made, for which stay - nothing else (no amount, no phone). */
export const BOOKING_AKTIF_KEY = "awcms-one:booking:aktif";

export type HoldAktif = { kode: string; offeringId: string; masuk: string; keluar: string };

/** `kode|offeringId|masuk|keluar`: a reload of the SAME stay's page recovers the hold; a different stay does not. */
export function buatHoldAktif(hold: HoldAktif): string {
  return [hold.kode, hold.offeringId, hold.masuk, hold.keluar].join("|");
}

export function parseHoldAktif(raw: string | null | undefined): HoldAktif | null {
  if (!raw) return null;
  const [kode, offeringId, masuk, keluar, ...extra] = raw.split("|");
  if (extra.length > 0 || !kode || !offeringId || !masuk || !keluar) return null;
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(kode) || !UUID.test(offeringId)) return null;
  if (nomorHari(masuk) === null || nomorHari(keluar) === null) return null;
  return { kode, offeringId, masuk, keluar };
}

/** Whether two requests are the same one: a retry reuses the Idempotency-Key, a changed request takes a fresh one. */
export function sidikPermintaan(p: PermintaanReservasi): string {
  return JSON.stringify([p.offeringId, p.resourceId, p.stay.checkInDate, p.stay.checkOutDate, p.partySize, p.payment.method, p.notes]);
}

// ---------------------------------------------------------------------------
// Surface B - the order view with the deposit state (issue #387, UX 3.1 and 3.3)
// ---------------------------------------------------------------------------

/** The recorded refund of a cancelled reservation as the shopper's view carries it: the amount and whether staff adjusted it - never the reason or the actor (UX 4.3). */
export type RefundReservasi = { finalRefund: string; adjusted: boolean };

/** `GET …/booking/reservations/{orderCode}`: the list item without the order-only fields, plus the recorded refund. */
export type DetailReservasi = Omit<ReservasiSaya, "productName" | "nights" | "paymentMethod"> & {
  refund: RefundReservasi | null;
};

const UANG = /^-?\d{1,14}(\.\d{1,2})?$/;

/** A `numeric(14,2)` decimal string as integer cents, or `null` when it is not one. Used only to COMPARE or display-subtract server figures; nothing here is sent back. */
function keSen(nilai: string | undefined | null): bigint | null {
  if (typeof nilai !== "string" || !UANG.test(nilai)) return null;
  const negatif = nilai.startsWith("-");
  const [bulat, pecahan = ""] = nilai.replace("-", "").split(".");
  const sen = BigInt(bulat) * 100n + BigInt((pecahan + "00").slice(0, 2));
  return negatif ? -sen : sen;
}

function dariSen(sen: bigint): string {
  const positif = sen < 0n ? 0n : sen;
  return `${positif / 100n}.${String(positif % 100n).padStart(2, "0")}`;
}

/** `-1 | 0 | 1`, or `null` when either side is not a money string. */
export function bandingkanUang(a: string | undefined | null, b: string | undefined | null): -1 | 0 | 1 | null {
  const x = keSen(a);
  const y = keSen(b);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * `paid - refund`, floored at zero, as a money string - the "retained" row of
 * the cancellation dialog. Both operands are the server's own quote figures and
 * the result is only displayed (UX ground rule 1); `null` when either is
 * malformed, so the row is simply left out rather than guessed.
 */
export function uangDitahan(amountPaid: string, computedRefund: string): string | null {
  const paid = keSen(amountPaid);
  const refund = keSen(computedRefund);
  if (paid === null || refund === null) return null;
  return dariSen(paid - refund);
}

export function parseRefundReservasi(raw: unknown): RefundReservasi | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { finalRefund, adjusted } = raw as { finalRefund?: unknown; adjusted?: unknown };
  if (typeof finalRefund !== "string" || keSen(finalRefund) === null) return null;
  return { finalRefund, adjusted: adjusted === true };
}

export type BarisUang = { key: "total" | "pembayaran" | "uangMuka" | "dibayar" | "sisa" | "dikembalikan"; label: string; value: string };

/**
 * The money definition list of the order view (UX 3.1): Total, the deposit row
 * (a deposit order only), what is paid, what is still owed, what was returned.
 * Every value is the server's settlement string, formatted by the caller. A
 * product with no deposit policy (`deposit` equal to the total) hides the
 * deposit row and says "Bayar penuh". No row shows a security deposit - none
 * exists in v1 (Q3) - and a lapsed or cancelled reservation owes nothing.
 */
export function barisUang(
  item: Pick<ReservasiSaya, "status" | "settlement">,
  formatUang: (nilai: string) => string
): BarisUang[] {
  const { settlement } = item;
  const baris: BarisUang[] = [{ key: "total", label: "Total", value: formatUang(settlement.total) }];
  const adaUangMuka =
    settlement.deposit !== undefined && !isNol(settlement.deposit) && bandingkanUang(settlement.deposit, settlement.total) !== 0;
  if (adaUangMuka) {
    const sebelumDibayar = isNol(settlement.settled) && item.status === "held";
    baris.push({
      key: "uangMuka",
      label: sebelumDibayar ? "Uang muka yang harus dibayar sekarang" : "Uang muka",
      value: formatUang(settlement.deposit!)
    });
  } else {
    baris.push({ key: "pembayaran", label: "Pembayaran", value: "Bayar penuh" });
  }
  baris.push({ key: "dibayar", label: "Sudah dibayar", value: formatUang(settlement.paid) });
  if (!isNol(settlement.reversed)) {
    baris.push({ key: "dikembalikan", label: "Sudah dikembalikan", value: formatUang(settlement.reversed) });
  }
  if (item.status !== "expired" && item.status !== "cancelled") {
    const sisa = settlement.balanceDue ?? settlement.outstanding;
    baris.push({ key: "sisa", label: "Sisa pembayaran", value: isNol(sisa) ? "Lunas" : formatUang(sisa) });
  }
  return baris;
}

/**
 * The refund line of a cancelled reservation (UX 4.2 Success): the recorded
 * figure, and whether the ledger already shows it returned. "Processing" is the
 * honest default - a refund that cannot settle automatically is never an error
 * that invites a second cancellation. `null` before any cancellation.
 */
export function labelPengembalian(
  refund: RefundReservasi | null,
  settlement: Pick<RingkasanPembayaranBooking, "reversed">,
  formatUang: (nilai: string) => string
): { label: string; tone: NadaPil } | null {
  if (!refund) return null;
  const catatan = refund.adjusted ? " Disesuaikan oleh tim kami." : "";
  if (isNol(refund.finalRefund)) return { label: `Tidak ada pengembalian dana.${catatan}`, tone: "neutral" };
  const selesai = bandingkanUang(settlement.reversed, refund.finalRefund);
  if (selesai !== null && selesai >= 0) {
    return { label: `Pengembalian dana ${formatUang(refund.finalRefund)} selesai.${catatan}`, tone: "success" };
  }
  return { label: `Pengembalian dana ${formatUang(refund.finalRefund)} sedang diproses.${catatan}`, tone: "info" };
}

/** The status line announced when the cancel call answers (UX 4.2 Success). */
export function pesanBerhasilBatal(finalRefund: string, formatUang: (nilai: string) => string): string {
  return isNol(finalRefund)
    ? "Reservasi dibatalkan. Tidak ada pengembalian dana."
    : `Reservasi dibatalkan. Pengembalian dana ${formatUang(finalRefund)} sedang diproses.`;
}

// ---------------------------------------------------------------------------
// Surface C - cancellation and refund (issue #387, UX 4)
// ---------------------------------------------------------------------------

/** `GET …/booking/reservations/{orderCode}/cancellation-quote` (apps/cms openapi `CommerceBookingCancellationQuote`). Every figure is the server's. */
export type KuotaPembatalan = {
  quotedAt: string;
  startsAt: string;
  hoursBeforeStart: number;
  reservationStatus: string;
  policySource: "product" | "tenant_default" | "none";
  policyId: string | null;
  policyVersion: number | null;
  refundBasis: "whole_stay" | "per_night";
  refundablePercent: string;
  amountPaid: string;
  computedRefund: string;
};

/** The `200` body of `POST …/cancel`: the status and the recorded refund, nothing else. */
export type HasilPembatalan = { status: "cancelled"; finalRefund: string };

const SUMBER_KEBIJAKAN = new Set(["product", "tenant_default", "none"]);

/** Validates the quote body; `null` for anything the dialog must not trust (it then shows the error state, never a guessed figure). */
export function parseKuotaPembatalan(raw: unknown): KuotaPembatalan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.amountPaid !== "string" || keSen(r.amountPaid) === null) return null;
  if (typeof r.computedRefund !== "string" || keSen(r.computedRefund) === null) return null;
  if (typeof r.hoursBeforeStart !== "number" || !Number.isInteger(r.hoursBeforeStart)) return null;
  if (typeof r.policySource !== "string" || !SUMBER_KEBIJAKAN.has(r.policySource)) return null;
  if (typeof r.refundablePercent !== "string") return null;
  return {
    quotedAt: typeof r.quotedAt === "string" ? r.quotedAt : "",
    startsAt: typeof r.startsAt === "string" ? r.startsAt : "",
    hoursBeforeStart: r.hoursBeforeStart,
    reservationStatus: typeof r.reservationStatus === "string" ? r.reservationStatus : "",
    policySource: r.policySource as KuotaPembatalan["policySource"],
    policyId: typeof r.policyId === "string" ? r.policyId : null,
    policyVersion: typeof r.policyVersion === "number" ? r.policyVersion : null,
    refundBasis: r.refundBasis === "per_night" ? "per_night" : "whole_stay",
    refundablePercent: r.refundablePercent,
    amountPaid: r.amountPaid,
    computedRefund: r.computedRefund
  };
}

export function parseHasilPembatalan(raw: unknown): HasilPembatalan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { status, finalRefund } = raw as { status?: unknown; finalRefund?: unknown };
  if (status !== "cancelled" || typeof finalRefund !== "string" || keSen(finalRefund) === null) return null;
  return { status: "cancelled", finalRefund };
}

/**
 * Why a reservation cannot be cancelled, as plain text for the place the
 * button would be (UX 4.2 Empty: the reason replaces the button, it does not
 * just hide it). `null` = the shopper may ask for a quote; the SERVER still
 * decides (`INVALID_STATE`).
 */
export function alasanTidakBisaBatal(status: string): string | null {
  switch (status) {
    case "held":
    case "confirmed":
      return null;
    case "completed":
      return "Reservasi ini sudah selesai dan tidak dapat dibatalkan.";
    case "checked_in":
      return "Anda sedang menginap, jadi reservasi ini tidak dapat dibatalkan. Hubungi kami jika perlu bantuan.";
    case "cancelled":
      return "Reservasi ini sudah dibatalkan.";
    case "expired":
      return "Penahanan reservasi ini sudah habis, jadi tidak ada yang perlu dibatalkan.";
    case "no_show":
      return "Reservasi ini ditandai tidak hadir dan tidak dapat dibatalkan.";
    case "rescheduled":
      return "Reservasi ini sudah dijadwalkan ulang dan tidak dapat dibatalkan dari halaman ini.";
    default:
      return "Reservasi ini tidak dapat dibatalkan saat ini. Hubungi kami untuk bantuan.";
  }
}

/** `"50.00"` -> `"50"`, `"33.50"` -> `"33,5"`: the server's percentage, trimmed for reading (display only). */
export function formatPersen(persen: string): string {
  const [bulat, pecahan = ""] = persen.split(".");
  const sisa = pecahan.replace(/0+$/, "");
  return sisa ? `${bulat},${sisa}` : bulat;
}

function teksJarak(jam: number): string {
  if (jam < 0) return "setelah waktu check-in";
  if (jam < 48) return `${jam} jam sebelum check-in`;
  return `${Math.floor(jam / 24)} hari sebelum check-in`;
}

export type RincianPembatalan = {
  /** The rows of the dialog's definition list, in the order of UX 4.2. */
  baris: { label: string; value: string }[];
  /** Whole-quote refund is zero: the confirm button changes and the retained amount shows in a warning pill (UX 4.2). */
  tanpaPengembalian: boolean;
  /** `none`: no policy resolved - the dialog explains and offers no self-service refund path (UX 4.1). */
  tanpaKebijakan: boolean;
  /** What is retained, as a formatted amount, when any is; shown in the warning pill. */
  ditahan: string | null;
  labelKonfirmasi: string;
  /** The text for the dialog's accessible description: the three figures in a sentence. */
  ringkasan: string;
};

export const TEKS_TANPA_KEBIJAKAN = "Kebijakan pembatalan belum ditetapkan. Hubungi kami sebelum membatalkan.";

/**
 * The cancellation dialog's content from the server quote (UX 4.2). It formats
 * and orders the quote's figures and builds sentences from them; the refund is
 * the quote's `computedRefund` verbatim, never recomputed from the percentage.
 */
export function rincianPembatalan(quote: KuotaPembatalan, formatUang: (nilai: string) => string): RincianPembatalan {
  const tanpaKebijakan = quote.policySource === "none";
  const adaDibayar = !isNol(quote.amountPaid);
  const tanpaPengembalian = isNol(quote.computedRefund);
  const sisaSen = uangDitahan(quote.amountPaid, quote.computedRefund);
  const ditahan = sisaSen !== null && !isNol(sisaSen) ? formatUang(sisaSen) : null;

  const kebijakan = tanpaKebijakan
    ? "Belum ditetapkan"
    : `Kebijakan yang berlaku: batal ${teksJarak(quote.hoursBeforeStart)}, dana kembali ${formatPersen(quote.refundablePercent)}%${
        quote.refundBasis === "per_night" ? " (dihitung per malam)" : ""
      }.`;

  const baris: RincianPembatalan["baris"] = [
    { label: "Sudah dibayar", value: formatUang(quote.amountPaid) },
    { label: "Kebijakan yang berlaku", value: kebijakan },
    { label: "Dana yang dikembalikan", value: formatUang(quote.computedRefund) }
  ];
  if (ditahan) baris.push({ label: "Ditahan sesuai kebijakan", value: ditahan });
  if (!tanpaPengembalian) {
    baris.push({ label: "Tujuan pengembalian", value: "Dikembalikan ke metode pembayaran asal" });
  }

  const labelKonfirmasi = !adaDibayar
    ? "Ya, batalkan reservasi"
    : tanpaPengembalian
      ? "Ya, batalkan tanpa pengembalian"
      : "Ya, batalkan dan ajukan pengembalian";

  const ringkasan = tanpaKebijakan
    ? TEKS_TANPA_KEBIJAKAN
    : `Sudah dibayar ${formatUang(quote.amountPaid)}. Dana yang dikembalikan ${formatUang(quote.computedRefund)}.${
        ditahan ? ` Ditahan sesuai kebijakan ${ditahan}.` : ""
      }`;

  return { baris, tanpaPengembalian, tanpaKebijakan, ditahan, labelKonfirmasi, ringkasan };
}

/** What the cancellation dialog does after a refusal. */
export type TindakGalatBatal =
  /** Re-fetch the quote and show the new figure for a fresh confirmation (nothing was cancelled). */
  | "tinjau-ulang"
  /** Offer "Coba lagi" in the dialog. */
  | "coba-lagi"
  /** Wait; the confirm button stays available after a pause. */
  | "tunggu"
  /** The session is gone: close the dialog and show the sign-in prompt. */
  | "masuk"
  /** The reservation moved on: close the dialog and re-read it from the server. */
  | "muat-ulang"
  /** Nothing the page can do: point to the store. */
  | "hubungi";

export type PesanGalatBatal = { message: string; next: TindakGalatBatal };

/**
 * Maps a refusal of the quote or the cancel call to the copy of UX 2.5 / 4.2.
 * `fase` says which call failed: a dropped connection on the quote is
 * "cannot compute", on the cancel it is "result unknown, retry is safe" (the
 * Idempotency-Key makes the same request replay, C-10). Status `422` is read
 * like `400 VALIDATION_ERROR`. The page never shows a raw code.
 */
export function pesanGalatPembatalan(
  code: string,
  status: number,
  fase: "kuota" | "batal",
  retryAfterDetik: number | null = null
): PesanGalatBatal {
  if (code === "NETWORK_ERROR" || code === "INVALID_RESPONSE" || (status === 0 && code === "")) {
    return fase === "kuota"
      ? { message: "Tidak dapat menghitung pengembalian dana. Coba lagi.", next: "coba-lagi" }
      : {
          message:
            "Koneksi terputus, hasil pembatalan belum diketahui. Coba lagi: permintaan yang sama tidak akan diproses dua kali.",
          next: "coba-lagi"
        };
  }
  switch (code) {
    case "UNAUTHENTICATED":
      return { message: "Sesi Anda berakhir. Masuk lagi untuk melanjutkan.", next: "masuk" };
    case "NOT_FOUND":
    case "RESOURCE_NOT_FOUND":
    case "RESERVATION_NOT_FOUND":
      return { message: "Pemesanan tidak ditemukan.", next: "muat-ulang" };
    case "INVALID_STATE":
      return {
        message: "Reservasi ini tidak dapat dibatalkan lagi. Status terbaru ditampilkan di halaman.",
        next: "muat-ulang"
      };
    case "QUOTE_CHANGED":
      return {
        message: "Jumlah pengembalian dana berubah. Tidak ada yang dibatalkan. Periksa jumlah yang baru, lalu konfirmasi lagi.",
        next: "tinjau-ulang"
      };
    case "IDEMPOTENCY_CONFLICT":
      return { message: "Permintaan berubah. Periksa rincian lalu kirim ulang.", next: "tinjau-ulang" };
    case "RATE_LIMITED":
    case "HOLD_LIMIT_EXCEEDED":
      return {
        message:
          retryAfterDetik !== null && retryAfterDetik > 0
            ? `Terlalu banyak percobaan. Tunggu ${retryAfterDetik} detik, lalu coba lagi.`
            : "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
        next: "tunggu"
      };
    case "ACCOUNT_BLOCKED":
      return { message: "Akun Anda tidak dapat melakukan pembatalan. Hubungi kami untuk bantuan.", next: "hubungi" };
    case "VALIDATION_ERROR":
    case "IDEMPOTENCY_REQUIRED":
      return { message: "Permintaan pembatalan tidak dapat diproses. Muat ulang halaman, lalu coba lagi.", next: "coba-lagi" };
    case "FEATURE_DISABLED":
    case "BOOKING_SERVICE_ACTOR_NOT_CONFIGURED":
      return { message: "Pembatalan online belum dapat diproses saat ini. Hubungi kami untuk bantuan.", next: "hubungi" };
    default:
      if (status === 422) {
        return { message: "Permintaan pembatalan tidak dapat diproses. Muat ulang halaman, lalu coba lagi.", next: "coba-lagi" };
      }
      return fase === "kuota"
        ? { message: "Tidak dapat menghitung pengembalian dana. Coba lagi.", next: "coba-lagi" }
        : { message: "Pembatalan belum berhasil. Tidak ada yang dianggap dibatalkan. Coba lagi atau hubungi kami.", next: "coba-lagi" };
  }
}

/** The return address of the reservation detail: `/akun/reservasi?kode=`. Plain code, never an amount; a shopper who is not its owner gets the neutral not-found (C-02). */
export function parseKodeDetail(search: string): string | null {
  const kode = new URLSearchParams(search).get("kode")?.trim() ?? "";
  return /^[A-Za-z0-9._-]{3,64}$/.test(kode) ? kode : null;
}

/** The note under the money rows that tells the shopper what the server's state means (UX 3.2 return states, as far as the reservation view can show them). `null` = nothing to add. */
export function catatanPembayaran(
  item: Pick<ReservasiSaya, "status" | "orderCode" | "settlement">,
  formatUang: (nilai: string) => string
): { message: string; tone: NadaPil } | null {
  const sisa = item.settlement.balanceDue ?? item.settlement.outstanding;
  if (item.status === "confirmed" && !isNol(item.settlement.settled) && !isNol(sisa)) {
    return {
      message: `Uang muka diterima. Reservasi Anda terkonfirmasi. Sisa pembayaran ${formatUang(sisa)} dibayar saat check-in atau lebih awal.`,
      tone: "success"
    };
  }
  if (item.status === "expired") {
    return {
      message: `Waktu penahanan habis sebelum pembayaran kami terima. Jika Anda sudah membayar, tim kami akan menghubungi Anda untuk pengembalian dana atau penjadwalan ulang. Nomor pesanan: ${item.orderCode}`,
      tone: "warning"
    };
  }
  return null;
}

/** "12 Okt 2026 sampai 14 Okt 2026 (2 malam)": the stay's dates; the end is the start plus the SERVER's night count (an order line's quantity), never a count made here. */
export function teksMenginap(startsAt: string, nights: number | null): string {
  const masuk = startsAt.slice(0, 10);
  if (nights === null) return formatTanggalPendek(masuk);
  const hari = nomorHari(masuk);
  if (hari === null) return formatTanggalPendek(masuk);
  const keluar = new Date((hari + nights) * 86_400_000).toISOString().slice(0, 10);
  return `${formatTanggalPendek(masuk)} sampai ${formatTanggalPendek(keluar)} (${nights} malam)`;
}

/** The address of one reservation's detail: the SAME static page as the list (`/akun/reservasi`) with the order code in the query, as `/akun/pesanan?kode=` does for orders. No route of its own, so no new page to register per profile. */
export function buatPathDetailReservasi(orderCode: string): string {
  return `/akun/reservasi?kode=${encodeURIComponent(orderCode)}`;
}
