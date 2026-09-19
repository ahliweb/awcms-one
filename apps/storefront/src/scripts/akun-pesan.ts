/**
 * `/akun/pesan` interactivity (issue #115, S3 of #33, contract #106 D8) — a
 * signed-in shopper's own inbox with the store. Two views, chosen once per
 * load from `?id=`, mirroring `akun-pesanan.ts`'s own `?kode=` split:
 *
 *   - No `?id=`: a keyset-paginated LIST (`GET …/account/conversations?
 *     cursor=`), newest-activity-first, each row showing an unread badge
 *     (`aria-label`) when `unreadForCustomer > 0`, plus a "Pesan baru" form
 *     (`POST …/account/conversations`) that redirects straight into the
 *     new thread's own detail view.
 *   - `?id=` present: the DETAIL view (`GET …/account/conversations/{id}`)
 *     — every message, oldest first, and a reply form
 *     (`POST …/account/conversations/{id}/messages`) shown only while the
 *     thread's own `status` is `"open"`; a closed thread shows a note
 *     instead, per this issue's own acceptance criteria.
 *
 * Every fetch reuses `akun-klien.ts`'s own `denganPembersihanSesi` wrapper,
 * so a `401 UNAUTHENTICATED` from any of these calls clears the local
 * session the same way every other `/akun*` page's own calls already do.
 */
import {
  ambilPercakapan,
  ambilPercakapanById,
  buatPercakapan,
  kirimPesanPercakapan,
  type Percakapan,
  type PercakapanHalaman
} from "../lib/akun-klien";
import { bacaSesi } from "../lib/akun-sesi";
import { AKUN_EVENT_NAME } from "../lib/akun-kontrak";
import { TokoApiError } from "../lib/toko-permintaan";
import { ROUTES } from "../config/routes";
import { buildWhatsappAccountMessage, buildWhatsappUrl } from "../lib/wa-fallback";

const STATUS_LABELS: Record<Percakapan["status"], string> = { open: "Terbuka", closed: "Ditutup" };

const root = document.querySelector<HTMLElement>("[data-akun-pesan-root]");
if (root) {
  const guestView = root.querySelector<HTMLElement>("[data-guest-view]");
  const listView = root.querySelector<HTMLElement>("[data-list-view]");
  const detailView = root.querySelector<HTMLElement>("[data-detail-view]");
  const submitErrorEl = root.querySelector<HTMLElement>("[data-submit-error]");
  const submitErrorMessageEl = root.querySelector<HTMLElement>("[data-submit-error-message]");
  const waFallbackLink = root.querySelector<HTMLAnchorElement>("[data-wa-fallback-link]");

  const whatsappNumber = root.dataset.whatsappNumber ?? "";
  const storeName = root.dataset.storeName ?? "toko";

  const params = new URLSearchParams(window.location.search);
  const conversationId = params.get("id");

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

  // --- "Pesan baru" form -----------------------------------------------------

  const pesanBaruForm = listView?.querySelector<HTMLFormElement>("[data-pesan-baru-form]") ?? null;
  const subjectInput = pesanBaruForm?.querySelector<HTMLInputElement>('[name="subject"]') ?? null;
  const bodyInput = pesanBaruForm?.querySelector<HTMLTextAreaElement>('[name="body"]') ?? null;

  pesanBaruForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    hideSubmitError();
    pesanBaruForm.querySelectorAll<HTMLElement>("[data-error-for]").forEach((el) => (el.textContent = ""));

    const subject = subjectInput?.value.trim() ?? "";
    const body = bodyInput?.value.trim() ?? "";

    let hasError = false;
    if (!subject) {
      const t = pesanBaruForm.querySelector<HTMLElement>('[data-error-for="subject"]');
      if (t) t.textContent = "Subjek wajib diisi.";
      hasError = true;
    }
    if (!body) {
      const t = pesanBaruForm.querySelector<HTMLElement>('[data-error-for="body"]');
      if (t) t.textContent = "Pesan wajib diisi.";
      hasError = true;
    }
    if (hasError) return;

    try {
      const { conversation } = await buatPercakapan({ subject, body });
      window.location.href = ROUTES.accountMessage(conversation.id);
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "VALIDATION_ERROR") {
        for (const fieldError of error.fieldErrors) {
          const target = pesanBaruForm.querySelector<HTMLElement>(`[data-error-for="${fieldError.field}"]`);
          if (target) target.textContent = fieldError.message;
        }
        return;
      }
      showSubmitError(error, "mengirim pesan baru ke toko");
    }
  });

  // --- list view ---------------------------------------------------------------

  const listEl = listView?.querySelector<HTMLElement>("[data-conversation-list]") ?? null;
  const listEmptyEl = listView?.querySelector<HTMLElement>("[data-conversation-list-empty]") ?? null;
  const loadMoreButton = listView?.querySelector<HTMLButtonElement>("[data-load-more]") ?? null;
  let nextCursor: string | null = null;

  function appendConversationRows(page: PercakapanHalaman): void {
    if (!listEl) return;
    for (const conversation of page.items) {
      const li = document.createElement("li");
      li.className = "akun-card";

      const link = document.createElement("a");
      link.href = ROUTES.accountMessage(conversation.id);

      const title = document.createElement("strong");
      title.textContent = conversation.subject;

      const status = document.createElement("span");
      status.textContent = ` — ${STATUS_LABELS[conversation.status]}`;

      link.append(title, status);

      if (conversation.unreadForCustomer > 0) {
        const badge = document.createElement("span");
        badge.className = "akun-badge-unread";
        badge.textContent = String(conversation.unreadForCustomer);
        badge.setAttribute("aria-label", `${conversation.unreadForCustomer} pesan belum dibaca`);
        link.appendChild(document.createTextNode(" "));
        link.appendChild(badge);
      }

      li.appendChild(link);
      listEl.appendChild(li);
    }

    nextCursor = page.nextCursor;
    if (loadMoreButton) loadMoreButton.hidden = !nextCursor;
    if (listEmptyEl) listEmptyEl.hidden = (listEl?.children.length ?? 0) > 0;
  }

  async function loadMore(): Promise<void> {
    try {
      const page = await ambilPercakapan(nextCursor);
      appendConversationRows(page);
      hideSubmitError();
    } catch (error) {
      showSubmitError(error, "memuat daftar pesan saya");
    }
  }

  loadMoreButton?.addEventListener("click", () => void loadMore());

  // --- detail view ---------------------------------------------------------------

  const conversationErrorEl = detailView?.querySelector<HTMLElement>("[data-conversation-error]") ?? null;
  const conversationBodyEl = detailView?.querySelector<HTMLElement>("[data-conversation-body]") ?? null;
  const subjectEl = detailView?.querySelector<HTMLElement>("[data-conversation-subject]") ?? null;
  const statusEl = detailView?.querySelector<HTMLElement>("[data-conversation-status]") ?? null;
  const messageListEl = detailView?.querySelector<HTMLElement>("[data-message-list]") ?? null;
  const replySection = detailView?.querySelector<HTMLElement>("[data-reply-section]") ?? null;
  const replyForm = detailView?.querySelector<HTMLFormElement>("[data-reply-form]") ?? null;
  const replyBodyInput = replyForm?.querySelector<HTMLTextAreaElement>('[name="body"]') ?? null;
  const closedNoteEl = detailView?.querySelector<HTMLElement>("[data-closed-note]") ?? null;
  const backToListLink = detailView?.querySelector<HTMLAnchorElement>("[data-back-to-list]") ?? null;

  if (backToListLink) backToListLink.href = ROUTES.accountMessages;

  function renderMessages(messages: { id: string; sender: "customer" | "store"; body: string; createdAt: string }[]): void {
    if (!messageListEl) return;
    messageListEl.innerHTML = "";
    for (const message of messages) {
      const li = document.createElement("li");
      const who = document.createElement("strong");
      who.textContent = message.sender === "customer" ? "Anda" : storeName;
      const body = document.createElement("p");
      body.textContent = message.body;
      li.append(who, body);
      messageListEl.appendChild(li);
    }
  }

  async function loadDetail(id: string): Promise<void> {
    try {
      const { conversation, messages } = await ambilPercakapanById(id);
      if (conversationBodyEl) conversationBodyEl.hidden = false;
      if (conversationErrorEl) conversationErrorEl.hidden = true;

      if (subjectEl) subjectEl.textContent = conversation.subject;
      if (statusEl) statusEl.textContent = STATUS_LABELS[conversation.status];
      renderMessages(messages);

      const isOpen = conversation.status === "open";
      if (replySection) replySection.hidden = !isOpen;
      if (closedNoteEl) closedNoteEl.hidden = isOpen;
    } catch (error) {
      if (conversationErrorEl) conversationErrorEl.hidden = false;
      if (conversationBodyEl) conversationBodyEl.hidden = true;
      if (!(error instanceof TokoApiError)) showSubmitError(error, "melihat percakapan saya");
    }
  }

  replyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!conversationId) return;
    hideSubmitError();
    const errorEl = replyForm.querySelector<HTMLElement>('[data-error-for="reply-body"]');
    if (errorEl) errorEl.textContent = "";

    const body = replyBodyInput?.value.trim() ?? "";
    if (!body) {
      if (errorEl) errorEl.textContent = "Balasan wajib diisi.";
      return;
    }

    try {
      await kirimPesanPercakapan(conversationId, body);
      if (replyBodyInput) replyBodyInput.value = "";
      await loadDetail(conversationId);
    } catch (error) {
      if (error instanceof TokoApiError && error.code === "CONVERSATION_CLOSED") {
        await loadDetail(conversationId);
        return;
      }
      if (error instanceof TokoApiError && error.code === "VALIDATION_ERROR") {
        const fieldError = error.fieldErrors.find((f) => f.field === "body");
        if (errorEl) errorEl.textContent = fieldError?.message ?? error.message;
        return;
      }
      showSubmitError(error, "membalas percakapan");
    }
  });

  // --- guest/account toggle, and which view to show ---------------------------

  function render(): void {
    hideSubmitError();
    const sesi = bacaSesi();

    if (!sesi) {
      if (guestView) guestView.hidden = false;
      if (listView) listView.hidden = true;
      if (detailView) detailView.hidden = true;
      return;
    }

    if (guestView) guestView.hidden = true;

    if (conversationId) {
      if (listView) listView.hidden = true;
      if (detailView) detailView.hidden = false;
      void loadDetail(conversationId);
    } else {
      if (detailView) detailView.hidden = true;
      if (listView) listView.hidden = false;
      if (listEl) listEl.innerHTML = "";
      nextCursor = null;
      void loadMore();
    }
  }

  render();
  window.addEventListener(AKUN_EVENT_NAME, render);
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === "awcms-one:akun:v1") render();
  });
}
