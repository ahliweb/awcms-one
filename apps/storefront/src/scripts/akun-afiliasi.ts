/**
 * `/akun/afiliasi` interactivity (issue #93, S3 of #32) — mounted
 * unconditionally from `afiliasi.astro`; a no-op when
 * `[data-akun-afiliasi-root]` is absent (the program was disabled at BUILD
 * time — see that page's own docblock).
 *
 * Three states, chosen by `bacaSesi()` then a live `GET …/account/affiliate`
 * (never the stale build-time value alone, matching every other `/akun/*`
 * page's own "the markup works without deciding anything only JS could
 * decide" rule):
 *
 *   - no session → the guest view, a link to `/masuk`.
 *   - a session, `affiliate: null` → the enrol view, one button
 *     (`POST …/account/affiliate`). `409 AFFILIATE_PROGRAM_DISABLED`
 *     (the program was turned off AFTER this static page was built) shows
 *     the same submit-error banner every other account page uses, WITHOUT
 *     leaving the enrol button in a state that looks like it might still
 *     work.
 *   - a session, `affiliate` present → the enrolled view: the referral link
 *     in a read-only input with a copy button (the same
 *     clipboard-API-plus-silent-fallback shape as `voucher-copy.ts`),
 *     commission rate, an Indonesian status label, stats formatted with
 *     `harga.ts`'s `formatPrice` (never computed client-side — these are
 *     the CMS's own numbers), and a keyset-paginated commissions list
 *     ("Muat lebih banyak").
 */
import { ambilAfiliasi, ambilKomisiAfiliasi, gabungAfiliasi, type AfiliasiKomisiHalaman } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";
import { formatPrice } from "../lib/harga";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const STATUS_LABELS: Record<"active" | "suspended", string> = {
  active: "Aktif",
  suspended: "Ditangguhkan"
};

const KOMISI_STATUS_LABELS: Record<"pending" | "approved" | "paid" | "void", string> = {
  pending: "Menunggu",
  approved: "Disetujui",
  paid: "Dibayar",
  void: "Dibatalkan"
};

const root = document.querySelector<HTMLElement>("[data-akun-afiliasi-root]");
if (root) {
  const statusEl = root.querySelector<HTMLElement>("[data-status]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const enrolView = root.querySelector<HTMLElement>("[data-enrol-view]");
  const enrolledView = root.querySelector<HTMLElement>("[data-enrolled-view]");
  const gabungButton = root.querySelector<HTMLButtonElement>("[data-afiliasi-gabung]");

  const linkInput = root.querySelector<HTMLInputElement>("[data-afiliasi-link]");
  const copyButton = root.querySelector<HTMLButtonElement>("[data-afiliasi-copy]");
  const rateEl = root.querySelector<HTMLElement>("[data-afiliasi-rate]");
  const statusBadgeEl = root.querySelector<HTMLElement>("[data-afiliasi-status]");
  const referredOrdersEl = root.querySelector<HTMLElement>("[data-afiliasi-referred-orders]");
  const pendingEl = root.querySelector<HTMLElement>("[data-afiliasi-pending]");
  const approvedEl = root.querySelector<HTMLElement>("[data-afiliasi-approved]");
  const paidEl = root.querySelector<HTMLElement>("[data-afiliasi-paid]");

  const komisiListEl = root.querySelector<HTMLElement>("[data-komisi-list]");
  const komisiEmptyEl = root.querySelector<HTMLElement>("[data-komisi-empty]");
  const loadMoreButton = root.querySelector<HTMLButtonElement>("[data-load-more]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showSubmitError(error: unknown, context: string): void {
    if (submitErrorEl && submitErrorMessageEl) {
      submitErrorEl.hidden = false;
      submitErrorMessageEl.textContent =
        error instanceof TokoApiError ? error.message : "Terjadi kesalahan yang tidak terduga.";
    }
    if (waFallbackLink && whatsappNumber) {
      waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, context));
      waFallbackLink.hidden = false;
    }
  }

  function showGuestView(): void {
    if (guestView) guestView.hidden = false;
    if (enrolView) enrolView.hidden = true;
    if (enrolledView) enrolledView.hidden = true;
  }

  function showEnrolView(): void {
    if (guestView) guestView.hidden = true;
    if (enrolView) enrolView.hidden = false;
    if (enrolledView) enrolledView.hidden = true;
  }

  // --- commissions list (keyset, "Muat lebih banyak") -----------------------

  let nextCursor: string | null = null;

  function appendKomisiRows(page: AfiliasiKomisiHalaman): void {
    if (!komisiListEl) return;
    for (const komisi of page.items) {
      const li = document.createElement("li");
      li.className = "akun-card";

      const code = document.createElement("strong");
      code.textContent = komisi.orderCode;

      const status = document.createElement("span");
      status.className = "akun-badge-status";
      status.textContent = KOMISI_STATUS_LABELS[komisi.status] ?? komisi.status;

      const amount = document.createElement("span");
      amount.textContent = ` ${formatPrice(komisi.amount)} — `;

      const date = document.createElement("time");
      date.dateTime = komisi.createdAt;
      date.textContent = new Date(komisi.createdAt).toLocaleDateString("id-ID", {
        year: "numeric",
        month: "long",
        day: "numeric"
      });

      li.append(code, document.createTextNode(" — "), amount, status, document.createTextNode(" "), date);
      komisiListEl.appendChild(li);
    }

    nextCursor = page.nextCursor;
    if (loadMoreButton) loadMoreButton.hidden = !nextCursor;
    if (komisiEmptyEl) komisiEmptyEl.hidden = (komisiListEl?.children.length ?? 0) > 0;
  }

  async function loadMoreKomisi(): Promise<void> {
    try {
      const page = await ambilKomisiAfiliasi(nextCursor);
      appendKomisiRows(page);
      hideSubmitError();
    } catch (error) {
      showSubmitError(error, "memuat riwayat komisi afiliasi");
    }
  }

  loadMoreButton?.addEventListener("click", () => void loadMoreKomisi());

  // --- copy button (voucher-copy.ts's own pattern: clipboard API, silent
  // fallback — the link is already visible in the read-only input, so a
  // shopper can still select and copy it by hand) -----------------------

  copyButton?.addEventListener("click", async () => {
    const value = linkInput?.value ?? "";
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      const original = copyButton.textContent;
      copyButton.textContent = "Tersalin!";
      setTimeout(() => {
        copyButton.textContent = original;
      }, 2000);
    } catch {
      // Clipboard unavailable/denied — no-op, the link is already visible.
    }
  });

  // --- enrolled view rendering -----------------------------------------------

  function renderEnrolled(affiliate: {
    code: string;
    commissionRate: string;
    status: "active" | "suspended";
    link: string;
    stats: { referredOrders: number; pendingAmount: string; approvedAmount: string; paidAmount: string };
  }): void {
    if (guestView) guestView.hidden = true;
    if (enrolView) enrolView.hidden = true;
    if (enrolledView) enrolledView.hidden = false;

    if (linkInput) linkInput.value = affiliate.link;
    if (rateEl) rateEl.textContent = `${affiliate.commissionRate}%`;
    if (statusBadgeEl) statusBadgeEl.textContent = STATUS_LABELS[affiliate.status] ?? affiliate.status;
    if (referredOrdersEl) referredOrdersEl.textContent = String(affiliate.stats.referredOrders);
    if (pendingEl) pendingEl.textContent = formatPrice(affiliate.stats.pendingAmount);
    if (approvedEl) approvedEl.textContent = formatPrice(affiliate.stats.approvedAmount);
    if (paidEl) paidEl.textContent = formatPrice(affiliate.stats.paidAmount);

    if (komisiListEl) komisiListEl.innerHTML = "";
    nextCursor = null;
    void loadMoreKomisi();
  }

  gabungButton?.addEventListener("click", async () => {
    hideSubmitError();
    gabungButton.disabled = true;
    try {
      const { affiliate } = await gabungAfiliasi();
      renderEnrolled(affiliate);
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.textContent = "Berhasil bergabung dengan program afiliasi.";
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "AFFILIATE_PROGRAM_DISABLED") {
        if (submitErrorEl && submitErrorMessageEl) {
          submitErrorEl.hidden = false;
          submitErrorMessageEl.textContent = "Program afiliasi sedang tidak aktif di toko ini.";
        }
        return;
      }
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error, "bergabung dengan program afiliasi");
    } finally {
      gabungButton.disabled = false;
    }
  });

  // --- guest/account toggle ---------------------------------------------------

  async function showAccountView(): Promise<void> {
    try {
      const { affiliate } = await ambilAfiliasi();
      if (affiliate) {
        renderEnrolled(affiliate);
      } else {
        showEnrolView();
      }
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error, "membuka halaman afiliasi saya");
    }
  }

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();
    if (sesi) {
      void showAccountView();
    } else {
      showGuestView();
    }
  }

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
