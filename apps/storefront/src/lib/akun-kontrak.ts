/**
 * The customer-session contract — shape, storage key, event name, and every
 * PURE operation on a session (validate/parse/expiry), issue #88, built on
 * the same "pure kontrak + thin browser klien" split `wishlist-kontrak.ts`
 * (#30) already established: no `window`, no `localStorage`, so this file is
 * unit-testable with no DOM, and `akun-sesi.ts` is a thin wrapper built
 * entirely out of what is exported here.
 *
 * The contract itself — `localStorage` key, `{token, expiresAt, account}`
 * shape — is issue #86's own D3 (opaque bearer session, 30-day sliding TTL,
 * kept in `localStorage` because there is no cookie to keep it in — ADR-0007
 * never grew a runtime credential for this app, and a customer session is
 * not an exception to that).
 */

/** `localStorage` key — namespaced under the same `awcms-one:` prefix as the cart/wishlist (`keranjang-kontrak.ts`/`wishlist-kontrak.ts`), versioned the same way. */
export const AKUN_STORAGE_KEY = "awcms-one:akun:v1";

/** `CustomEvent` name dispatched on `window` after every write (including a clear) — `src/scripts/akun-header.ts` and every account page listen for this to stay in sync with a login/logout/profile edit on the SAME tab; the native `storage` event covers another tab. */
export const AKUN_EVENT_NAME = "akun:berubah";

function isIsoDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The account fields `GET/PATCH …/account/me` and the OTP-verify response carry (#86's own `{account:{id,name,email,phone,level,createdAt,historyFrom}}`). */
export type Akun = {
  id: string;
  name: string;
  email: string;
  phone: string;
  level: number;
  createdAt: string;
  historyFrom: string;
};

export type SesiAkun = {
  /** The opaque bearer token — `cs_…` in production, `cs_stub_…` from `scripts/stub-awcms.mjs`. Never parsed or decoded here; it is a capability, not a claim. */
  token: string;
  /** ISO 8601 — the sliding 30-day expiry the CMS returned alongside `token`. */
  expiresAt: string;
  account: Akun;
};

/** Validates one candidate account, returning `null` (never throwing) for anything malformed — dropped rather than trusting a corrupted/tampered `localStorage` value, the same posture `wishlist-kontrak.ts`'s `validateWishlistItem` takes. */
export function validateAkun(value: unknown): Akun | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.id !== "string" || candidate.id.length === 0) return null;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) return null;
  if (typeof candidate.email !== "string" || candidate.email.length === 0) return null;
  if (typeof candidate.phone !== "string" || candidate.phone.length === 0) return null;
  if (typeof candidate.level !== "number" || !Number.isFinite(candidate.level)) return null;
  if (!isIsoDateString(candidate.createdAt)) return null;
  if (typeof candidate.historyFrom !== "string" || !isIsoDateString(candidate.historyFrom)) return null;

  return {
    id: candidate.id,
    name: candidate.name,
    email: candidate.email,
    phone: candidate.phone,
    level: candidate.level,
    createdAt: candidate.createdAt,
    historyFrom: candidate.historyFrom
  };
}

/** Validates one candidate session, returning `null` for anything malformed — mirrors `wishlist-kontrak.ts`'s `validateWishlistItem`. */
export function validateSesi(value: unknown): SesiAkun | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (typeof candidate.token !== "string" || candidate.token.length === 0) return null;
  if (!isIsoDateString(candidate.expiresAt)) return null;

  const account = validateAkun(candidate.account);
  if (!account) return null;

  return { token: candidate.token, expiresAt: candidate.expiresAt as string, account };
}

/** Parses a raw `localStorage` string into a {@link SesiAkun}, or `null` for anything not at least a well-shaped session — mirrors `wishlist-kontrak.ts`'s `parseWishlist`. */
export function parseSesi(raw: string | null | undefined): SesiAkun | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return validateSesi(parsed);
}

/** Whether `sesi` is expired at `now` (default: the real clock) — a pure function of its arguments so a test never has to fake `Date.now()` globally. */
export function isSesiKedaluwarsa(sesi: SesiAkun, now: number = Date.now()): boolean {
  return new Date(sesi.expiresAt).getTime() <= now;
}
