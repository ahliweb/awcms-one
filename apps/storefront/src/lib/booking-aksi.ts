/**
 * The browser-side actions the reservation pages share (issue #387): asking the
 * server for the gateway session of a reservation and sending the browser to it.
 * `/akun/reservasi` (the list rows and the detail view) both call this one
 * function, so the refusal copy and the redirect check live in one place.
 *
 * It sends no amount: the purpose (`deposit` / `balance` / `full`) is a verb, and
 * the amount the provider charges is the server's own, guarded server-side
 * (UX 3.2, control C-07). Returning from the provider is not proof of payment -
 * the page reads the reservation from the server afterwards (C-06).
 */
import { bacaSesi, hapusSesi } from "./akun-sesi";
import { pesanGalatBooking } from "./booking-kontrak";
import { isValidGatewayRedirectUrl } from "./gateway-redirect";
import { createGatewaySession } from "./toko-klien";
import { TokoApiError } from "./toko-permintaan";

export type HasilBayar =
  /** The browser is being sent to the provider (`window.location.assign` was called). */
  | { kind: "dialihkan" }
  /** No session or the server said `401`: the session is cleared and the caller shows the sign-in prompt. */
  | { kind: "belum-masuk" }
  | { kind: "gagal"; message: string };

export function labelTombolBayar(purpose: "full" | "deposit" | "balance"): string {
  return purpose === "deposit" ? "Bayar uang muka" : purpose === "balance" ? "Bayar sisa pembayaran" : "Bayar sekarang";
}

export async function mulaiPembayaranGateway(
  orderCode: string,
  purpose: "full" | "deposit" | "balance"
): Promise<HasilBayar> {
  const sesi = bacaSesi();
  if (!sesi) return { kind: "belum-masuk" };
  try {
    const session = await createGatewaySession(orderCode, null, sesi.token, purpose);
    if (!isValidGatewayRedirectUrl(session.redirectUrl)) throw new Error("Gateway returned an unusable redirectUrl.");
    window.location.assign(session.redirectUrl);
    return { kind: "dialihkan" };
  } catch (error) {
    if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
      hapusSesi();
      return { kind: "belum-masuk" };
    }
    if (error instanceof TokoApiError && error.code === "GATEWAY_UNAVAILABLE") {
      return { kind: "gagal", message: "Pembayaran online sedang tidak tersedia. Buka detail pesanan untuk instruksi pembayaran." };
    }
    if (error instanceof TokoApiError && error.code === "RATE_LIMITED") {
      return { kind: "gagal", message: pesanGalatBooking("RATE_LIMITED").message };
    }
    return { kind: "gagal", message: "Gagal membuka halaman pembayaran. Coba lagi." };
  }
}
