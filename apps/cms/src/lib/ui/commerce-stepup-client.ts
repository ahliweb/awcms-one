/**
 * Step-up re-authentication for the commerce admin screens that need it (Issue
 * #381, ADR-0045 D10): the refund override and the cancellation-policy approval.
 *
 * `STEP_UP_REQUIRED` is not an error to report, it is a prompt (the account
 * screen's reasoning): the high-risk call is refused with nothing written, the
 * operator proves a second factor, and the SAME request is sent again once. The
 * prompt is a native `<dialog>` (`CommerceStepUpDialog.astro`), never
 * `window.prompt`. A cancelled prompt or a refused code changes nothing and
 * leaves the form as it was.
 */
import { sendJson, type MutationOutcome } from "./admin-form-client";

export const STEP_UP_CANCELLED = "STEP_UP_CANCELLED";
export const STEP_UP_FAILED = "STEP_UP_FAILED";

/** Opens the step-up dialog and resolves with the typed code, or `null` when cancelled. */
export function promptStepUpCode(dialogId: string): Promise<string | null> {
  const dialog = document.getElementById(dialogId);
  if (!(dialog instanceof HTMLDialogElement)) return Promise.resolve(null);
  const input = dialog.querySelector<HTMLInputElement>("input[name='code']");
  const confirm = dialog.querySelector<HTMLButtonElement>(
    "[data-stepup-confirm]"
  );
  const cancel = dialog.querySelector<HTMLButtonElement>(
    "[data-stepup-cancel]"
  );
  if (!input || !confirm || !cancel) return Promise.resolve(null);

  return new Promise((resolve) => {
    input.value = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      confirm.removeEventListener("click", onConfirm);
      cancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onCancel);
      input.removeEventListener("keydown", onKey);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onConfirm = (): void => {
      const code = input.value.trim();
      if (code.length === 0) {
        input.focus();
        return;
      }
      finish(code);
    };
    const onCancel = (): void => finish(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      }
    };
    confirm.addEventListener("click", onConfirm);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onCancel);
    input.addEventListener("keydown", onKey);
    dialog.showModal();
    input.focus();
  });
}

/**
 * Sends the request; on `STEP_UP_REQUIRED` asks for a code, verifies it, and
 * sends the request again once. The same `Idempotency-Key` header inside `send`
 * makes the second attempt safe.
 */
export async function sendWithStepUp(
  send: () => Promise<MutationOutcome>,
  askCode: () => Promise<string | null>
): Promise<MutationOutcome> {
  const first = await send();
  if (first.ok || first.errorCode !== "STEP_UP_REQUIRED") return first;

  const code = await askCode();
  if (code === null) return { ok: false, errorCode: STEP_UP_CANCELLED };

  const verified = await sendJson("POST", "/api/v1/auth/mfa/step-up", { code });
  if (!verified.ok) return { ok: false, errorCode: STEP_UP_FAILED };

  return send();
}
