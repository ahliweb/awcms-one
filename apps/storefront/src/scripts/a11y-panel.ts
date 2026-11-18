/**
 * Behaviour of the public reading-preferences panel (issue #539, ADR-0057;
 * markup in `src/components/A11yPanel.astro`, rules in `src/lib/
 * a11y-preferences.ts`, presentation in `src/styles/a11y.css`).
 *
 * A bundled same-origin module (`script-src 'self'`), mounted once from
 * `BaseLayout.astro`. `src/lib/a11y-early.js` (served by `src/pages/a11y-early.js.ts`) has already put the stored
 * choices on `<html>` before first paint; this script's job is the live half:
 *
 * - reveal the floating button (it is `hidden` without JavaScript, so a visitor
 *   without it is never offered a control that does nothing);
 * - open and close the non-modal dialog — the button toggles it, Escape and
 *   the close button close it and return focus to the button, a press outside
 *   closes it, and opening moves focus to its heading;
 * - show the effective preferences (stored, else the OS defaults) and write a
 *   change to `localStorage`, to the `<html>` attributes and to a
 *   `awcms-a11y-change` event, so script-driven motion elsewhere can react;
 * - reset: remove the key and every attribute, so the OS defaults apply again.
 *
 * Nothing is sent anywhere and no analytics event is recorded. Storage that
 * throws (private window, blocked cookies) degrades to "applies for this page
 * view only" — the panel still works, it just does not remember.
 */
import {
  A11Y_CHANGE_EVENT,
  A11Y_STORAGE_KEY,
  SWITCH_KEYS,
  TEXT_SIZES,
  applyPreferences,
  clearAppliedPreferences,
  clearStoredPreferences,
  readStoredPreferences,
  resolveEffectivePreferences,
  writeStoredPreferences,
  type A11yPreferences,
  type OsPreferences,
  type StorageLike,
  type SwitchKey,
  type TextSize
} from "../lib/a11y-preferences";

function isTextSize(value: string | undefined): value is TextSize {
  return value !== undefined && (TEXT_SIZES as readonly string[]).includes(value);
}

function isSwitchKey(value: string | undefined): value is SwitchKey {
  return value !== undefined && (SWITCH_KEYS as readonly string[]).includes(value);
}

/** `window.localStorage`, or `null` when merely reading the property throws. */
function storageOf(win: Window): StorageLike | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

function matches(win: Window, query: string): boolean {
  try {
    return win.matchMedia(query).matches;
  } catch {
    return false;
  }
}

function osPreferences(win: Window): OsPreferences {
  return {
    reducedMotion: matches(win, "(prefers-reduced-motion: reduce)"),
    contrastMore: matches(win, "(prefers-contrast: more)")
  };
}

export function initA11yPanel(doc: Document = document, win: Window = window): void {
  const root = doc.querySelector<HTMLElement>("[data-a11y-root]");
  const fab = root?.querySelector<HTMLButtonElement>("[data-a11y-fab]");
  const panel = root?.querySelector<HTMLElement>("[data-a11y-panel]");
  const title = root?.querySelector<HTMLElement>("[data-a11y-title]");
  const closeButton = root?.querySelector<HTMLButtonElement>("[data-a11y-close]");
  const resetButton = root?.querySelector<HTMLButtonElement>("[data-a11y-reset]");
  if (!root || !fab || !panel || !title || !closeButton || !resetButton) return;

  const html = doc.documentElement;
  const storage = storageOf(win);
  const radios = Array.from(root.querySelectorAll<HTMLInputElement>("input[data-a11y-size]"));
  const switches = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-a11y-switch]"));

  let current: A11yPreferences;
  const stored = readStoredPreferences(storage);
  if (stored) {
    // Idempotent: the early script normally did this already; repeating it covers the
    // case where that file failed to load.
    applyPreferences(html, stored);
    current = stored;
  } else {
    current = resolveEffectivePreferences(null, osPreferences(win));
  }

  function syncControls(): void {
    for (const radio of radios) radio.checked = radio.value === current.text;
    for (const button of switches) {
      const key = button.dataset.a11ySwitch;
      if (isSwitchKey(key)) button.setAttribute("aria-checked", current[key] ? "true" : "false");
    }
  }

  function announce(): void {
    doc.dispatchEvent(new CustomEvent(A11Y_CHANGE_EVENT, { detail: current }));
  }

  function commit(next: A11yPreferences): void {
    current = next;
    applyPreferences(html, next);
    writeStoredPreferences(storage, next);
    syncControls();
    announce();
  }

  function reset(): void {
    clearStoredPreferences(storage);
    clearAppliedPreferences(html);
    current = resolveEffectivePreferences(null, osPreferences(win));
    syncControls();
    announce();
  }

  function isOpen(): boolean {
    return !panel!.hidden;
  }

  function open(): void {
    panel!.hidden = false;
    fab!.setAttribute("aria-expanded", "true");
    title!.focus();
  }

  function close(returnFocus: boolean): void {
    panel!.hidden = true;
    fab!.setAttribute("aria-expanded", "false");
    if (returnFocus) fab!.focus();
  }

  fab.addEventListener("click", () => (isOpen() ? close(true) : open()));
  closeButton.addEventListener("click", () => close(true));
  resetButton.addEventListener("click", reset);

  for (const radio of radios) {
    radio.addEventListener("change", () => {
      if (radio.checked && isTextSize(radio.value)) commit({ ...current, text: radio.value });
    });
  }

  for (const button of switches) {
    button.addEventListener("click", () => {
      const key = button.dataset.a11ySwitch;
      if (isSwitchKey(key)) commit({ ...current, [key]: !current[key] });
    });
  }

  doc.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      close(true);
    }
  });

  // A press outside closes the panel without stealing focus from whatever was pressed.
  doc.addEventListener("pointerdown", (event) => {
    if (isOpen() && event.target instanceof Node && !root.contains(event.target)) close(false);
  });

  // Another tab changed (or reset) the preferences: follow it.
  win.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== A11Y_STORAGE_KEY) return;
    const next = readStoredPreferences(storage);
    if (next) {
      applyPreferences(html, next);
      current = next;
    } else {
      clearAppliedPreferences(html);
      current = resolveEffectivePreferences(null, osPreferences(win));
    }
    syncControls();
    announce();
  });

  // While nothing is stored the switches mirror the OS, so they follow it when it changes.
  for (const query of ["(prefers-reduced-motion: reduce)", "(prefers-contrast: more)"]) {
    try {
      win.matchMedia(query).addEventListener("change", () => {
        if (html.hasAttribute("data-a11y-user")) return;
        current = resolveEffectivePreferences(null, osPreferences(win));
        syncControls();
        announce();
      });
    } catch {
      // No matchMedia (or no addEventListener on it): the switches simply stay as they were.
    }
  }

  syncControls();
  fab.hidden = false;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => initA11yPanel());
  } else {
    initA11yPanel();
  }
}
