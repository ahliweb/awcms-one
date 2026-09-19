/**
 * `/akun/ulasan` interactivity (issue #90) — lists the signed-in account's
 * own product reviews: product name, rating as both text and stars (with an
 * `aria-label` naming the numeric rating for a screen-reader — the star
 * glyphs themselves are `aria-hidden`), and the Indonesian moderation status
 * label.
 */
import { ambilUlasanAkun, type UlasanAkun } from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const STATUS_LABELS: Record<UlasanAkun["status"], string> = {
  pending: "Menunggu moderasi",
  published: "Terbit",
  rejected: "Ditolak"
};

function starRow(rating: number): HTMLElement {
  const span = document.createElement("span");
  span.setAttribute("aria-label", `${rating} dari 5 bintang`);
  const glyphs = document.createElement("span");
  glyphs.setAttribute("aria-hidden", "true");
  glyphs.textContent = "★★★★★☆☆☆☆☆".slice(5 - rating, 10 - rating);
  span.appendChild(glyphs);
  return span;
}

const root = document.querySelector<HTMLElement>("[data-akun-ulasan-root]");
if (root) {
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const accountView = root.querySelector<HTMLElement>("[data-account-view]");
  const listEl = root.querySelector<HTMLElement>("[data-ulasan-list]");
  const emptyEl = root.querySelector<HTMLElement>("[data-ulasan-empty]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  function hideSubmitError(): void {
    if (submitErrorEl) submitErrorEl.hidden = true;
    if (waFallbackLink) waFallbackLink.hidden = true;
  }

  function showSubmitError(error: unknown): void {
    if (submitErrorEl && submitErrorMessageEl) {
      submitErrorEl.hidden = false;
      submitErrorMessageEl.textContent =
        error instanceof TokoApiError ? error.message : "Terjadi kesalahan yang tidak terduga.";
    }
    if (waFallbackLink && whatsappNumber) {
      waFallbackLink.href = buildWhatsappUrl(whatsappNumber, buildWhatsappAccountMessage(storeName, "melihat ulasan saya"));
      waFallbackLink.hidden = false;
    }
  }

  function showGuestView(): void {
    if (guestView) guestView.hidden = false;
    if (accountView) accountView.hidden = true;
  }

  function renderItem(ulasan: UlasanAkun): HTMLElement {
    const li = document.createElement("li");
    li.className = "akun-card";

    const title = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = ulasan.productName;
    title.appendChild(strong);
    li.appendChild(title);

    const ratingRow = document.createElement("p");
    ratingRow.append(`${ulasan.rating}/5 `, starRow(ulasan.rating));
    li.appendChild(ratingRow);

    const body = document.createElement("p");
    body.textContent = ulasan.body;
    li.appendChild(body);

    const status = document.createElement("p");
    const statusBadge = document.createElement("span");
    statusBadge.className = "akun-badge-status";
    statusBadge.textContent = STATUS_LABELS[ulasan.status] ?? ulasan.status;
    status.appendChild(statusBadge);
    li.appendChild(status);

    return li;
  }

  async function loadList(): Promise<void> {
    try {
      const { items } = await ambilUlasanAkun();
      if (!listEl) return;
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.hidden = items.length > 0;
      for (const ulasan of items) listEl.appendChild(renderItem(ulasan));
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "UNAUTHENTICATED") {
        showGuestView();
        return;
      }
      showSubmitError(error);
    }
  }

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();
    if (sesi) {
      if (guestView) guestView.hidden = true;
      if (accountView) accountView.hidden = false;
      void loadList();
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
