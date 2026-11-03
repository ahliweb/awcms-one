/**
 * The client half of the `Idempotency-Key` contract (issue #513, decision 3).
 *
 * The header name and shape are the ones the booking routes already use: an
 * opaque `[A-Za-z0-9_-]{16,128}` value created with `crypto.randomUUID()` per
 * USER ATTEMPT, stable across retries of that same attempt, rotated after a
 * definitive answer. The server treats it as optional; when present it dedupes
 * per (tenant, route, key) with a request digest: same key + same body replays,
 * same key + a different body is `409 IDEMPOTENCY_CONFLICT`.
 *
 * ## Where the key lives
 *
 * In MEMORY only, in the closure of the page script. It is never written to
 * `localStorage`/`sessionStorage` and never put in a URL. The two flows that
 * already keep something across a reload (checkout: `cart.id` is the key;
 * booking: the held order code in `sessionStorage`) keep their own mechanism -
 * this module does not fork it. See the PR trade-off table: a reload of an OTP
 * or a message form discards the typed code/draft anyway, so there is no
 * "same attempt" left to protect after it, and not persisting the key means a
 * shared device never carries a replayable token.
 *
 * ## Rotation
 *
 * - The key is bound to a fingerprint of the request (`untuk(sidik)`): an
 *   edited request is a different attempt and takes a fresh key (otherwise the
 *   server would answer `409 IDEMPOTENCY_CONFLICT`). The fingerprint is held in
 *   memory beside the key; it is never sent anywhere.
 * - `sesudahBerhasil()` rotates after a success.
 * - `sesudahGalat(error)` rotates after a DEFINITIVE answer (an HTTP response
 *   below 500: the server decided) and keeps the key after an ambiguous one (no
 *   response, a 5xx, an unreadable body, a timeout) so the retry replays.
 */

export const POLA_KUNCI_IDEMPOTENSI = /^[A-Za-z0-9_-]{16,128}$/;

export const NAMA_HEADER_KUNCI = "Idempotency-Key";

/** The code the server answers when a key is reused with a different body. */
export const KODE_KONFLIK_KUNCI = "IDEMPOTENCY_CONFLICT";

export const PESAN_KONFLIK_KUNCI =
  "Permintaan ini bertabrakan dengan percobaan sebelumnya. Muat ulang halaman, lalu coba lagi.";

export function kunciValid(kunci: string): boolean {
  return POLA_KUNCI_IDEMPOTENSI.test(kunci);
}

/** A fresh key: `crypto.randomUUID()` (36 chars of hex and hyphens), or - where it is unavailable (older browsers, an insecure context) - 22 base64url characters of `crypto.getRandomValues`. */
export function buatKunciBaru(kripto: Pick<Crypto, "randomUUID" | "getRandomValues"> | undefined = globalThis.crypto): string {
  if (kripto && typeof kripto.randomUUID === "function") return kripto.randomUUID();
  if (!kripto || typeof kripto.getRandomValues !== "function") {
    throw new Error("Peramban ini tidak menyediakan pembangkit acak yang aman.");
  }
  const bita = kripto.getRandomValues(new Uint8Array(16));
  let teks = "";
  for (const b of bita) teks += String.fromCharCode(b);
  return btoa(teks).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The request header object for a call: `{}` without a key, the one header with it. A malformed key is a coding error and throws rather than reaching the network. */
export function kunciHeader(kunci?: string): Record<string, string> {
  if (kunci === undefined) return {};
  if (!kunciValid(kunci)) throw new TypeError("Idempotency-Key tidak sesuai pola [A-Za-z0-9_-]{16,128}.");
  return { [NAMA_HEADER_KUNCI]: kunci };
}

/** Whether `error` is the server's `409 IDEMPOTENCY_CONFLICT`. */
export function galatKonflikKunci(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === KODE_KONFLIK_KUNCI;
}

/**
 * Whether the server gave a DEFINITIVE answer: an HTTP response below 500
 * (request 408 excepted). `status: 0` (no response), a 5xx and an unreadable
 * body are ambiguous - the request may have been processed - so a retry must
 * reuse its key.
 */
export function jawabanFinal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && status >= 200 && status < 500 && status !== 408;
}

export type PengelolaKunci = {
  /** The key for the attempt identified by `sidik`; the same one on a retry, a fresh one when `sidik` changed. */
  untuk(sidik: string): string;
  /** Rotates after a success. */
  sesudahBerhasil(): void;
  /** Rotates after a definitive error answer, keeps the key after an ambiguous one. */
  sesudahGalat(error: unknown): void;
  /** Whether an attempt is currently remembered (for tests). */
  ada(): boolean;
};

export function buatPengelolaKunci(buat: () => string = buatKunciBaru): PengelolaKunci {
  let saatIni: { sidik: string; kunci: string } | null = null;

  return {
    untuk(sidik) {
      if (saatIni === null || saatIni.sidik !== sidik) saatIni = { sidik, kunci: buat() };
      return saatIni.kunci;
    },
    sesudahBerhasil() {
      saatIni = null;
    },
    sesudahGalat(error) {
      if (jawabanFinal(error)) saatIni = null;
    },
    ada: () => saatIni !== null
  };
}
