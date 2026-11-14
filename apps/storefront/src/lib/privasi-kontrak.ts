/**
 * The pure half of the shopper's data-subject page `/akun/privasi` (issue #529,
 * ADR-0055): what an erasure refusal and a summary look like on the wire, the
 * Indonesian wording the shopper reads, and the file name of the export. No
 * `window`, no network: `src/scripts/akun-privasi.ts` is the browser half and
 * `src/lib/akun-klien.ts` the only caller of the API.
 *
 * ## What the page promises, and what this file keeps it from over-claiming
 *
 * - An export is a FILE built from the response and downloaded; it is never
 *   kept by the store or by the page (`namaBerkasEkspor` names it by the first
 *   eight characters of the customer id and the day, never by a name or contact).
 * - An erasure is described as what it is: personal data is deleted or
 *   anonymised, and orders, payments, documents and ledgers are KEPT for
 *   bookkeeping and no longer identify the shopper (`PESAN_PENYIMPANAN`). The
 *   page never says "everything is deleted".
 */
import { TokoApiError } from "./toko-permintaan";

export const KODE_PENOLAKAN = [
  "ALREADY_ERASED",
  "NOT_A_PERSON",
  "OPEN_ORDER",
  "OPEN_BOOKING",
  "STORED_VALUE_BALANCE",
  "PENDING_REFUND",
  "UNPAID_AFFILIATE_PAYOUT",
] as const;

export type KodePenolakan = (typeof KODE_PENOLAKAN)[number];

export const PESAN_PENOLAKAN: Readonly<Record<KodePenolakan, string>> = {
  ALREADY_ERASED: "Akun ini sudah dihapus.",
  NOT_A_PERSON:
    "Ini adalah catatan walk-in kasir bersama, bukan orang, dan tidak dapat dihapus.",
  OPEN_ORDER:
    "Masih ada pesanan yang diproses. Penghapusan bisa dilakukan setelah semua pesanan selesai atau dibatalkan.",
  OPEN_BOOKING:
    "Masih ada pemesanan yang aktif. Penghapusan bisa dilakukan setelah pemesanan selesai atau dibatalkan.",
  STORED_VALUE_BALANCE:
    "Kartu hadiah atau kredit toko pada akun ini masih memiliki saldo.",
  PENDING_REFUND: "Masih ada retur atau pengembalian dana yang belum selesai.",
  UNPAID_AFFILIATE_PAYOUT: "Masih ada komisi afiliasi yang belum dibayarkan.",
};

export const PESAN_PENYIMPANAN =
  "Pesanan, pembayaran, dokumen, retur, pengembalian dana, dan buku besar poin serta saldo tetap disimpan selama masa pembukuan yang diwajibkan dan tidak lagi mengidentifikasi Anda.";

export const PESAN_KODE_SALAH =
  "Kode verifikasi salah atau sudah kedaluwarsa. Minta kode baru, lalu coba lagi.";

function isKodePenolakan(value: unknown): value is KodePenolakan {
  return (
    typeof value === "string" &&
    (KODE_PENOLAKAN as readonly string[]).includes(value)
  );
}

/** The refusal codes of a `409 ERASURE_REFUSED`, in the server's order; `[]` for any other error (so a caller can always iterate). */
export function bacaPenolakan(error: unknown): KodePenolakan[] {
  if (!(error instanceof TokoApiError) || error.code !== "ERASURE_REFUSED")
    return [];
  const details = error.details as { refusals?: unknown } | undefined;
  if (!details || !Array.isArray(details.refusals)) return [];
  const codes: KodePenolakan[] = [];
  for (const entry of details.refusals) {
    const code = (entry as { code?: unknown } | null)?.code;
    if (isKodePenolakan(code)) codes.push(code);
  }
  return codes;
}

export type RingkasanPenghapusan = {
  replayed: boolean;
  retainedSections: string[];
  orders: number;
};

/** What a successful erasure answered, reduced to what the page shows; `null` when the body is not the documented shape. */
export function bacaRingkasanPenghapusan(
  raw: unknown,
): RingkasanPenghapusan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as {
    erased?: unknown;
    replayed?: unknown;
    summary?: unknown;
  };
  if (body.erased !== true) return null;
  const retained = (
    body.summary as {
      retained?: { sections?: unknown; orders?: unknown };
    } | null
  )?.retained;
  return {
    replayed: body.replayed === true,
    retainedSections: Array.isArray(retained?.sections)
      ? retained.sections.filter((x): x is string => typeof x === "string")
      : [],
    orders: typeof retained?.orders === "number" ? retained.orders : 0,
  };
}

/** `data-saya-<first 8 of the customer id>-<yyyy-mm-dd>.json`: names no one, sorts by date. */
export function namaBerkasEkspor(bundle: unknown, sekarang: Date): string {
  const id = (bundle as { customerId?: unknown } | null)?.customerId;
  const kepala = typeof id === "string" ? id.slice(0, 8) : "akun";
  return `data-saya-${kepala}-${sekarang.toISOString().slice(0, 10)}.json`;
}

const POLA_KODE = /^[0-9]{6}$/;

export function kodeValid(kode: string): boolean {
  return POLA_KODE.test(kode.trim());
}

/** The sentence the page shows for a failed call: the generic code answer, a refusal list, or the error's own message. */
export function pesanGalat(error: unknown): string {
  if (error instanceof TokoApiError) {
    if (error.code === "OTP_INVALID") return PESAN_KODE_SALAH;
    if (error.code === "RATE_LIMITED") {
      const tunggu = error.retryAfterSeconds;
      return tunggu === null
        ? "Terlalu banyak permintaan. Coba lagi nanti."
        : `Terlalu banyak permintaan. Coba lagi dalam ${tunggu} detik.`;
    }
    const penolakan = bacaPenolakan(error);
    if (penolakan.length > 0)
      return penolakan.map((kode) => PESAN_PENOLAKAN[kode]).join(" ");
    return error.message;
  }
  return "Terjadi kesalahan yang tidak terduga.";
}
