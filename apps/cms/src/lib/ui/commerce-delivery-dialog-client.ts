/**
 * Client-side driver for `CommerceDeliveryDialog.astro` (Issue #295,
 * ADR-0034). A trigger button anywhere on the page carries
 * `data-delivery-target-type` (`document` | `quotation_version` |
 * `work_order`), `data-delivery-target-id`, `data-delivery-number` and, for a
 * quotation, an optional `data-delivery-version`; clicking it opens the dialog,
 * loads that source's delivery history and (when the viewer may send) submits
 * `POST /api/v1/commerce/document-deliveries` with a fresh `Idempotency-Key` -
 * one per submit, so a double-click that races is one request and a deliberate
 * second press is an explicit re-send.
 *
 * Every string comes from the dialog's own `data-*` attributes (rendered
 * server-side by `t()`); this file holds no user-visible literal. History rows
 * are built with `textContent` only - a masked recipient, a provider error or a
 * document number is never parsed as markup.
 */
import {
  messageBox,
  onAction,
  onSubmit,
  sendJsonForData
} from "./admin-form-client";

type Tone = "success" | "info" | "warning" | "danger" | "neutral";

type DeliveryEntry = {
  id: string;
  channel: "email" | "whatsapp";
  recipientSource: "source_customer" | "override";
  recipientMasked: string;
  status: "queued" | "not_enqueued";
  failureReason: string | null;
  resendOfId: string | null;
  hasLink: boolean;
  linkExpiresAt: string | null;
  createdAt: string;
  outbox: {
    status: string | null;
    retryCount: number;
    lastError: string | null;
  };
};

type Target = {
  type: string;
  id: string;
  number: string;
  version: number | null;
};

const TONES: Record<string, Tone> = {
  sent: "success",
  queued: "info",
  sending: "info",
  retry_wait: "warning",
  failed: "danger",
  cancelled: "neutral",
  suppressed: "warning",
  not_enqueued: "warning"
};

const ERROR_MESSAGES: Record<string, string> = {
  ACCESS_DENIED: "msgForbidden",
  CHANNEL_UNAVAILABLE: "msgChannel",
  RECIPIENT_UNAVAILABLE: "msgNoRecipient",
  RECIPIENT_SUPPRESSED: "msgSuppressed",
  TEMPLATE_UNAVAILABLE: "msgTemplate",
  SOURCE_NOT_DELIVERABLE: "msgNotDeliverable",
  DOCUMENT_INTEGRITY_FAILURE: "msgIntegrity",
  DELIVERY_RATE_LIMITED: "msgRateLimited",
  VALIDATION_ERROR: "msgBadRecipient"
};

export function initDeliveryDialog(): void {
  const dialog = document.getElementById("delivery-dialog");
  if (!(dialog instanceof HTMLDialogElement)) return;

  const text = (key: string): string => dialog.dataset[key] ?? "";
  const notice = messageBox("delivery-dialog-notice");
  const ok = messageBox("delivery-dialog-ok");
  const title = document.getElementById("delivery-dialog-title");
  const linkRow = document.getElementById("delivery-link-row");
  const form = document.getElementById("delivery-form");
  const table = document.getElementById("delivery-history");
  const body = document.getElementById("delivery-history-body");
  const empty = document.getElementById("delivery-history-empty");
  const dateFormat = new Intl.DateTimeFormat(
    document.documentElement.lang || undefined,
    { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" }
  );
  const formatDate = (iso: string): string => dateFormat.format(new Date(iso));

  let target: Target | null = null;

  function cell(label: string, ...children: (Node | string)[]): HTMLElement {
    const td = document.createElement("td");
    td.setAttribute("data-label", label);
    td.append(...children);
    return td;
  }

  function statusPill(entry: DeliveryEntry): HTMLElement {
    const key = entry.outbox.status ?? entry.status;
    const pill = document.createElement("span");
    pill.className = "admin-status-pill";
    pill.dataset.tone = TONES[key] ?? "neutral";
    const dot = document.createElement("span");
    dot.className = "admin-status-pill-dot";
    dot.setAttribute("aria-hidden", "true");
    const camel = key.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
    const label =
      text(`status${camel.charAt(0).toUpperCase()}${camel.slice(1)}`) ||
      text("statusUnknown");
    pill.append(dot, label);
    return pill;
  }

  function details(entry: DeliveryEntry): string {
    const parts: string[] = [];
    if (entry.resendOfId) parts.push(text("textResend"));
    if (entry.recipientSource === "override") parts.push(text("textOverride"));
    if (entry.outbox.retryCount > 0) {
      parts.push(
        text("textRetries").replace("{count}", String(entry.outbox.retryCount))
      );
    }
    if (entry.hasLink && entry.linkExpiresAt) {
      parts.push(
        text("textLink").replace("{date}", formatDate(entry.linkExpiresAt))
      );
    }
    if (entry.outbox.lastError) parts.push(entry.outbox.lastError);
    return parts.join(" · ");
  }

  function renderHistory(items: DeliveryEntry[]): void {
    if (!table || !body || !empty) return;
    body.replaceChildren();
    empty.hidden = items.length > 0;
    table.hidden = items.length === 0;
    for (const entry of items) {
      const row = document.createElement("tr");
      row.append(
        cell(text("labelWhen"), formatDate(entry.createdAt)),
        cell(
          text("labelChannel"),
          text(`channel${entry.channel === "email" ? "Email" : "Whatsapp"}`)
        ),
        cell(text("labelRecipient"), entry.recipientMasked),
        cell(text("labelStatus"), statusPill(entry)),
        cell(text("labelDetail"), details(entry))
      );
      body.append(row);
    }
  }

  async function loadHistory(): Promise<void> {
    if (!target || !table) return;
    const query = new URLSearchParams({
      targetType: target.type,
      targetId: target.id
    });
    const response = await fetch(
      `/api/v1/commerce/document-deliveries?${query.toString()}`,
      { credentials: "same-origin" }
    ).catch(() => null);
    const payload = (await response?.json().catch(() => null)) as {
      success?: boolean;
      data?: { items?: DeliveryEntry[] };
    } | null;
    if (!response?.ok || !payload?.data?.items) {
      notice.show(text("msgHistoryFailed"));
      return;
    }
    renderHistory(payload.data.items);
  }

  onAction(".delivery-open", async (button) => {
    const { deliveryTargetType, deliveryTargetId, deliveryNumber } =
      button.dataset;
    if (!deliveryTargetType || !deliveryTargetId) return;
    target = {
      type: deliveryTargetType,
      id: deliveryTargetId,
      number: deliveryNumber ?? "",
      version: button.dataset.deliveryVersion
        ? Number(button.dataset.deliveryVersion)
        : null
    };
    notice.clear();
    ok.clear();
    if (title) {
      title.textContent = text("title").replace("{number}", target.number);
    }
    if (form instanceof HTMLFormElement) form.reset();
    if (linkRow) linkRow.hidden = target.type !== "document";
    body?.replaceChildren();
    if (table) table.hidden = true;
    if (empty) empty.hidden = true;
    dialog.showModal();
    await loadHistory();
  });

  document
    .getElementById("delivery-close")
    ?.addEventListener("click", () => dialog.close());

  onSubmit("delivery-form", async ({ data, submit }) => {
    if (!target) return;
    notice.clear();
    ok.clear();
    const recipient = String(data.get("recipient") ?? "").trim();
    const channel = String(data.get("channel") ?? "email");
    if (submit) submit.disabled = true;
    const result = await sendJsonForData<{ recipientMasked: string }>(
      "POST",
      "/api/v1/commerce/document-deliveries",
      {
        targetType: target.type,
        targetId: target.id,
        ...(target.version !== null ? { version: target.version } : {}),
        channel,
        locale: String(data.get("locale") ?? "id"),
        ...(recipient !== "" ? { recipient } : {}),
        ...(data.get("includeLink") ? { includeLink: true } : {})
      },
      { "Idempotency-Key": crypto.randomUUID() }
    );
    if (submit) submit.disabled = false;
    if (result.ok && result.data) {
      ok.show(
        text("msgQueued").replace("{recipient}", result.data.recipientMasked)
      );
    } else {
      const key = result.errorCode
        ? ERROR_MESSAGES[result.errorCode]
        : undefined;
      notice.show(text(key ?? "msgFailed") || text("msgFailed"));
    }
    await loadHistory();
  });
}
