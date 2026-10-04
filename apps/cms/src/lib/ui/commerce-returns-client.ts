/**
 * The order-detail "Returns and refunds" panel's client logic (Issue #287,
 * ADR-0033): a three-step return wizard in a native `<dialog>`, and the
 * "send to the payment provider" action on an open refund leg.
 *
 * Everything the user reads reaches this script already translated, as
 * `data-*` attributes on the panel (a client script cannot translate - the
 * catalogue is a server-only module). The pure half ({@link buildReturnPayload},
 * {@link validateLines}) is exported and unit-tested without a DOM; the
 * wiring below only moves values between the form and those functions.
 *
 * Nothing here computes money: the server values every line exactly to the
 * cent, and the panel reloads to show what it recorded. The wizard's review
 * step restates the user's choices - it does not predict a refund.
 */
import { lockElement, messageBox, sendJsonForData } from "./admin-form-client";
import { confirmFromTrigger } from "./commerce-confirm-dialog-client";

export type WizardLine = {
  orderItemId: string;
  /** Units still eligible to return (server-rendered). */
  remaining: number;
  quantity: number;
  reason: string;
  disposition: string;
};

export type WizardRefund = {
  mode: "none" | "original_tender" | "store_credit";
  shippingRefund: boolean;
  /** The caller's open drawer session, ticked for a cash refund, else `null`. */
  registerSessionId: string | null;
};

export type LineProblem = "none_selected" | "incomplete" | "too_many";

/**
 * Which problem (if any) stops step 1: nothing selected; a selected line
 * without a reason or a disposition (both are required, never defaulted); a
 * quantity above what remains eligible.
 */
export function validateLines(
  lines: readonly WizardLine[]
): LineProblem | null {
  const selected = lines.filter((line) => line.quantity > 0);
  if (selected.length === 0) return "none_selected";
  for (const line of selected) {
    if (!line.reason || !line.disposition) return "incomplete";
    if (!Number.isInteger(line.quantity) || line.quantity > line.remaining) {
      return "too_many";
    }
  }
  return null;
}

/** The request body for `POST /api/v1/commerce/orders/{id}/returns`. */
export function buildReturnPayload(input: {
  lines: readonly WizardLine[];
  refund: WizardRefund;
  exchange: boolean;
  note: string;
  shippingAmount: string | null;
}): Record<string, unknown> {
  const note = input.note.trim();
  return {
    kind: input.exchange ? "exchange" : "return",
    note: note === "" ? null : note,
    lines: input.lines
      .filter((line) => line.quantity > 0)
      .map((line) => ({
        orderItemId: line.orderItemId,
        quantity: line.quantity,
        reason: line.reason,
        disposition: line.disposition
      })),
    refund:
      input.refund.mode === "none"
        ? null
        : {
            destination: input.refund.mode,
            shippingRefund: input.refund.shippingRefund
              ? input.shippingAmount
              : null,
            registerSessionId: input.refund.registerSessionId
          }
  };
}

export function readPositiveInt(raw: string): number {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function initReturnsPanel(): void {
  const panel = document.getElementById("order-returns");
  if (!panel) return;
  const orderId = panel.dataset.orderId ?? "";
  const msg = (key: string): string => panel.dataset[key] ?? "";
  const error = messageBox("order-returns-error");

  const errorText = (code: string | null): string => {
    const map: Record<string, string> = {
      RETURN_QUANTITY_EXCEEDED: msg("msgQuantity"),
      ORDER_NOT_RETURNABLE: msg("msgNotReturnable"),
      REFUND_EXCEEDS_REFUNDABLE: msg("msgExceeds"),
      REFUND_NOT_REFUNDABLE: msg("msgExceeds"),
      SHIPPING_REFUND_EXCEEDED: msg("msgShipping"),
      STORE_CREDIT_UNAVAILABLE: msg("msgCredit"),
      PAYMENT_NOT_REVERSIBLE: msg("msgNotReversible"),
      REGISTER_SESSION_NOT_OPEN: msg("msgDrawer"),
      NOT_SESSION_CASHIER: msg("msgDrawer"),
      GATEWAY_UNAVAILABLE: msg("msgGateway"),
      PROVIDER_REFUND_FAILED: msg("msgProviderFailed"),
      FEATURE_DISABLED: msg("msgDisabled")
    };
    return map[code ?? ""] ?? msg("msgGeneric");
  };

  // --- the wizard ----------------------------------------------------------
  const dialog = document.getElementById(
    "order-return-wizard"
  ) as HTMLDialogElement | null;
  const openers = panel.querySelectorAll<HTMLButtonElement>(
    "[data-returns-open]"
  );
  if (dialog && typeof dialog.showModal === "function") {
    const steps = Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-returns-step]")
    );
    const wizardError = messageBox("order-return-wizard-error");
    const back = dialog.querySelector<HTMLButtonElement>("[data-returns-back]");
    const next = dialog.querySelector<HTMLButtonElement>("[data-returns-next]");
    const submit = dialog.querySelector<HTMLButtonElement>(
      "[data-returns-submit]"
    );
    const confirmBox = dialog.querySelector<HTMLInputElement>(
      "[data-returns-confirm]"
    );
    const review = dialog.querySelector<HTMLElement>("[data-returns-review]");
    const result = dialog.querySelector<HTMLElement>("[data-returns-result]");
    const creditCode = dialog.querySelector<HTMLElement>(
      "[data-returns-credit-code]"
    );
    const stepOf = (): number => steps.findIndex((el) => !el.hidden) + 1 || 1;

    const lineRows = Array.from(
      dialog.querySelectorAll<HTMLElement>("[data-returns-line]")
    );
    const readLines = (): WizardLine[] =>
      lineRows.map((row) => ({
        orderItemId: row.dataset.itemId ?? "",
        remaining: Number(row.dataset.remaining ?? "0"),
        quantity: readPositiveInt(
          row.querySelector<HTMLInputElement>("[data-returns-qty]")?.value ?? ""
        ),
        reason:
          row.querySelector<HTMLSelectElement>("[data-returns-reason]")
            ?.value ?? "",
        disposition:
          row.querySelector<HTMLSelectElement>("[data-returns-disposition]")
            ?.value ?? ""
      }));
    const readRefund = (): WizardRefund => {
      const mode = (dialog.querySelector<HTMLInputElement>(
        'input[name="refundMode"]:checked'
      )?.value ?? "original_tender") as WizardRefund["mode"];
      const drawer = dialog.querySelector<HTMLInputElement>(
        'input[name="fromDrawer"]'
      );
      return {
        mode,
        shippingRefund:
          dialog.querySelector<HTMLInputElement>('input[name="withShipping"]')
            ?.checked ?? false,
        registerSessionId: drawer?.checked ? drawer.value : null
      };
    };
    const shippingAmount = dialog.dataset.shippingAmount ?? null;
    const exchangeBox = dialog.querySelector<HTMLInputElement>(
      'input[name="exchange"]'
    );
    const noteField = dialog.querySelector<HTMLTextAreaElement>(
      'textarea[name="note"]'
    );

    const showStep = (n: number): void => {
      steps.forEach((el, index) => {
        el.hidden = index + 1 !== n;
      });
      if (back) back.hidden = n === 1;
      if (next) next.hidden = n === steps.length;
      if (submit) submit.hidden = n !== steps.length;
      if (n === steps.length) {
        fillReview();
        syncSubmit();
      }
    };
    const syncSubmit = (): void => {
      if (submit) submit.disabled = !(confirmBox?.checked ?? false);
    };
    confirmBox?.addEventListener("change", syncSubmit);

    const fillReview = (): void => {
      if (!review) return;
      review.replaceChildren();
      for (const line of readLines().filter((l) => l.quantity > 0)) {
        const row = lineRows.find((r) => r.dataset.itemId === line.orderItemId);
        const li = document.createElement("li");
        const name = row?.dataset.name ?? "";
        const reason =
          row?.querySelector<HTMLSelectElement>("[data-returns-reason]")
            ?.selectedOptions[0]?.textContent ?? line.reason;
        const disposition =
          row?.querySelector<HTMLSelectElement>("[data-returns-disposition]")
            ?.selectedOptions[0]?.textContent ?? line.disposition;
        li.textContent = `${line.quantity} × ${name} - ${reason} - ${disposition}`;
        review.appendChild(li);
      }
      const refund = readRefund();
      const li = document.createElement("li");
      li.textContent =
        refund.mode === "none"
          ? msg("textNoRefund")
          : refund.mode === "store_credit"
            ? msg("textStoreCredit")
            : msg("textOriginalTender");
      review.appendChild(li);
    };

    const validateStep = (n: number): boolean => {
      wizardError.clear();
      if (n === 1) {
        const problem = validateLines(readLines());
        if (problem) {
          wizardError.show(
            problem === "too_many"
              ? msg("msgQuantity")
              : problem === "incomplete"
                ? msg("msgIncomplete")
                : msg("msgNoneSelected")
          );
          return false;
        }
      }
      return true;
    };

    for (const opener of openers) {
      opener.addEventListener("click", () => {
        wizardError.clear();
        if (result) result.hidden = true;
        if (confirmBox) confirmBox.checked = false;
        // One key per open: a retry of the SAME attempt replays, never records twice.
        dialog.dataset.idempotencyKey = crypto.randomUUID();
        showStep(1);
        dialog.showModal();
      });
    }
    back?.addEventListener("click", () => showStep(Math.max(1, stepOf() - 1)));
    next?.addEventListener("click", () => {
      const n = stepOf();
      if (validateStep(n)) showStep(Math.min(steps.length, n + 1));
    });
    dialog
      .querySelector<HTMLButtonElement>("[data-returns-cancel]")
      ?.addEventListener("click", () => dialog.close());

    submit?.addEventListener("click", async () => {
      if (!validateStep(1) || !(confirmBox?.checked ?? false)) return;
      wizardError.clear();
      const unlock = lockElement(submit, msg("busyLabel"));
      try {
        const body = buildReturnPayload({
          lines: readLines(),
          refund: readRefund(),
          exchange: exchangeBox?.checked ?? false,
          note: noteField?.value ?? "",
          shippingAmount
        });
        const { ok, errorCode, data } = await sendJsonForData<{
          storeCredit?: { code?: string | null } | null;
        }>(
          "POST",
          `/api/v1/commerce/orders/${encodeURIComponent(orderId)}/returns`,
          body,
          {
            "Idempotency-Key":
              dialog.dataset.idempotencyKey ?? crypto.randomUUID()
          }
        );
        if (!ok) {
          wizardError.show(errorText(errorCode));
          return;
        }
        const code = data?.storeCredit?.code ?? null;
        if (code && result && creditCode) {
          // The only moment the store-credit code exists in plaintext.
          creditCode.textContent = code;
          result.hidden = false;
          steps.forEach((el) => {
            el.hidden = true;
          });
          if (back) back.hidden = true;
          if (next) next.hidden = true;
          if (submit) submit.hidden = true;
          dialog.addEventListener("close", () => window.location.reload(), {
            once: true
          });
          return;
        }
        window.location.reload();
      } finally {
        unlock();
      }
    });
  }

  // --- send an open refund leg to the payment provider ----------------------
  panel.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest<HTMLButtonElement>("[data-refund-execute]");
    if (!button) return;
    error.clear();
    if (!(await confirmFromTrigger(button))) return;
    const unlock = lockElement(button, msg("busyLabel"));
    try {
      const drawer = panel.querySelector<HTMLInputElement>(
        'input[name="executeFromDrawer"]'
      );
      const { ok, errorCode } = await sendJsonForData(
        "POST",
        `/api/v1/commerce/returns/${encodeURIComponent(button.dataset.returnId ?? "")}/refunds/${encodeURIComponent(button.dataset.refundId ?? "")}/execute`,
        { registerSessionId: drawer?.checked ? drawer.value : null },
        { "Idempotency-Key": crypto.randomUUID() }
      );
      if (!ok) {
        error.show(errorText(errorCode));
        return;
      }
      window.location.reload();
    } finally {
      unlock();
    }
  });
}
