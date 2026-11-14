/**
 * `/akun/privasi` interactivity (issue #529, ADR-0055) — mounted from
 * `privasi.astro`; a no-op when `[data-akun-privasi-root]` is absent.
 *
 * Three views, chosen from the stored session (`bacaSesi()`), never from the
 * build:
 *   - no session → the guest view, a link to `/masuk`;
 *   - a session → the member view: an export card and an erasure card, each with
 *     "send me a code" and an action button;
 *   - after a successful erasure → the done view. The server has revoked every
 *     session, so the stored one is cleared here (`hapusSesi`) and the header
 *     returns to "Masuk".
 *
 * The export is built from the response and handed to the browser as a file
 * download; it is never put in the DOM, storage or a URL beyond the object URL
 * revoked straight after the click. The erasure's `Idempotency-Key` lives in this
 * closure only: it is kept across a retry after an ambiguous failure (no answer,
 * a 5xx) and rotated after a definitive one, as `src/lib/kunci-idempotensi.ts`
 * documents. No `confirm()`: the shopper ticks an explicit acknowledgement.
 */
import { penjagaUntuk, type PenjagaTunggal } from "../lib/kirim-tunggal";
import {
  eksporDataSaya,
  hapusDataSaya,
  mintaKodePrivasi,
} from "../lib/akun-klien";
import { bacaSesi, hapusSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { buatKunciBaru } from "../lib/kunci-idempotensi";
import {
  PESAN_PENYIMPANAN,
  bacaRingkasanPenghapusan,
  kodeValid,
  namaBerkasEkspor,
  pesanGalat,
  PESAN_KODE_SALAH,
} from "../lib/privasi-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";

const root = document.querySelector<HTMLElement>("[data-akun-privasi-root]");
if (root) {
  const q = <T extends HTMLElement>(selector: string): T | null =>
    root.querySelector<T>(selector);

  const statusEl = q("[data-status]");
  const errorEl = q("[data-submit-error]");
  const errorMessageEl = q("[data-submit-error-message]");
  const guestView = q("[data-guest-view]");
  const memberView = q("[data-member-view]");
  const doneView = q("[data-done-view]");
  const doneMessageEl = q("[data-done-message]");

  const eksporKode = q<HTMLInputElement>("[data-privasi-ekspor-kode]");
  const eksporKirim = q<HTMLButtonElement>("[data-privasi-ekspor-kirim]");
  const eksporUnduh = q<HTMLButtonElement>("[data-privasi-ekspor-unduh]");
  const hapusKode = q<HTMLInputElement>("[data-privasi-hapus-kode]");
  const hapusKirim = q<HTMLButtonElement>("[data-privasi-hapus-kirim]");
  const hapusJalankan = q<HTMLButtonElement>("[data-privasi-hapus-jalankan]");
  const hapusPaham = q<HTMLInputElement>("[data-privasi-hapus-paham]");

  function tampilStatus(teks: string): void {
    if (!statusEl) return;
    statusEl.textContent = teks;
    statusEl.hidden = teks.length === 0;
  }

  function tampilGalat(error: unknown): void {
    if (!errorEl || !errorMessageEl) return;
    errorMessageEl.textContent = pesanGalat(error);
    errorEl.hidden = false;
  }

  function sembunyiGalat(): void {
    if (errorEl) errorEl.hidden = true;
  }

  // One shared single-flight guard per button (issue #513): a double tap never
  // sends a second request, and the button is restored in every outcome.
  const penjaga = new Map<HTMLButtonElement, PenjagaTunggal>();

  /** Runs `task` under the button's guard, showing its error (never throwing) and restoring the status line. */
  async function jalankan(
    tombol: HTMLButtonElement | null,
    sibuk: string,
    task: () => Promise<void>,
  ): Promise<void> {
    if (!tombol) return;
    let guard = penjaga.get(tombol);
    if (!guard) {
      guard = penjagaUntuk(tombol);
      penjaga.set(tombol, guard);
    }
    sembunyiGalat();
    tampilStatus(sibuk);
    await guard.jalankan(async () => {
      try {
        await task();
      } catch (error) {
        tampilStatus("");
        tampilGalat(error);
      }
    });
  }

  function unduhJson(nilai: unknown, namaBerkas: string): void {
    const blob = new Blob([JSON.stringify(nilai, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const tautan = document.createElement("a");
    tautan.href = url;
    tautan.download = namaBerkas;
    tautan.rel = "noopener";
    document.body.append(tautan);
    tautan.click();
    tautan.remove();
    URL.revokeObjectURL(url);
  }

  eksporKirim?.addEventListener(
    "click",
    () =>
      void jalankan(eksporKirim, "Mengirim kode…", async () => {
        await mintaKodePrivasi("export");
        tampilStatus(
          "Kode verifikasi dikirim ke e-mail akun Anda. Masukkan kode di bawah.",
        );
        eksporKode?.focus();
      }),
  );

  eksporUnduh?.addEventListener(
    "click",
    () =>
      void jalankan(eksporUnduh, "Menyiapkan berkas…", async () => {
        const kode = (eksporKode?.value ?? "").trim();
        if (!kodeValid(kode))
          throw new TokoApiError(PESAN_KODE_SALAH, 400, "OTP_INVALID");
        const { bundle } = await eksporDataSaya(kode);
        unduhJson(bundle, namaBerkasEkspor(bundle, new Date()));
        if (eksporKode) eksporKode.value = "";
        tampilStatus(
          "Berkas data Anda telah diunduh. Kode hanya berlaku sekali; minta kode baru untuk unduhan berikutnya.",
        );
      }),
  );

  hapusKirim?.addEventListener(
    "click",
    () =>
      void jalankan(hapusKirim, "Mengirim kode…", async () => {
        await mintaKodePrivasi("erasure");
        tampilStatus(
          "Kode verifikasi dikirim ke e-mail akun Anda. Masukkan kode di bawah.",
        );
        hapusKode?.focus();
      }),
  );

  // One key per erasure ATTEMPT: kept after an ambiguous failure so a retry
  // replays, rotated after a definitive answer.
  let kunciHapus = buatKunciBaru();
  // True after a timeout or 5xx of the current attempt (the outcome is unknown).
  let ambigu = false;

  function tampilSelesai(
    ringkasan: ReturnType<typeof bacaRingkasanPenghapusan>,
  ): void {
    // The server revoked every session; drop the local copy so the header and
    // every other tab return to "Masuk" (a `401` would do the same).
    hapusSesi();
    if (memberView) memberView.hidden = true;
    if (guestView) guestView.hidden = true;
    if (doneView) doneView.hidden = false;
    if (doneMessageEl) {
      doneMessageEl.textContent = `${PESAN_PENYIMPANAN}${
        ringkasan && ringkasan.orders > 0
          ? ` (${ringkasan.orders} pesanan disimpan sebagai catatan tanpa identitas.)`
          : ""
      }`;
    }
    tampilStatus("");
    sembunyiGalat();
  }

  hapusJalankan?.addEventListener(
    "click",
    () =>
      void jalankan(hapusJalankan, "Menghapus data…", async () => {
        const kode = (hapusKode?.value ?? "").trim();
        if (!kodeValid(kode))
          throw new TokoApiError(PESAN_KODE_SALAH, 400, "OTP_INVALID");
        if (!hapusPaham?.checked) {
          throw new TokoApiError(
            "Centang pernyataan bahwa Anda mengerti penghapusan ini tidak dapat dibatalkan.",
            400,
            "VALIDATION_ERROR",
          );
        }

        let raw: unknown;
        try {
          raw = await hapusDataSaya(kode, kunciHapus);
        } catch (error) {
          const pasti =
            error instanceof TokoApiError &&
            error.status < 500 &&
            error.code !== "NETWORK_ERROR";
          // A `401` after an AMBIGUOUS failure of this same attempt means the
          // erasure went through and revoked the session (ADR-0055 D5): show the
          // done view, not "session expired".
          if (ambigu && error instanceof TokoApiError && error.status === 401) {
            kunciHapus = buatKunciBaru();
            ambigu = false;
            tampilSelesai(null);
            return;
          }
          if (pasti) {
            kunciHapus = buatKunciBaru();
            ambigu = false;
          } else {
            ambigu = true;
          }
          throw error;
        }

        ambigu = false;
        tampilSelesai(bacaRingkasanPenghapusan(raw));
      }),
  );

  function render(): void {
    sembunyiGalat();
    if (doneView && !doneView.hidden) return;
    const sesi = bacaSesi();
    if (guestView) guestView.hidden = sesi !== null;
    if (memberView) memberView.hidden = sesi === null;
  }

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
