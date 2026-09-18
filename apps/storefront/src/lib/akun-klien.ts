/**
 * The customer-account cross-origin client (issue #88) — the only file that
 * calls `<cms>/api/v1/commerce/storefront/account/*` from the BROWSER, per
 * the #86 contract. One function per endpoint S1 needs now: `mintaKode`,
 * `verifikasiKode` (anonymous), `ambilProfil`, `ubahProfil`, `keluar`
 * (bearer). The addresses/wishlist/orders/reviews/affiliate endpoints #86
 * also documents land with S2/S3 and are deliberately not added here.
 *
 * Every request reuses `src/lib/toko-permintaan.ts`'s `kirimPermintaan` —
 * the same `mode: "cors"` / `credentials: "omit"` / envelope/error handling
 * `toko-klien.ts` already established, so this file adds no second copy of
 * that plumbing. The one thing this file adds on top: a bearer endpoint
 * reads its token from `src/lib/akun-sesi.ts` and, on `401 UNAUTHENTICATED`,
 * clears the session before rethrowing — #86's own rule ("missing/invalid/
 * expired → 401 UNAUTHENTICATED"), applied here so a caller never has to
 * remember to do it at every call site.
 */
import { bacaSesi, hapusSesi } from "./akun-sesi";
import type { Akun } from "./akun-kontrak";
import { kirimPermintaan, TokoApiError } from "./toko-permintaan";

export type OtpPurpose = "login" | "register";

export type MintaKodeInput = {
  email: string;
  purpose: OtpPurpose;
  /** Only meaningful, and only sent, for `purpose: "register"` — #86's own "registration data is stored on the OTP row and applied at verify". */
  name?: string;
  phone?: string;
};

export type MintaKodeResponse = { sent: true; expiresInSeconds: number };

/** `POST …/account/otp/request` — anonymous. Always `202 {sent:true, expiresInSeconds}` per #86's own anti-enumeration rule; a caller must never infer "this e-mail has/has not an account" from this call's outcome. */
export function mintaKode(input: MintaKodeInput): Promise<MintaKodeResponse> {
  return kirimPermintaan<MintaKodeResponse>("/account/otp/request", "POST", input);
}

export type VerifikasiKodeInput = { email: string; code: string; purpose: OtpPurpose };

export type VerifikasiKodeResponse = { token: string; expiresAt: string; account: Akun };

/**
 * `POST …/account/otp/verify` — anonymous. `401 OTP_INVALID` (wrong,
 * expired, consumed, or attempts exhausted), `404 ACCOUNT_NOT_FOUND`
 * (`purpose: "login"`, no account for this e-mail), `409
 * PHONE_ALREADY_REGISTERED` (`purpose: "register"`, phone bound to another
 * account) — every one of these is a `TokoApiError` a caller switches on by
 * `.code`, per `toko-permintaan.ts`'s own contract. This function does NOT
 * call `simpanSesi` itself: the page decides when a fresh session is stored
 * (after showing/consuming the response), matching `checkout.ts`'s own
 * "the client never has a side effect its caller didn't ask for" posture.
 */
export function verifikasiKode(input: VerifikasiKodeInput): Promise<VerifikasiKodeResponse> {
  return kirimPermintaan<VerifikasiKodeResponse>("/account/otp/verify", "POST", input);
}

/**
 * The bearer header for an authenticated call, or a `401 UNAUTHENTICATED`
 * `TokoApiError` thrown BEFORE any `fetch` happens when there is no local
 * session at all — the same "fail before the network, name what's missing"
 * posture `toko-origin.ts`'s `requireAwcmsOrigin` already takes for a
 * missing `PUBLIC_AWCMS_ORIGIN`.
 */
function authHeader(): Record<string, string> {
  const sesi = bacaSesi();
  if (!sesi) {
    throw new TokoApiError("Anda belum masuk, atau sesi telah berakhir.", 401, "UNAUTHENTICATED");
  }
  return { Authorization: `Bearer ${sesi.token}` };
}

/** Runs `panggil`, clearing the local session on a `401 UNAUTHENTICATED` from the CMS — a token can go bad server-side (revoked, expired past the CMS's own clock) even when this browser's own copy of `expiresAt` has not caught up yet. */
async function denganPembersihanSesi<T>(panggil: () => Promise<T>): Promise<T> {
  try {
    return await panggil();
  } catch (error) {
    if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
      hapusSesi();
    }
    throw error;
  }
}

/** `GET …/account/me` — bearer. `403 ACCOUNT_BLOCKED` surfaces as an ordinary `TokoApiError`; this function does not treat it specially (a page decides how to explain a blocked account). */
export function ambilProfil(): Promise<{ account: Akun }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ account: Akun }>("/account/me", "GET", undefined, authHeader())
  );
}

export type UbahProfilInput = { name: string };

/** `PATCH …/account/me` — bearer. */
export function ubahProfil(input: UbahProfilInput): Promise<{ account: Akun }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ account: Akun }>("/account/me", "PATCH", input, authHeader())
  );
}

/**
 * `POST …/account/logout` — bearer, `204`. The caller (`src/scripts/akun.ts`)
 * ALWAYS clears the local session afterwards regardless of outcome (#88's
 * own "always clears local session even on network error") — this function
 * itself still clears it on a `401` (the token was already invalid) so the
 * two clear-paths agree, but a caller must not skip its own unconditional
 * clear on the strength of that alone.
 */
export function keluar(): Promise<void> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<void>("/account/logout", "POST", undefined, authHeader())
  );
}
