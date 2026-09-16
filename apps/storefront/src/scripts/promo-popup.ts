/**
 * The home page's promo popup (`popups/active`, `src/lib/awcms/pemasaran.ts`)
 * — shown as a native `<dialog>` honouring `frequency` via storage:
 *
 *   - `always`: shown every visit.
 *   - `once_per_session`: `sessionStorage`, so it reappears in a new tab.
 *   - `once_per_day`: `localStorage`, gated on 24h since it last showed.
 *
 * A build with no active popup renders no `[data-promo-popup]` element at
 * all (`index.astro`'s own condition) — this script simply does nothing
 * when that element is absent, same as every other DOM-optional script in
 * this app. With JavaScript disabled the `<dialog>` stays closed (its
 * `open` attribute is never set server-side) — a promotional overlay
 * degrading to "never shown" is the correct no-JS fallback, not a broken
 * modal a reader cannot dismiss.
 */

const STORAGE_PREFIX = "awcms-one:popup:";

function storageKey(popupId: string): string {
  return `${STORAGE_PREFIX}${popupId}`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function shouldShow(popupId: string, frequency: string): boolean {
  try {
    if (frequency === "always") return true;

    if (frequency === "once_per_session") {
      return window.sessionStorage.getItem(storageKey(popupId)) === null;
    }

    if (frequency === "once_per_day") {
      const last = window.localStorage.getItem(storageKey(popupId));
      if (!last) return true;
      const lastShown = Date.parse(last);
      return Number.isNaN(lastShown) || Date.now() - lastShown >= ONE_DAY_MS;
    }

    return true;
  } catch {
    // Storage blocked/unavailable — show it; a repeat popup is a smaller
    // harm than a promo nobody who could see it ever sees.
    return true;
  }
}

function markShown(popupId: string, frequency: string): void {
  try {
    if (frequency === "once_per_session") {
      window.sessionStorage.setItem(storageKey(popupId), "1");
    } else {
      window.localStorage.setItem(storageKey(popupId), new Date().toISOString());
    }
  } catch {
    // Nothing further to do — see shouldShow's own catch.
  }
}

const dialog = document.querySelector<HTMLDialogElement>("[data-promo-popup]");

if (dialog) {
  const popupId = dialog.dataset.popupId ?? "";
  const frequency = dialog.dataset.frequency ?? "always";

  if (popupId && shouldShow(popupId, frequency)) {
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.removeAttribute("hidden");
    }
    markShown(popupId, frequency);
  }

  dialog.querySelector("[data-popup-close]")?.addEventListener("click", () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.setAttribute("hidden", "");
  });
}
