/**
 * The ad popup (issue #53, A7) — a reader who clicks an ad creative
 * (`src/components/berita/IklanSlot.astro`'s `[data-iklan-popup]` trigger)
 * sees the creative at its natural size in one shared native `<dialog>`,
 * with the advertiser's name, the editorial-disclosure label, and a
 * "Buka iklan" CTA to the real destination — ported from seputarborneo's
 * `js/main.js` `initAdPopup()`, minus jQuery and minus the hand-rolled
 * modal: `<dialog>.showModal()` already gives focus trapping, `Escape`
 * (the `cancel` event), an inert page behind it, and the `::backdrop`.
 *
 * Mounted ONCE from `src/layouts/BeritaLayout.astro` (the shell every
 * news-surface page renders through), the same way `BaseLayout.astro`
 * mounts `analitik.ts`: an ordinary Astro-bundled external module, never
 * an inline `<script>` — `script-src 'self'` (`server/penyaji.mjs`) has no
 * `'unsafe-inline'`. Ad slots live on article pages, `/berita`'s header and
 * sidebar, and (issue #49's `Sidebar.astro`) any page aside, so a single
 * document-level delegated `click` listener is the only wiring that covers
 * every slot without each page having to know this module exists.
 *
 * ## Progressive enhancement, stated as three concrete cases
 *
 * - **No JavaScript**: nothing here runs. A linked creative is a plain
 *   `<a href rel="noopener noreferrer sponsored" target="_blank">` and
 *   navigates normally; an unlinked creative is an inert `<button>` around
 *   the image — identical to the non-interactive `<img>` it replaced.
 * - **No `<dialog>` support** (`showModal` missing): this module returns
 *   before attaching anything, for the same reason.
 * - **A modified click** (Ctrl/Cmd/Shift/Alt, or a middle button) on a
 *   LINKED creative is left to the browser — "open in a new tab" keeps
 *   working, the popup only intercepts a plain primary click.
 *
 * ## Why the dialog is built here rather than rendered in the layout
 *
 * The markup only has a purpose once this script runs; rendering it
 * server-side would ship a hidden dialog on every news page (and a second
 * copy of every string below) for readers whose browser never opens it.
 * Built lazily on the FIRST click, appended once to `<body>`, and reused
 * for every subsequent creative — one `#iklan-popup` per page, exactly like
 * the reference's one `#adPopup`.
 *
 * ## Why the CTA re-validates the href
 *
 * `IklanSlot.astro` renders `linkUrl` straight from the CMS (issue #28).
 * This module never trusts that string into a NEW `href` unchecked:
 * anything that is not an absolute `http(s)` URL is treated exactly like a
 * missing destination (CTA hidden, "Iklan ini belum memiliki tautan
 * tujuan"). The same posture `IklanSlot.astro` already takes with
 * `mediaPublicUrl` — the storefront's rule that only `http(s)` URLs from
 * CMS data ever render as links.
 */

export const DIALOG_ID = "iklan-popup";
export const BODY_OPEN_CLASS = "iklan-popup-open";
export const NO_LINK_MESSAGE = "Iklan ini belum memiliki tautan tujuan";
export const CTA_LABEL = "Buka iklan";
export const CLOSE_LABEL = "Tutup popup iklan";
/** The label shown when the trigger carries none — `IklanSlot.astro` always sets one, this is the last-resort default. */
export const DEFAULT_LABEL = "Iklan";

/** Everything the popup shows, read from one trigger — pure data, so it is testable with no DOM. */
export type IklanPopupData = {
  imageUrl: string;
  imageAlt: string;
  name: string;
  label: string;
  /** `null` when the creative has no (valid `http(s)`) destination. */
  href: string | null;
  /** The already-loaded creative's intrinsic size, when the browser knows it — `null` otherwise (not yet loaded, broken, or a `<button>` trigger before its image resolved). */
  naturalSize: { width: number; height: number } | null;
};

/** `value` if it parses as an absolute `http(s)` URL, else `null` — see this file's docblock. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** True for a click the browser should keep for itself (new tab/window, download) — the popup only intercepts a plain primary click on a link. */
export function isModifiedClick(event: {
  button?: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  return (
    (event.button ?? 0) !== 0 ||
    Boolean(event.ctrlKey) ||
    Boolean(event.metaKey) ||
    Boolean(event.shiftKey) ||
    Boolean(event.altKey)
  );
}

/**
 * Reads one trigger's data. `null` when the trigger has no creative image
 * at all — a text-only ad (no resolvable `mediaPublicUrl`) has nothing to
 * enlarge, and `IklanSlot.astro` never marks one as a trigger anyway.
 */
export function readTrigger(trigger: HTMLElement): IklanPopupData | null {
  const image = trigger.querySelector("img");
  if (!image) return null;

  const imageUrl = image.currentSrc || image.getAttribute("src") || "";
  if (!imageUrl) return null;

  const name = trigger.dataset.iklanNama?.trim() || image.alt || DEFAULT_LABEL;
  const label = trigger.dataset.iklanLabel?.trim() || DEFAULT_LABEL;
  const href = trigger instanceof HTMLAnchorElement ? safeHttpUrl(trigger.getAttribute("href")) : null;

  const naturalSize =
    image.complete && image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;

  return { imageUrl, imageAlt: image.alt || name, name, label, href, naturalSize };
}

type PopupElements = {
  dialog: HTMLDialogElement;
  label: HTMLElement;
  name: HTMLElement;
  image: HTMLImageElement;
  status: HTMLElement;
  cta: HTMLAnchorElement;
  close: HTMLButtonElement;
};

/**
 * Builds the one shared dialog. Every node is created with `createElement`
 * and every string set through `textContent` — none of the ad's own data
 * (name, alt text, URL) ever passes through `innerHTML`.
 */
export function buildDialog(doc: Document): PopupElements {
  const dialog = doc.createElement("dialog");
  dialog.id = DIALOG_ID;
  dialog.className = "iklan-popup";
  dialog.setAttribute("aria-labelledby", `${DIALOG_ID}-judul`);

  // The body wrapper fills the dialog (padding lives on IT, not the
  // `<dialog>`), so a click whose target is the `<dialog>` element itself
  // can only have landed on the `::backdrop` — see `onDialogClick`.
  const body = doc.createElement("div");
  body.className = "iklan-popup-body";

  const header = doc.createElement("div");
  header.className = "iklan-popup-header";

  const label = doc.createElement("span");
  label.className = "iklan-popup-label";
  label.setAttribute("data-iklan-popup-label", "");

  const close = doc.createElement("button");
  close.type = "button";
  close.className = "iklan-popup-close";
  close.setAttribute("data-iklan-popup-close", "");
  close.setAttribute("aria-label", CLOSE_LABEL);
  close.textContent = "×";

  header.append(label, close);

  const name = doc.createElement("h2");
  name.id = `${DIALOG_ID}-judul`;
  name.className = "iklan-popup-name";
  name.setAttribute("data-iklan-popup-name", "");

  const figure = doc.createElement("figure");
  figure.className = "iklan-popup-figure";
  const image = doc.createElement("img");
  image.className = "iklan-popup-image";
  image.setAttribute("data-iklan-popup-image", "");
  image.decoding = "async";
  figure.append(image);

  const status = doc.createElement("p");
  status.className = "iklan-popup-status";
  status.setAttribute("data-iklan-popup-status", "");
  status.textContent = NO_LINK_MESSAGE;
  status.hidden = true;

  const actions = doc.createElement("p");
  actions.className = "iklan-popup-actions";
  const cta = doc.createElement("a");
  cta.className = "button-primary iklan-popup-cta";
  cta.setAttribute("data-iklan-popup-cta", "");
  cta.target = "_blank";
  cta.rel = "sponsored noopener";
  cta.textContent = CTA_LABEL;
  actions.append(cta);

  body.append(header, name, figure, status, actions);
  dialog.append(body);

  return { dialog, label, name, image, status, cta, close };
}

/** Fills the shared dialog from one trigger's data — the "natural size" rule: intrinsic `width`/`height` when known (no layout jump while the cached image paints), otherwise none, and CSS caps it at the viewport. */
export function applyData(elements: PopupElements, data: IklanPopupData): void {
  elements.label.textContent = data.label;
  elements.name.textContent = data.name;

  elements.image.alt = data.imageAlt;
  if (data.naturalSize) {
    elements.image.width = data.naturalSize.width;
    elements.image.height = data.naturalSize.height;
  } else {
    elements.image.removeAttribute("width");
    elements.image.removeAttribute("height");
  }
  elements.image.src = data.imageUrl;

  if (data.href) {
    elements.cta.href = data.href;
    elements.cta.hidden = false;
    elements.status.hidden = true;
  } else {
    elements.cta.removeAttribute("href");
    elements.cta.hidden = true;
    elements.status.hidden = false;
  }
}

/**
 * Wires the popup onto `doc`: one delegated `click` listener for every
 * present AND future `[data-iklan-popup]` trigger inside an `.ad-slot`.
 * Exported (rather than only run at import time) so a test can call it
 * against a document of its own; returns the lazily-built dialog accessor.
 */
export function initIklanPopup(doc: Document): { getDialog: () => HTMLDialogElement | null } {
  let elements: PopupElements | null = null;
  let lastTrigger: HTMLElement | null = null;

  function ensureDialog(): PopupElements {
    if (elements) return elements;
    elements = buildDialog(doc);
    const { dialog, close } = elements;

    close.addEventListener("click", () => dialog.close());

    // A click whose target is the `<dialog>` itself is a click on the
    // `::backdrop` — every real control sits inside `.iklan-popup-body`.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });

    // `close` fires for every way out — the ✕, the backdrop, `Escape` (the
    // browser's own `cancel` → `close`), and a programmatic `close()`. One
    // place to unlock scrolling and hand focus back to the trigger, so no
    // exit path can forget either.
    dialog.addEventListener("close", () => {
      doc.body.classList.remove(BODY_OPEN_CLASS);
      const trigger = lastTrigger;
      lastTrigger = null;
      if (trigger && trigger.isConnected) trigger.focus();
    });

    doc.body.append(dialog);
    return elements;
  }

  function open(trigger: HTMLElement, data: IklanPopupData): void {
    const popup = ensureDialog();
    applyData(popup, data);
    lastTrigger = trigger;
    doc.body.classList.add(BODY_OPEN_CLASS);
    if (!popup.dialog.open) popup.dialog.showModal();
    // `showModal()` focuses the first focusable control, which is the
    // label-less ✕ — explicit, so the first Tab from the close button
    // lands on the CTA (when there is one) rather than somewhere the
    // browser picked.
    popup.close.focus();
  }

  doc.addEventListener("click", (event) => {
    // Another handler already claimed this click — not this module's to
    // intercept.
    if (event.defaultPrevented) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const trigger = target.closest<HTMLElement>(".ad-slot [data-iklan-popup]");
    if (!trigger) return;

    if (trigger instanceof HTMLAnchorElement && isModifiedClick(event)) return;

    const data = readTrigger(trigger);
    if (!data) return;

    event.preventDefault();
    open(trigger, data);
  });

  return { getDialog: () => elements?.dialog ?? null };
}

/** `<dialog>.showModal` present — without it, the anchor is left to navigate normally (see this file's docblock). */
export function supportsDialog(win: { HTMLDialogElement?: unknown }): boolean {
  const ctor = win.HTMLDialogElement as { prototype?: { showModal?: unknown } } | undefined;
  return typeof ctor?.prototype?.showModal === "function";
}

if (typeof document !== "undefined" && typeof window !== "undefined" && supportsDialog(window)) {
  initIklanPopup(document);
}
