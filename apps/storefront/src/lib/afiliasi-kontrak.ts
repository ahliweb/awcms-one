/**
 * The affiliate-referral capture contract (issue #93, S3 of #32) — shape,
 * storage key, TTL, and every operation on a captured `?ref=` code: shape
 * validation (pure, no `window`) plus the `localStorage` read/write
 * themselves, unlike `akun-kontrak.ts`/`akun-sesi.ts`'s two-file split. This
 * file combines both on purpose — a captured referral code has no
 * server-confirmed session to keep separate from its storage the way a
 * bearer token does, and #86's own D5 is explicit that the CMS "ignores
 * unknown/suspended codes" — there is nothing this file could verify against
 * a server before storing, only the CODE'S OWN SHAPE, which is exactly what
 * `validasiKodeAfiliasi` below checks.
 *
 * `src/scripts/afiliasi-tangkap.ts` is the only caller of
 * `simpanKodeAfiliasi`; `src/scripts/checkout.ts` and `src/scripts/
 * akun-afiliasi.ts` are the only callers of `bacaKodeAfiliasi`. Every
 * `window.localStorage` access is wrapped in try/catch — a private window,
 * or storage blocked by the browser/an extension, must read the same as "no
 * referral captured", never throw and break the page it is mounted on.
 */

/** `localStorage` key — namespaced under the same `awcms-one:` prefix as the cart/wishlist/session, versioned the same way. */
export const AFILIASI_STORAGE_KEY = "awcms-one:afiliasi:v1";

/** 30 days, in milliseconds — #93's own TTL for a captured referral: a code seen once keeps attributing checkouts for this long, then is dropped as stale rather than attributing a purchase made a season later. */
export const AFILIASI_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The contract's own code shape: exactly 8 characters, unambiguous base32 —
 * `A`–`Z` WITHOUT `I`/`O` (both easily confused with `1`/`0` when a code is
 * read aloud or hand-typed from a screenshot) plus digits `2`–`9` (`0`/`1`
 * excluded for the same reason). Case is accepted leniently by
 * `validasiKodeAfiliasi` below (upper-cased before this pattern ever sees
 * it) — this pattern itself only matches the canonical, already-upper-cased
 * form.
 */
const KODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Validates one candidate referral code, returning the canonical
 * (upper-cased) code or `null` for anything that is not exactly the
 * contract's shape — never throws. Lenient on case ONLY: a lower-case or
 * mixed-case `?ref=budk2x7z` is accepted and normalized to `BUDK2X7Z`, but
 * every other deviation (wrong length, a `0`/`1`/`I`/`O`, punctuation,
 * whitespace inside the code) is rejected.
 */
export function validasiKodeAfiliasi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const upper = raw.trim().toUpperCase();
  if (!KODE_PATTERN.test(upper)) return null;
  return upper;
}

/** The `{code, capturedAt}` shape stored under {@link AFILIASI_STORAGE_KEY}. */
export type AfiliasiTertangkap = {
  /** Already validated/upper-cased — see {@link validasiKodeAfiliasi}. */
  code: string;
  /** ISO 8601 — when this code was captured, the TTL's own starting point. */
  capturedAt: string;
};

/** Validates one candidate stored record, returning `null` (never throwing) for anything malformed — a corrupted/tampered `localStorage` value is dropped rather than trusted, the same posture `wishlist-kontrak.ts`'s `validateWishlistItem` and `akun-kontrak.ts`'s `validateSesi` both take. */
export function validateAfiliasi(value: unknown): AfiliasiTertangkap | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  const code = validasiKodeAfiliasi(candidate.code);
  if (!code) return null;
  if (!isIsoDateString(candidate.capturedAt)) return null;

  return { code, capturedAt: candidate.capturedAt };
}

/** Parses a raw `localStorage` string into an {@link AfiliasiTertangkap}, or `null` for anything not at least a well-shaped record — mirrors `wishlist-kontrak.ts`'s `parseWishlist`/`akun-kontrak.ts`'s `parseSesi`. */
export function parseAfiliasi(raw: string | null | undefined): AfiliasiTertangkap | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return validateAfiliasi(parsed);
}

/** Whether `afiliasi` is older than {@link AFILIASI_TTL_MS} at `now` (default: the real clock) — a pure function of its arguments so a test never has to fake `Date.now()` globally. */
export function isAfiliasiKedaluwarsa(afiliasi: AfiliasiTertangkap, now: number = Date.now()): boolean {
  return now - new Date(afiliasi.capturedAt).getTime() >= AFILIASI_TTL_MS;
}

function bacaStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The currently captured referral code, or `null` — never throws. An entry
 * whose `capturedAt` is past the 30-day TTL is treated as absent AND is
 * removed from storage here (rather than left for the next read to notice),
 * the same "drop it now, not later" posture `akun-sesi.ts`'s `bacaSesi`
 * already takes for an expired session.
 */
export function bacaKodeAfiliasi(now: number = Date.now()): AfiliasiTertangkap | null {
  const storage = bacaStorage();
  if (!storage) return null;

  let raw: string | null = null;
  try {
    raw = storage.getItem(AFILIASI_STORAGE_KEY);
  } catch {
    return null;
  }

  const afiliasi = parseAfiliasi(raw);
  if (!afiliasi) return null;

  if (isAfiliasiKedaluwarsa(afiliasi, now)) {
    try {
      storage.removeItem(AFILIASI_STORAGE_KEY);
    } catch {
      // A blocked/full storage that cannot even remove its own stale key
      // still reads as "nothing captured" on the next read — `parseAfiliasi`
      // would find the same expired entry and this function would drop it
      // again, so no special handling is needed here beyond not throwing.
    }
    return null;
  }

  return afiliasi;
}

/**
 * Stores `code` as freshly captured (at `capturedAt`, default: now) —
 * UNCONDITIONALLY overwriting whatever was there before, which is exactly
 * how "a newer valid code replaces an older one" (#93's own rule) is
 * satisfied: `afiliasi-tangkap.ts` calls this only after
 * `validasiKodeAfiliasi` has already accepted the incoming `?ref=`, so every
 * call here is a newer valid capture superseding any earlier one. Silently
 * does nothing if `code` fails validation, or if storage is unavailable —
 * this function is never the thing that throws and breaks the page it runs
 * on.
 */
export function simpanKodeAfiliasi(code: string, capturedAt: string = new Date().toISOString()): void {
  const valid = validasiKodeAfiliasi(code);
  if (!valid) return;

  const storage = bacaStorage();
  if (!storage) return;

  try {
    storage.setItem(AFILIASI_STORAGE_KEY, JSON.stringify({ code: valid, capturedAt } satisfies AfiliasiTertangkap));
  } catch {
    // A full/blocked/private-mode storage means this capture does not
    // persist — the shopper's checkout on THIS load still has no local copy
    // to read back, which is the same "not attributed" outcome as never
    // having clicked a referral link at all, not a broken page.
  }
}
