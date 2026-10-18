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
