/**
 * `CommerceSettingsSaveBar`'s optional client half (Issue #244) — see
 * `../../components/CommerceSettingsSaveBar.astro` for the markup and why
 * the bar is ALWAYS rendered rather than hidden until a field changes.
 *
 * This module adds exactly the VISUAL distinction between "nothing changed
 * yet" and "there is something to save" — a class toggle on the bar and, if
 * the caller renders a `status` slot element with an id, a text swap — and
 * nothing else. It never hides or disables the bar's own Save/Reset
 * buttons: both already work with no JavaScript at all, and this module's
 * absence (or failure) must never take that away.
 *
 * Wiring is entirely through `data-*` attributes the component already
 * writes (`data-commerce-save-bar`, `data-commerce-save-bar-form`), so a
 * page adopting `CommerceSettingsSaveBar` needs only one call:
 *
 * ```ts
 * import { initCommerceSettingsSaveBars } from "../../lib/ui/commerce-settings-save-bar-client";
 * initCommerceSettingsSaveBars();
 * ```
 *
 * Optionally pass the ids of the status text elements and their two labels
 * via `data-dirty-label`/`data-clean-label` on the SAME element the
 * `status` slot renders (this module never invents copy — a screen that
 * wants the text to change supplies both strings, already translated).
 *
 * ## Deliberately no `beforeunload` warning
 *
 * This module does not attach a `beforeunload` listener, even though the
 * issue left that decision open. Two reasons:
 *
 * 1. `setDirty` only ever hears `input`/`change`/`reset` on the tracked
 *    form — it has no signal for "the async `fetch` this page's own submit
 *    handler sent actually succeeded" (that lives entirely in the page's
 *    own script, in `commerce-settings.astro`'s case a manual
 *    `sendJson(...)` call, not this module). A `beforeunload` guard keyed
 *    off `is-dirty` would therefore still warn "you have unsaved changes"
 *    immediately after a successful save, since nothing here ever clears
 *    the flag except a native `reset` — a false positive that is worse
 *    than no warning, because it teaches the operator to distrust a warning
 *    that fires even when they just watched the page confirm "Saved.".
 * 2. Both settings forms on `commerce-settings.astro` already show an
 *    in-place success/error message immediately after submit (no page
 *    reload), so the operator already gets a clear, in-context signal that
 *    their edit was saved — the accessibility gap a navigation guard exists
 *    to cover is smaller here than on a form that discards feedback on
 *    reload.
 *
 * Fixing (1) properly would mean widening this module's contract with a
 * "mark this bar clean again" export the page calls from its own fetch
 * success path — a real option, but beyond what Issue #244 asked for. If a
 * future screen genuinely needs a leave-guard, add that export first rather
 * than wiring `beforeunload` to a flag that can already be stale.
 */

/** Selector for every bar this module wires. Matches the component's own attribute. */
export const SAVE_BAR_SELECTOR = "[data-commerce-save-bar]";

/** The class this module toggles once a tracked form changes. Purely presentational — see the component docblock. */
export const DIRTY_CLASS = "is-dirty";

/**
 * Whichever of the two status labels applies right now. Pure — exported so a
 * test can drive it without a fake `document`.
 */
export function resolveStatusText(
  isDirty: boolean,
  dirtyLabel: string | undefined,
  cleanLabel: string | undefined
): string | null {
  return (isDirty ? dirtyLabel : cleanLabel) ?? null;
}

function wireOne(bar: HTMLElement): void {
  const formId = bar.dataset.commerceSaveBarForm;
  if (!formId) return;

  const form = document.getElementById(formId);
  if (!(form instanceof HTMLFormElement)) return;

  const status = bar.querySelector<HTMLElement>(
    ".commerce-save-bar-status [id]"
  );
  const dirtyLabel = status?.dataset.dirtyLabel;
  const cleanLabel = status?.dataset.cleanLabel;

  function setDirty(isDirty: boolean): void {
    bar.classList.toggle(DIRTY_CLASS, isDirty);

    if (!status) return;
    const text = resolveStatusText(isDirty, dirtyLabel, cleanLabel);
    if (text !== null) status.textContent = text;
  }

  form.addEventListener("input", () => setDirty(true));
  form.addEventListener("change", () => setDirty(true));
  form.addEventListener("reset", () => setDirty(false));
}

/** Wires every `CommerceSettingsSaveBar` on the page. Safe to call once per page load; does nothing when none is present. */
export function initCommerceSettingsSaveBars(): void {
  for (const bar of document.querySelectorAll<HTMLElement>(SAVE_BAR_SELECTOR)) {
    wireOne(bar);
  }
}

/**
 * The Save button of a `CommerceSettingsSaveBar` for `formId`, found by its
 * `data-commerce-save-bar-form` attribute rather than as a descendant of
 * the form — it sits OUTSIDE the form's own markup, reaching it only via
 * its `form` attribute (see the component's own docblock), so a lookup
 * like `form.querySelector('button[type="submit"]')` never finds it.
 *
 * `commerce-settings.astro`'s two settings forms each call this once, in
 * place of the `document.getElementById("...-submit")` lookup their inline
 * buttons used before this bar replaced them, to lock the right button
 * while their request is in flight.
 */
export function commerceSaveBarButton(
  formId: string
): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    `[data-commerce-save-bar-form="${formId}"] .commerce-save-bar-save`
  );
}
