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
import type { Order } from "./toko-klien";

export type OtpPurpose = "login" | "register";

/** `"email"` (default) or `"whatsapp"` — issue #115 (contract: #106 D5). WhatsApp is a LOGIN-only channel: registration always goes out over e-mail, per this issue's own UI copy on `/daftar`. */
export type OtpChannel = "email" | "whatsapp";

export type MintaKodeInput = {
  /** Required when `via` is omitted or `"email"`; irrelevant (and not sent) for `via: "whatsapp"`. */
  email?: string;
  purpose: OtpPurpose;
  /** Only meaningful, and only sent, for `purpose: "register"` — #86's own "registration data is stored on the OTP row and applied at verify". */
  name?: string;
  /** For `purpose: "register"` this is the account's own phone; for `via: "whatsapp"` (login only) this is the number the code is sent to. */
  phone?: string;
  /** Omitted (defaults to `"email"` server-side) unless the shopper picked WhatsApp on `/masuk` — `/daftar` never sends this, matching its own "registration stays e-mail OTP" rule. */
  via?: OtpChannel;
};

export type MintaKodeResponse = { sent: true; expiresInSeconds: number };

/**
 * `POST …/account/otp/request` — anonymous. Always `202 {sent:true,
 * expiresInSeconds}` per #86's own anti-enumeration rule; a caller must
 * never infer "this e-mail/phone has/has not an account" from this call's
 * outcome. `409 CHANNEL_UNAVAILABLE` (an ordinary `TokoApiError`, not
 * special-cased here) is `via: "whatsapp"`'s own failure mode when the
 * tenant has not configured a WhatsApp provider — `/masuk`'s own script
 * decides how to explain it.
 */
export function mintaKode(input: MintaKodeInput): Promise<MintaKodeResponse> {
  return kirimPermintaan<MintaKodeResponse>("/account/otp/request", "POST", input);
}

export type VerifikasiKodeInput = {
  /** Required unless `phone` is given — the WhatsApp login path (#115) verifies by phone instead. */
  email?: string;
  phone?: string;
  code: string;
  purpose: OtpPurpose;
};

export type VerifikasiKodeResponse = { token: string; expiresAt: string; account: Akun };

/**
 * `POST …/account/otp/verify` — anonymous. `401 OTP_INVALID` (wrong,
 * expired, consumed, or attempts exhausted), `404 ACCOUNT_NOT_FOUND`
 * (`purpose: "login"`, no account for this e-mail/phone), `409
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

/**
 * `PATCH …/account/me`'s own body — both fields optional so a caller only
 * ever sends the ONE field it is changing (`/akun`'s "Ubah Nama" form sends
 * `name`; its consent toggle, added by issue #115, sends `marketingConsent`
 * alone) rather than round-tripping the whole profile on every edit.
 */
export type UbahProfilInput = { name?: string; marketingConsent?: boolean };

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

// ---------------------------------------------------------------------------
// Issue #90 (S2 of #32) — addresses, the account's own wishlist, orders, and
// reviews. Every function below is bearer-only, wrapped in the same
// `denganPembersihanSesi` a `401 UNAUTHENTICATED` from any of them clears the
// local session through, exactly like `ambilProfil`/`ubahProfil`/`keluar`
// above.
// ---------------------------------------------------------------------------

/** `awcms_commerce_customer_addresses` row shape, per #86's schema summary — field-for-field the same as `toko-klien.ts`'s own `OrderAddressInput` plus the fields an address (not a one-off order snapshot) additionally carries: `id`, a shopper-chosen `label`, and `isDefault`. */
export type Alamat = {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  postalCode: string;
  street: string;
  notes: string | null;
  isDefault: boolean;
};

export type AlamatInput = Omit<Alamat, "id" | "isDefault">;

/** `GET …/account/addresses` — every address on this account, most-recently-added last (the CMS's own order, this file imposes none). Max 10 per #86; `/akun/alamat` enforces the same limit client-side before ever sending a create request. */
export function ambilAlamat(): Promise<{ items: Alamat[] }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ items: Alamat[] }>("/account/addresses", "GET", undefined, authHeader())
  );
}

/** `POST …/account/addresses` — `400 VALIDATION_ERROR` per field, the same envelope every other form on this app switches on by `.fieldErrors`. */
export function tambahAlamat(input: AlamatInput): Promise<{ address: Alamat }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ address: Alamat }>("/account/addresses", "POST", input, authHeader())
  );
}

/** `PATCH …/account/addresses/{id}`. */
export function ubahAlamat(id: string, input: AlamatInput): Promise<{ address: Alamat }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ address: Alamat }>(`/account/addresses/${encodeURIComponent(id)}`, "PATCH", input, authHeader())
  );
}

/** `DELETE …/account/addresses/{id}` — `204`. */
export function hapusAlamat(id: string): Promise<void> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<void>(`/account/addresses/${encodeURIComponent(id)}`, "DELETE", undefined, authHeader())
  );
}

/** `POST …/account/addresses/{id}/default` — marks one address the account's default, per #86's own endpoint list. */
export function jadikanAlamatUtama(id: string): Promise<{ address: Alamat }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ address: Alamat }>(
      `/account/addresses/${encodeURIComponent(id)}/default`,
      "POST",
      undefined,
      authHeader()
    )
  );
}

/** The account wishlist's own item shape — identical fields to `wishlist-kontrak.ts`'s `WishlistItem` (both are "enough of a product to render a bookmark row"), kept as a SEPARATE type rather than importing that one: this file must stay usable with no `window` (`wishlist-kontrak.ts` is DOM-free too, so this is a naming/ownership choice, not a technical necessity — `wishlist-sinkron.ts` is the one file that converts between the two). */
export type WishlistAkunItem = {
  productId: string;
  slug: string;
  name: string;
  price: string;
  image: { url: string; alt: string } | null;
  addedAt: string;
};

/** `GET …/account/wishlist`. */
export function ambilWishlistAkun(): Promise<{ items: WishlistAkunItem[] }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ items: WishlistAkunItem[] }>("/account/wishlist", "GET", undefined, authHeader())
  );
}

/** `PUT …/account/wishlist` — `{productIds}` union-merges into whatever the account already has server-side; the response IS the merged, authoritative list (#86's own contract) — a caller never has to re-fetch after this call to know the result. */
export function simpanWishlistAkun(productIds: string[]): Promise<{ items: WishlistAkunItem[] }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ items: WishlistAkunItem[] }>("/account/wishlist", "PUT", { productIds }, authHeader())
  );
}

/** `DELETE …/account/wishlist/{productId}` — `204`. */
export function hapusWishlistAkunItem(productId: string): Promise<void> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<void>(`/account/wishlist/${encodeURIComponent(productId)}`, "DELETE", undefined, authHeader())
  );
}

export type AkunPesananHalaman = { items: Order[]; nextCursor: string | null };

/**
 * `GET …/account/orders?cursor=` — keyset-paginated, and ALREADY filtered
 * server-side to `created_at >= historyFrom` (#86's D4) — this function (and
 * every page built on it) trusts that filtering rather than re-applying it
 * client-side; see `/akun/pesanan`'s own docblock for why that distinction
 * matters to how this app's own stub/tests are shaped.
 */
export function ambilPesananAkun(cursor?: string | null): Promise<AkunPesananHalaman> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return denganPembersihanSesi(() =>
    kirimPermintaan<AkunPesananHalaman>(`/account/orders${query}`, "GET", undefined, authHeader())
  );
}

/** `GET …/account/orders/{orderCode}` — owned by this account, no phone required (the session already proves ownership, #86's own point of this route existing beside the phone-gated tracking one). `404 NOT_FOUND` for an order that is not this account's, or from before `historyFrom`. */
export function ambilPesananAkunByKode(orderCode: string): Promise<Order> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<Order>(`/account/orders/${encodeURIComponent(orderCode)}`, "GET", undefined, authHeader())
  );
}

/** One row of `GET …/account/reviews` — a review this account itself submitted, across every order/product, with its moderation `status`. */
export type UlasanAkun = {
  id: string;
  productId: string;
  productName: string;
  orderCode: string;
  rating: number;
  body: string;
  status: "pending" | "published" | "rejected";
  createdAt: string;
};

/** `GET …/account/reviews`. */
export function ambilUlasanAkun(): Promise<{ items: UlasanAkun[] }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ items: UlasanAkun[] }>("/account/reviews", "GET", undefined, authHeader())
  );
}

// ---------------------------------------------------------------------------
// Issue #93 (S3 of #32) — the affiliate program, #86's own D5. Every
// function below is bearer-only, wrapped in the same `denganPembersihanSesi`
// every other function in this file already uses.
// ---------------------------------------------------------------------------

/**
 * `GET/POST …/account/affiliate`'s own affiliate shape (#86's contract):
 * `code` is this file's own `validasiKodeAfiliasi` shape (8-char
 * unambiguous base32), `commissionRate` a `numeric(5,2)` STRING (the same
 * "a numeric column travels as a string" convention `harga.ts`'s own
 * docblock and `StoreSettings.payment.insurance.ratePercent` already
 * follow), `status` the two states staff can put an affiliate in, `link`
 * the CMS's own precomputed referral URL (`/akun/afiliasi` renders this
 * value directly rather than re-deriving it from `code` and `siteConfig`,
 * so a CMS-side change to the link shape needs no storefront change to
 * match).
 */
export type Afiliasi = {
  code: string;
  commissionRate: string;
  status: "active" | "suspended";
  link: string;
  stats: {
    referredOrders: number;
    pendingAmount: string;
    approvedAmount: string;
    paidAmount: string;
  };
};

/** `GET …/account/affiliate` — `{affiliate: null}` for a signed-in shopper who has not enrolled yet. */
export function ambilAfiliasi(): Promise<{ affiliate: Afiliasi | null }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ affiliate: Afiliasi | null }>("/account/affiliate", "GET", undefined, authHeader())
  );
}

/**
 * `POST …/account/affiliate` — `201` enrol. `409 AFFILIATE_PROGRAM_DISABLED`
 * when the tenant's program is off (#86's own "program must be enabled…
 * else `409`") — an ordinary `TokoApiError` this function does not treat
 * specially; `/akun/afiliasi`'s own script decides how to explain it (in
 * practice this should not be reachable at all when `affiliateProgramEnabled`
 * is `false` at BUILD time, since that page renders no enrol button then —
 * this is the belt-and-suspenders case of a program disabled AFTER this
 * static build shipped).
 */
export function gabungAfiliasi(): Promise<{ affiliate: Afiliasi }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ affiliate: Afiliasi }>("/account/affiliate", "POST", undefined, authHeader())
  );
}

/** One row of `GET …/account/affiliate/commissions` — `status` mirrors `awcms_commerce_affiliate_commissions`'s own four states (#86's schema summary); `/akun/afiliasi` labels them Menunggu/Disetujui/Dibayar/Dibatalkan. */
export type AfiliasiKomisi = {
  id: string;
  orderCode: string;
  amount: string;
  status: "pending" | "approved" | "paid" | "void";
  createdAt: string;
};

export type AfiliasiKomisiHalaman = { items: AfiliasiKomisi[]; nextCursor: string | null };

/** `GET …/account/affiliate/commissions?cursor=` — keyset-paginated, newest first (the CMS's own order, this function imposes none), for `/akun/afiliasi`'s own "Muat lebih banyak" list. */
export function ambilKomisiAfiliasi(cursor?: string | null): Promise<AfiliasiKomisiHalaman> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return denganPembersihanSesi(() =>
    kirimPermintaan<AfiliasiKomisiHalaman>(`/account/affiliate/commissions${query}`, "GET", undefined, authHeader())
  );
}

// ---------------------------------------------------------------------------
// Issue #115 (S3 of #33, contract #106 D8) — `/akun/pesan`'s own inbox: a
// signed-in shopper's conversations with the store. Every function below is
// bearer-only, wrapped in the same `denganPembersihanSesi` every other
// function in this file already uses.
// ---------------------------------------------------------------------------

/** One row of `GET …/account/conversations` — #106's own contract shape. `unreadForCustomer` is the count `/akun/pesan`'s list view badges; reading the thread (`ambilPercakapanById`) is what the CMS resets it on. */
export type Percakapan = {
  id: string;
  subject: string;
  status: "open" | "closed";
  lastMessageAt: string;
  unreadForCustomer: number;
};

export type PercakapanHalaman = { items: Percakapan[]; nextCursor: string | null };

/** One message inside a thread — `sender` is who sent it, never this account's own name/label (both sides render from `sender` alone). */
export type PesanPercakapan = {
  id: string;
  sender: "customer" | "store";
  body: string;
  createdAt: string;
};

/** `GET …/account/conversations?cursor=` — keyset-paginated, newest-activity-first (the CMS's own order), for `/akun/pesan`'s own list view. */
export function ambilPercakapan(cursor?: string | null): Promise<PercakapanHalaman> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return denganPembersihanSesi(() =>
    kirimPermintaan<PercakapanHalaman>(`/account/conversations${query}`, "GET", undefined, authHeader())
  );
}

export type BuatPercakapanInput = { subject: string; body: string };

/** `POST …/account/conversations` — `201 {conversation, message}`, the new thread and its own first (customer) message. `400 VALIDATION_ERROR` for an empty subject/body or a body over 4000 characters. */
export function buatPercakapan(
  input: BuatPercakapanInput
): Promise<{ conversation: Percakapan; message: PesanPercakapan }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ conversation: Percakapan; message: PesanPercakapan }>(
      "/account/conversations",
      "POST",
      input,
      authHeader()
    )
  );
}

/** `GET …/account/conversations/{id}` — the thread's own header plus every message, oldest first; the CMS marks it read (resets `unreadForCustomer`) as a side effect of this call, per #106's own contract — this function does not do that itself, only reflects the fresh `conversation` the response already carries. `404 NOT_FOUND` for a thread that is not this account's own. */
export function ambilPercakapanById(id: string): Promise<{ conversation: Percakapan; messages: PesanPercakapan[] }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ conversation: Percakapan; messages: PesanPercakapan[] }>(
      `/account/conversations/${encodeURIComponent(id)}`,
      "GET",
      undefined,
      authHeader()
    )
  );
}

/** `POST …/account/conversations/{id}/messages` — `201 {message}`. `409 CONVERSATION_CLOSED` once a thread is closed (the reply form is hidden then too, but a stale tab can still reach this); `400 VALIDATION_ERROR` over 4000 characters; `429 RATE_LIMITED` on abuse, the same field `toko-permintaan.ts`'s own `TokoApiError.retryAfterSeconds` already decodes. */
export function kirimPesanPercakapan(id: string, body: string): Promise<{ message: PesanPercakapan }> {
  return denganPembersihanSesi(() =>
    kirimPermintaan<{ message: PesanPercakapan }>(
      `/account/conversations/${encodeURIComponent(id)}/messages`,
      "POST",
      { body },
      authHeader()
    )
  );
}
