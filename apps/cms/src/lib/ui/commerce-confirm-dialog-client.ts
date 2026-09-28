/**
 * Client-side driver for `CommerceConfirmDialog.astro` (Issue #242).
 *
 * Ports the idea of LK's (media-lenterakalteng) `initConfirmDialog` —
 * `apps/cms/src/lib/ui/admin-form-client.ts` L563-599 there — into this repo
 * as its OWN commerce-owned module, not an edit to upstream's
 * `admin-form-client.ts` (see root `AGENTS.md`'s "The subtree embed": that
 * file is `ahliweb/awcms`'s own tree, carried here via `git subtree`, and a
 * local edit to it is exactly the kind of change a future `git subtree pull`
 * would conflict with or silently overwrite).
 *
 * LK's version returns a bound `(message: string) => Promise<boolean>` from
 * an `initConfirmDialog(dialogId)` call a page makes once. This module is
 * shaped differently on purpose, because issue #246 (order-status change,
 * downstream of this one) needs a SECOND variant — the same dialog, but with
 * an optional note field — and LK has no such variant to copy. So instead of
 * one `init` call returning one closure, every call site calls
 * `confirmCommerceAction`/`confirmCommerceActionWithNote` directly, passing
 * the dialog's id (defaulted, so ten of this issue's eleven call sites never
 * need to say it). Nothing is cached at module scope between calls — each
 * call re-queries the DOM, attaches its own listeners, and removes them
 * before resolving, so two calls in a row (or two different dialogs on the
 * same page) cannot leak state into each other.
 *
 * ## The `data-confirm-*` trigger contract
 *
 * `confirmCommerceAction`/`confirmCommerceActionWithNote` are still the
 * primitive, but no screen calls either one directly with a literal
 * `{ title, message, confirmLabel }` — that would put an untranslated
 * English sentence in a `<script>`, exactly the defect this dialog exists to
 * remove, just moved from a `window.confirm(...)` argument to an options
 * object. Instead every screen's trigger element (the delete/send/cancel/…
 * button) carries its own `t()`-translated `data-confirm-title`/
 * `-message`/`-label`/`-danger` attributes, rendered SERVER-side with any
 * per-row value (a SKU, a name, a code) already interpolated into the
 * message by the catalogue's own `{placeholder}` syntax — see
 * `CommerceConfirmDialog.astro`'s docblock for the attribute names.
 * `confirmFromTrigger(el)` reads them back and is the ONLY thing a screen's
 * `<script>` calls; `readConfirmOptions` is the pure half of that read,
 * kept separate so it is unit-testable with a plain object standing in for
 * `HTMLElement.dataset`.
 *
 * ## Why `showModal()`
 *
 * It supplies the focus trap, the Escape-to-cancel handler (fired as the
 * dialog's own `cancel` event), the inertness of the rest of the page while
 * open, the `::backdrop`, and native support for returning focus to whatever
 * had focus before `showModal()` was called. None of that is code this
 * module has to own — see `admin-command-palette.ts`'s header comment for the
 * fuller case against hand-rolling any of it. This module still calls
 * `.focus()` explicitly once the dialog is open, because the browser's own
 * default (the first focusable element in DOM order, which is always the
 * Cancel button here) does not match this contract for a NON-danger action —
 * see `resolveFocusTarget` below.
 *
 * ## The `window.confirm` fallback (the one permitted reference)
 *
 * `HTMLDialogElement`/`showModal()` is supported by every browser this admin
 * targets, and the dialog markup ships on every commerce screen that calls
 * these functions (`CommerceConfirmDialog.astro`, rendered once per page).
 * The fallback below exists for the one case those two facts do not cover: a
 * caller that renders NO `CommerceConfirmDialog` on the page (a bug — a
 * missing render, not a missing browser feature, in practice) or an
 * environment where `HTMLDialogElement` genuinely is not `showModal`-capable.
 * Silently resolving `false`/`null` in that case would make a destructive
 * button do nothing with no feedback at all, which is worse than the
 * synchronous, unstyled, but FUNCTIONING native confirm this issue is
 * otherwise removing every other reference to. This is therefore the only
 * `window.confirm` call left anywhere in this codebase's commerce surface —
 * `commerce-confirm-dialog.test.ts` asserts no OTHER file has one.
 */

/** The id `CommerceConfirmDialog.astro` defaults to when a caller omits `dialogId`. */
export const DEFAULT_DIALOG_ID = "commerce-confirm-dialog";

/** The note's default character ceiling when `noteMaxLength` is omitted. */
export const DEFAULT_NOTE_MAX_LENGTH = 500;

export interface ConfirmCommerceActionOptions {
  /** Defaults to the dialog's own `data-default-title` (translated "Confirm action"). */
  title?: string;
  /** Required — the sentence a caller previously passed to `window.confirm(...)`. */
  message: string;
  /** Defaults to the dialog's own `data-default-confirm-label` (translated "Confirm"). */
  confirmLabel?: string;
  /** Styles the Confirm button as destructive and focuses Cancel first. Default `false`. */
  danger?: boolean;
  /** Which `CommerceConfirmDialog` to drive, when a page renders more than one. */
  dialogId?: string;
}

export interface ConfirmCommerceActionWithNoteOptions extends ConfirmCommerceActionOptions {
  /** Required — the note field is optional to FILL, never optional to LABEL. */
  noteLabel: string;
  /** Character ceiling for the trimmed note. Default `DEFAULT_NOTE_MAX_LENGTH` (500). */
  noteMaxLength?: number;
  /** Textarea placeholder. Default none. */
  notePlaceholder?: string;
}

/* -------------------------------------------------------------------- */
/* Pure helpers — no DOM, unit-tested directly.                         */
/* -------------------------------------------------------------------- */

/** Falls back to `DEFAULT_DIALOG_ID` for `undefined`/empty/whitespace-only ids. */
export function resolveDialogId(dialogId: string | undefined): string {
  const trimmed = dialogId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_DIALOG_ID;
}

/**
 * Falls back to `DEFAULT_NOTE_MAX_LENGTH` for anything that is not a finite,
 * positive number — including `undefined`, `NaN`, `0`, and negative values —
 * and floors a fractional one, since a textarea's `maxLength` is an integer.
 */
export function resolveNoteMaxLength(
  noteMaxLength: number | undefined
): number {
  return Number.isFinite(noteMaxLength) && (noteMaxLength as number) > 0
    ? Math.floor(noteMaxLength as number)
    : DEFAULT_NOTE_MAX_LENGTH;
}

/**
 * Trims the raw textarea value and clamps it to `maxLength` — the same
 * "blank becomes `''`, never `null`/`undefined`" contract the note is
 * documented to have, since the note is OPTIONAL and a caller should never
 * need to null-check it before deciding whether to send it.
 */
export function normalizeNote(
  rawValue: string,
  noteMaxLength: number | undefined
): string {
  const trimmed = rawValue.trim();
  const max = resolveNoteMaxLength(noteMaxLength);
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A custom label wins when non-blank; otherwise the caller's own fallback. */
export function resolveLabel(
  custom: string | undefined,
  fallback: string
): string {
  const trimmed = custom?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

/**
 * Which button gets focus once the dialog is open. A `danger` action focuses
 * the SAFE control (Cancel) so a stray Enter/Space cannot fire the
 * destructive one; a non-`danger` action (e.g. "Send campaign") focuses
 * Confirm, matching the ordinary dialog convention of focusing the expected
 * next step.
 */
export function resolveFocusTarget(
  danger: boolean | undefined
): "cancel" | "confirm" {
  return danger === true ? "cancel" : "confirm";
}

/** True when this browser can actually open a `<dialog>` modally. */
export function isDialogSupported(): boolean {
  return (
    typeof HTMLDialogElement !== "undefined" &&
    typeof HTMLDialogElement.prototype?.showModal === "function"
  );
}

/* -------------------------------------------------------------------- */
/* DOM-dependent — not unit-tested directly; exercised via the two       */
/* public functions below, which real pages call from a real browser.    */
/* -------------------------------------------------------------------- */

interface DialogHandles {
  dialog: HTMLDialogElement;
  title: HTMLElement;
  message: HTMLElement;
  noteField: HTMLElement;
  noteLabel: HTMLLabelElement;
  noteInput: HTMLTextAreaElement;
  cancelButton: HTMLButtonElement;
  confirmButton: HTMLButtonElement;
}

function getDialogHandles(dialogId: string): DialogHandles | null {
  const dialog = document.getElementById(dialogId);
  const title = document.getElementById(`${dialogId}-title`);
  const message = document.getElementById(`${dialogId}-message`);
  const noteField = document.getElementById(`${dialogId}-note-field`);
  const noteLabel = document.getElementById(`${dialogId}-note-label`);
  const noteInput = document.getElementById(`${dialogId}-note`);
  const cancelButton = document.getElementById(`${dialogId}-cancel`);
  const confirmButton = document.getElementById(`${dialogId}-confirm`);

  if (
    !(dialog instanceof HTMLDialogElement) ||
    !title ||
    !message ||
    !noteField ||
    !(noteLabel instanceof HTMLLabelElement) ||
    !(noteInput instanceof HTMLTextAreaElement) ||
    !(cancelButton instanceof HTMLButtonElement) ||
    !(confirmButton instanceof HTMLButtonElement)
  ) {
    return null;
  }

  return {
    dialog,
    title,
    message,
    noteField,
    noteLabel,
    noteInput,
    cancelButton,
    confirmButton
  };
}

interface NoteRequest {
  label: string;
  maxLength: number | undefined;
  placeholder: string | undefined;
}

interface OpenResult {
  confirmed: boolean;
  note: string;
}

/** Shared open/resolve lifecycle behind both public functions below. */
function openConfirmDialog(
  opts: ConfirmCommerceActionOptions,
  note: NoteRequest | null
): Promise<OpenResult> {
  const dialogId = resolveDialogId(opts.dialogId);
  const handles = isDialogSupported() ? getDialogHandles(dialogId) : null;

  if (!handles) {
    // The only permitted remaining `window.confirm` reference in this
    // codebase's commerce surface — see this file's header comment for why.
    return Promise.resolve({
      confirmed: window.confirm(opts.message),
      note: ""
    });
  }

  const {
    dialog,
    title,
    message,
    noteField,
    noteLabel,
    noteInput,
    cancelButton,
    confirmButton
  } = handles;

  // A call arriving while the dialog is already open (should not happen —
  // `onAction`'s click delegation already skips a disabled button — but a
  // defensive reset here is cheaper than an `InvalidStateError` from
  // `showModal()` on an already-open dialog) closes the stale instance first.
  if (dialog.open) {
    dialog.close();
  }

  return new Promise((resolve) => {
    let settled = false;

    const danger = opts.danger === true;

    title.textContent = resolveLabel(
      opts.title,
      dialog.dataset.defaultTitle ?? ""
    );
    message.textContent = opts.message;
    cancelButton.textContent =
      dialog.dataset.defaultCancelLabel ?? cancelButton.textContent ?? "";
    confirmButton.textContent = resolveLabel(
      opts.confirmLabel,
      dialog.dataset.defaultConfirmLabel ?? ""
    );

    confirmButton.classList.toggle("btn-danger", danger);
    confirmButton.classList.toggle("btn-danger--solid", danger);
    confirmButton.classList.toggle("btn-primary", !danger);

    // Reset every open — no state carried over from a previous call.
    noteInput.value = "";
    if (note) {
      noteLabel.textContent = note.label;
      noteInput.maxLength = resolveNoteMaxLength(note.maxLength);
      noteInput.placeholder = note.placeholder ?? "";
      noteField.hidden = false;
    } else {
      noteField.hidden = true;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    function settle(result: OpenResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    function onConfirmClick(): void {
      settle({
        confirmed: true,
        note: note ? normalizeNote(noteInput.value, note.maxLength) : ""
      });
    }

    function onCancelClick(): void {
      settle({ confirmed: false, note: "" });
    }

    function onDialogCancel(): void {
      // Fired by Escape (and by the browser's own cancel handling) — same
      // outcome as clicking Cancel.
      onCancelClick();
    }

    function cleanup(): void {
      confirmButton.removeEventListener("click", onConfirmClick);
      cancelButton.removeEventListener("click", onCancelClick);
      dialog.removeEventListener("cancel", onDialogCancel);
      if (dialog.open) {
        dialog.close();
      }
    }

    confirmButton.addEventListener("click", onConfirmClick);
    cancelButton.addEventListener("click", onCancelClick);
    dialog.addEventListener("cancel", onDialogCancel);

    // Runs once regardless of HOW the dialog closed (Confirm, Cancel, Escape,
    // or the defensive `dialog.close()` above) — `showModal()`'s own focus
    // restoration already returns focus to the element that was focused
    // before it was called, but that element is exactly `opener` here, so
    // this only needs to cover the case where that element has since left
    // the document (e.g. the row it belonged to was removed).
    dialog.addEventListener(
      "close",
      () => {
        if (opener && document.contains(opener)) {
          opener.focus();
        }
      },
      { once: true }
    );

    dialog.showModal();
    (resolveFocusTarget(danger) === "cancel"
      ? cancelButton
      : confirmButton
    ).focus();
  });
}

/**
 * Replaces a plain `window.confirm(message)` call. Resolves `true` only when
 * Confirm was clicked; Cancel, Escape, and the dialog's own `cancel` event
 * all resolve `false` — the same three-way behaviour `window.confirm` had,
 * minus the second and third being indistinguishable from "confirmed" only
 * by their return value already being `false`.
 */
export function confirmCommerceAction(
  opts: ConfirmCommerceActionOptions
): Promise<boolean> {
  return openConfirmDialog(opts, null).then((result) => result.confirmed);
}

/**
 * The note variant issue #246 (order-status change) consumes: same dialog,
 * plus an optional note field. Resolves `null` on cancel — never a `{ note }`
 * with a meaningless value — so a caller cannot mistake "the operator
 * cancelled" for "the operator confirmed with a blank note" by forgetting to
 * check a boolean first. `note` is always trimmed and length-clamped, and is
 * `''` (never required, never `null`/`undefined`) when left blank.
 */
export function confirmCommerceActionWithNote(
  opts: ConfirmCommerceActionWithNoteOptions
): Promise<{ note: string } | null> {
  return openConfirmDialog(opts, {
    label: opts.noteLabel,
    maxLength: opts.noteMaxLength,
    placeholder: opts.notePlaceholder
  }).then((result) => (result.confirmed ? { note: result.note } : null));
}

/* -------------------------------------------------------------------- */
/* The `data-confirm-*` trigger contract — the ONLY route a screen's own */
/* `<script>` may reach `confirmCommerceAction` through (Issue #242       */
/* follow-up). No English literal may sit in a screen's `<script>` for   */
/* this: the title/message/label are `t()`-translated SERVER-side, once  */
/* per trigger element, into these attributes; the client only reads     */
/* them back. This is the same shape LK's `ReasonPanel` reads its own    */
/* `data-reason-*` attributes through.                                   */
/* -------------------------------------------------------------------- */

/**
 * The `data-confirm-*` attributes a trigger element carries, rendered
 * server-side by the page that owns it (already translated, already
 * per-row-interpolated where the message names a specific resource).
 *
 * `confirmDanger` is the STRING `"true"` when present, matching how HTML
 * data attributes are always strings — never a boolean the DOM cannot
 * actually hold. Astro omits the attribute entirely for a non-danger
 * trigger (`data-confirm-danger={danger ? "true" : undefined}`), so its
 * absence here means "not danger", not "unspecified".
 */
export interface ConfirmTriggerDataset {
  confirmTitle?: string;
  confirmMessage?: string;
  confirmLabel?: string;
  confirmDanger?: string;
  confirmDialogId?: string;
  /**
   * The note variant's own three attributes (Issue #246) — additive to this
   * interface, and ignored by {@link readConfirmOptions}/{@link confirmFromTrigger}
   * exactly as any other unknown dataset key already is, so no existing
   * caller's behaviour changes by these three fields existing.
   */
  confirmNoteLabel?: string;
  confirmNoteMaxLength?: string;
  confirmNotePlaceholder?: string;
}

/**
 * Pure: maps a trigger's own dataset onto `confirmCommerceAction`'s options,
 * with no DOM involved — this is what `commerce-confirm-dialog.test.ts`
 * exercises directly. A missing `confirmMessage` degrades to an empty
 * string rather than throwing, the same "malformed markup does nothing
 * catastrophic" convention `onAction`/`getDialogHandles` already follow —
 * it is a wiring bug for the screen that forgot the attribute, not
 * something this reader can fix.
 */
export function readConfirmOptions(
  dataset: ConfirmTriggerDataset
): ConfirmCommerceActionOptions {
  return {
    title: dataset.confirmTitle,
    message: dataset.confirmMessage ?? "",
    confirmLabel: dataset.confirmLabel,
    danger: dataset.confirmDanger === "true",
    dialogId: dataset.confirmDialogId
  };
}

/**
 * The screen-facing entry point for a `data-confirm-*`-carrying trigger.
 * Every one of this issue's ten screens calls this instead of building an
 * options object by hand — which is exactly what keeps a translated string
 * from ever being typed as an English literal inside a `<script>` again.
 */
export function confirmFromTrigger(el: HTMLElement): Promise<boolean> {
  return confirmCommerceAction(readConfirmOptions(el.dataset));
}

/**
 * The note variant of {@link readConfirmOptions} (Issue #246, order-status
 * change) — same pure reader, extended with the three `data-confirm-note-*`
 * attributes. `confirmNoteMaxLength` is read as a string (every dataset
 * value is) and parsed with `Number`; a missing or non-numeric attribute
 * degrades to `undefined`, which `confirmCommerceActionWithNote` already
 * treats as "use `DEFAULT_NOTE_MAX_LENGTH`" via {@link resolveNoteMaxLength}
 * — never a thrown error for a screen that omits the attribute.
 */
export function readConfirmOptionsWithNote(
  dataset: ConfirmTriggerDataset
): ConfirmCommerceActionWithNoteOptions {
  const parsedMaxLength = dataset.confirmNoteMaxLength
    ? Number(dataset.confirmNoteMaxLength)
    : undefined;

  return {
    ...readConfirmOptions(dataset),
    noteLabel: dataset.confirmNoteLabel ?? "",
    noteMaxLength: Number.isFinite(parsedMaxLength)
      ? parsedMaxLength
      : undefined,
    notePlaceholder: dataset.confirmNotePlaceholder
  };
}

/**
 * The note variant of {@link confirmFromTrigger}. Not used by
 * `commerce-orders.astro` directly — that screen's message needs a
 * client-side `{to}` substitution and a dynamically-computed `danger` flag
 * before the dialog opens, so it calls {@link readConfirmOptionsWithNote} and
 * {@link confirmCommerceActionWithNote} itself rather than through this
 * wrapper. Exported anyway, symmetrically with {@link confirmFromTrigger},
 * for a future note-taking trigger whose options need no such adjustment.
 */
export function confirmFromTriggerWithNote(
  el: HTMLElement
): Promise<{ note: string } | null> {
  return confirmCommerceActionWithNote(readConfirmOptionsWithNote(el.dataset));
}
