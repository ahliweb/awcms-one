/**
 * Client helpers for the booking adapter's admin screens (Issue #385,
 * `docs/booking-ux-flows.md` section 11). Pure functions with no DOM
 * dependency so `tests/commerce-booking-client.test.ts` asserts them directly;
 * {@link initDepositKindToggle} is the one DOM function.
 *
 * Nothing here is an authority: the server re-validates every field, and the
 * deposit amount is NEVER sent - only the policy ("30.00" percent, "50000.00"
 * per unit), from which the server computes the deposit.
 */

export type DepositPolicyBody =
  | { kind: "full" }
  | { kind: "percent"; percent: string }
  | { kind: "fixed"; fixedAmount: string };

export type DepositFormResult =
  | { ok: true; body: DepositPolicyBody }
  | { ok: false; field: "percent" | "fixedAmount" | "kind" };

const PERCENT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Builds the `PUT .../deposit-policy` body from a form's raw values, or names the invalid field. */
export function buildDepositPolicyBody(
  kind: string,
  percentRaw: string,
  fixedRaw: string
): DepositFormResult {
  if (kind === "full") return { ok: true, body: { kind: "full" } };
  if (kind === "percent") {
    const percent = percentRaw.trim();
    if (
      !PERCENT_PATTERN.test(percent) ||
      Number(percent) <= 0 ||
      Number(percent) > 100
    ) {
      return { ok: false, field: "percent" };
    }
    return { ok: true, body: { kind: "percent", percent } };
  }
  if (kind === "fixed") {
    const fixedAmount = fixedRaw.trim();
    if (!AMOUNT_PATTERN.test(fixedAmount) || Number(fixedAmount) <= 0) {
      return { ok: false, field: "fixedAmount" };
    }
    return { ok: true, body: { kind: "fixed", fixedAmount } };
  }
  return { ok: false, field: "kind" };
}

/** Whether a string is a canonical uuid (the offering and product ids the link form takes). */
export function isUuidText(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

/**
 * Picks the message for a server error code from the JSON map a screen renders
 * server-side into `data-errors` (already translated), falling back to the
 * generic failure copy. A malformed map is treated as empty.
 */
export function pickRefusalMessage(
  errorsJson: string | undefined,
  errorCode: string | null,
  fallback: string
): string {
  if (!errorCode || !errorsJson) return fallback;
  try {
    const map = JSON.parse(errorsJson) as Record<string, unknown>;
    const message = map[errorCode];
    return typeof message === "string" && message.length > 0
      ? message
      : fallback;
  } catch {
    return fallback;
  }
}

/** A fresh `Idempotency-Key` for one submit attempt. */
export function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Shows only the percent or fixed field that matches the selected kind radio
 * and keeps the hidden one out of the tab order. Idempotent.
 */
export function initDepositKindToggle(form: HTMLFormElement): void {
  const radios = form.querySelectorAll<HTMLInputElement>(
    "input[type='radio'][name='kind']"
  );
  const apply = (): void => {
    const selected =
      [...radios].find((radio) => radio.checked)?.value ?? "full";
    for (const wrapper of form.querySelectorAll<HTMLElement>(
      "[data-deposit-for]"
    )) {
      const show = wrapper.dataset.depositFor === selected;
      wrapper.hidden = !show;
      for (const input of wrapper.querySelectorAll<HTMLInputElement>("input")) {
        input.disabled = !show;
      }
    }
  };
  for (const radio of radios) radio.addEventListener("change", apply);
  apply();
}

/**
 * Shows a status line after a reload and moves focus to it (Issue #448,
 * "Focus after reload"). A page reload drops focus to the top of the document and
 * a `role="status"` element that is un-hidden together with its text is not
 * reliably announced, so the line is also given focus: a screen reader reads the
 * focused text, and a keyboard user continues from the message instead of from
 * the page top. The element keeps `role="status"` (polite) for later updates.
 */
export function showStatusAndFocus(
  element: HTMLElement | null,
  message: string
): void {
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
  if (!element.hasAttribute("tabindex")) element.setAttribute("tabindex", "-1");
  element.focus();
}

/**
 * Marks one field invalid (`aria-invalid`, tied to its message through
 * `aria-describedby`) and moves focus to it, so a keyboard user lands on the
 * field the message is about. Pass `null` to clear the mark.
 */
export function markFieldInvalid(
  input: HTMLElement | null,
  invalid: boolean,
  messageId?: string
): void {
  if (!input) return;
  if (!invalid) {
    input.removeAttribute("aria-invalid");
    return;
  }
  input.setAttribute("aria-invalid", "true");
  if (messageId) {
    const ids = (input.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (!ids.includes(messageId)) ids.push(messageId);
    input.setAttribute("aria-describedby", ids.join(" "));
  }
  input.focus();
}
