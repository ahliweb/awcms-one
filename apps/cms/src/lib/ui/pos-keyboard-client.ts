/**
 * Scanner input and the keyboard-first shortcut layer for the POS screen
 * (Issue #292, ADR-0032) - the client half of `domain/pos-scan.ts` and
 * `domain/pos-shortcuts.ts`. Kept out of `commerce-pos.astro`'s own script so
 * the cart, tender and receipt code stays untouched: the screen hands this
 * module ONE hook (`addScanned`) and everything else is DOM it finds by id.
 *
 * ## Behaviour that matters
 *
 * - The dedicated scan field takes a code (or `<n>*CODE`) on Enter, at any
 *   typing speed - it is for scanners AND for a cashier who types a code.
 * - A global detector additionally recognises a fast burst ending in Enter
 *   when focus is NOT in a text field, so a cashier who last clicked a button
 *   can still scan. It never fires inside a text field, and a recognised
 *   burst's Enter is swallowed so it cannot also press a focused button.
 * - Shortcuts are chords only (`domain/pos-shortcuts.ts`), so they cannot eat
 *   ordinary typing; they work from inside fields on purpose (that is where a
 *   cashier's hands are), and are ignored while any dialog is open.
 * - Every outcome of a scan is told to assistive technology: success through a
 *   polite `role="status"` region, every failure through an inline
 *   `role="alert"` message - never a modal.
 * - A personal override of the shortcut map lives in `localStorage`
 *   (per browser; ADR-0032 D5), wrapped in try/catch because storage can be
 *   blocked. All catalogue text is written with `textContent`.
 */
import {
  parseScanInput,
  ScanBurstDetector
} from "../../modules/commerce/domain/pos-scan";
import {
  actionForCombo,
  checkCombo,
  comboFromEvent,
  DEFAULT_POS_SHORTCUTS,
  findShortcutConflicts,
  resolvePosShortcuts,
  type PosShortcutAction,
  type PosShortcutMap
} from "../../modules/commerce/domain/pos-shortcuts";

export const POS_SHORTCUTS_STORAGE_KEY = "awcms-one:pos-shortcuts:v1";

export type ScannedItem = {
  productId: string;
  variantId: string | null;
  name: string;
  price: string;
  stock: number;
};

type LookupData = {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  price: string;
  stock: number;
  status: string;
  requiresVariant: boolean;
  sellable: boolean;
};

export type PosKeyboardOptions = {
  root: HTMLElement;
  /** Adds `quantity` of the item to the cart; `"stock"` when that would exceed what is in stock. */
  addScanned: (item: ScannedItem, quantity: number) => "added" | "stock";
};

function readStoredUserShortcuts(): unknown {
  try {
    const raw = window.localStorage.getItem(POS_SHORTCUTS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeStoredUserShortcuts(value: Record<string, string> | null): void {
  try {
    if (value === null || Object.keys(value).length === 0) {
      window.localStorage.removeItem(POS_SHORTCUTS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        POS_SHORTCUTS_STORAGE_KEY,
        JSON.stringify(value)
      );
    }
  } catch {
    // Storage blocked: the override simply does not persist.
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    return ![
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "range",
      "file",
      "color",
      "image"
    ].includes(target.type);
  }
  return false;
}

export function initPosKeyboard(options: PosKeyboardOptions): void {
  const { root } = options;
  const msg = (key: string): string => root.dataset[key] ?? "";
  const byId = <T extends HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const scanInput = byId<HTMLInputElement>("pos-scan-input");
  const scanStatus = byId<HTMLElement>("pos-scan-status");
  const scanError = byId<HTMLElement>("pos-scan-error");
  const dialog = byId<HTMLDialogElement>("pos-shortcuts-dialog");
  const dialogBody = byId<HTMLElement>("pos-shortcuts-body");
  const dialogMessage = byId<HTMLElement>("pos-shortcuts-message");

  // ---- shortcut map ------------------------------------------------------
  let tenantRaw: unknown = null;
  try {
    tenantRaw = JSON.parse(root.dataset.tenantShortcuts ?? "{}") as unknown;
  } catch {
    tenantRaw = null;
  }
  let userRaw: unknown = readStoredUserShortcuts();
  let map: PosShortcutMap = resolvePosShortcuts(tenantRaw, userRaw).map;

  // ---- announcements -----------------------------------------------------
  function say(text: string): void {
    if (scanError) {
      scanError.textContent = "";
      scanError.hidden = true;
    }
    if (scanStatus) scanStatus.textContent = text;
  }
  function fail(text: string): void {
    if (scanStatus) scanStatus.textContent = "";
    if (scanError) {
      scanError.textContent = text;
      scanError.hidden = false;
    }
  }

  // ---- scanning ----------------------------------------------------------
  let queue: Promise<void> = Promise.resolve();

  async function resolveScan(code: string, quantity: number): Promise<void> {
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/commerce/barcodes/lookup?code=${encodeURIComponent(code)}`,
        { credentials: "same-origin" }
      );
    } catch {
      fail(msg("msgScanFailed"));
      return;
    }
    if (response.status === 404) {
      fail(msg("msgScanUnknown").replace("{code}", code));
      return;
    }
    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: LookupData;
    } | null;
    if (!response.ok || !payload?.success || !payload.data) {
      fail(msg("msgScanFailed"));
      return;
    }
    const item = payload.data;
    const label = item.variantLabel
      ? `${item.name} - ${item.variantLabel}`
      : item.name;
    if (item.requiresVariant) {
      fail(msg("msgScanRequiresVariant").replace("{name}", label));
      return;
    }
    if (!item.sellable) {
      fail(
        (item.stock <= 0
          ? msg("msgScanOutOfStock")
          : msg("msgScanNotForSale")
        ).replace("{name}", label)
      );
      return;
    }
    const outcome = options.addScanned(
      {
        productId: item.productId,
        variantId: item.variantId,
        name: label,
        price: item.price,
        stock: item.stock
      },
      quantity
    );
    if (outcome === "stock") {
      fail(
        msg("msgScanStock")
          .replace("{name}", label)
          .replace("{stock}", String(item.stock))
      );
      return;
    }
    say(
      msg("msgScanAdded")
        .replace("{quantity}", String(quantity))
        .replace("{name}", label)
    );
  }

  function enqueueScan(code: string, quantity: number): void {
    queue = queue
      .then(() => resolveScan(code, quantity))
      .catch(() => {
        fail(msg("msgScanFailed"));
      });
  }

  scanInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    const parsed = parseScanInput(scanInput.value);
    scanInput.value = "";
    if (!parsed) {
      fail(msg("msgScanInvalid"));
      return;
    }
    enqueueScan(parsed.code, parsed.quantity);
  });

  const detector = new ScanBurstDetector();
  if (scanInput) {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.target === scanInput || dialog?.open) {
          detector.reset();
          return;
        }
        const outcome = detector.feed({
          key: event.key,
          timeStamp: event.timeStamp,
          editable: isTextEntry(event.target),
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey
        });
        if (outcome.kind === "scan") {
          event.preventDefault();
          event.stopPropagation();
          enqueueScan(outcome.code, 1);
          scanInput.focus();
        }
      },
      true
    );
  }

  // ---- shortcut actions --------------------------------------------------
  let activeCartRow: HTMLElement | null = null;
  document
    .getElementById("pos-cart-body")
    ?.addEventListener("focusin", (event) => {
      const row = (event.target as HTMLElement | null)?.closest("tr");
      if (row instanceof HTMLElement) activeCartRow = row;
    });
  function cartRow(): HTMLElement | null {
    if (activeCartRow && activeCartRow.isConnected) return activeCartRow;
    const rows = document.querySelectorAll<HTMLElement>(
      "#pos-cart-body tr:has(.pos-qty-input)"
    );
    return rows[rows.length - 1] ?? null;
  }
  function click(id: string): boolean {
    const node = byId<HTMLButtonElement>(id);
    if (!node || node.disabled || node.hidden || node.closest("[hidden]")) {
      return false;
    }
    node.click();
    return true;
  }

  const handlers: Record<PosShortcutAction, () => void> = {
    focusScan: () => {
      (scanInput ?? byId<HTMLInputElement>("pos-search-input"))?.focus();
    },
    focusSearch: () => byId<HTMLInputElement>("pos-search-input")?.focus(),
    editQuantity: () => {
      const input =
        cartRow()?.querySelector<HTMLInputElement>(".pos-qty-input");
      if (input) {
        input.focus();
        input.select();
      } else say(msg("msgCartEmptyRow"));
    },
    removeLine: () => {
      const row = cartRow();
      const button = row?.querySelector<HTMLButtonElement>(".pos-remove-btn");
      if (!button) {
        say(msg("msgCartEmptyRow"));
        return;
      }
      const name = row?.querySelector("[data-field='name']")?.textContent ?? "";
      activeCartRow = null;
      button.click();
      say(msg("msgLineRemoved").replace("{name}", name));
      (scanInput ?? byId<HTMLInputElement>("pos-search-input"))?.focus();
    },
    focusCustomer: () => byId<HTMLInputElement>("pos-customer-name")?.focus(),
    focusPayment: () => {
      const amount = document.querySelector<HTMLInputElement>(
        "#pos-tenders [data-field='amount']"
      );
      if (amount) amount.focus();
      else {
        byId<HTMLButtonElement>("pos-add-tender")?.focus();
      }
    },
    hold: () => {
      click("pos-hold");
    },
    resume: () => {
      const select = byId<HTMLSelectElement>("pos-held-select");
      if (!select) return;
      if (select.value) click("pos-resume");
      else select.focus();
    },
    finalize: () => {
      const form = byId<HTMLFormElement>("pos-checkout-form");
      if (form && !form.closest("[hidden]")) form.requestSubmit();
    },
    printReceipt: () => {
      click("pos-print");
    },
    newSale: () => {
      click("pos-new-sale");
    },
    showHelp: () => openDialog()
  };

  document.addEventListener("keydown", (event) => {
    if (event.repeat || event.isComposing) return;
    if (recording) return;
    if (dialog?.open) return;
    const combo = comboFromEvent(event);
    const action = actionForCombo(map, combo);
    if (!action) return;
    event.preventDefault();
    handlers[action]();
  });

  // ---- help / rebinding dialog ------------------------------------------
  let recording: PosShortcutAction | null = null;
  let opener: HTMLElement | null = null;

  function userOverrides(): Record<string, string> {
    return userRaw !== null &&
      typeof userRaw === "object" &&
      !Array.isArray(userRaw)
      ? { ...(userRaw as Record<string, string>) }
      : {};
  }
  function refresh(): void {
    map = resolvePosShortcuts(tenantRaw, userRaw).map;
    if (!dialogBody) return;
    for (const row of dialogBody.querySelectorAll<HTMLElement>(
      "[data-action-id]"
    )) {
      const action = row.dataset.actionId as PosShortcutAction;
      const kbd = row.querySelector<HTMLElement>("[data-field='combo']");
      if (kbd) kbd.textContent = map[action];
      const change = row.querySelector<HTMLButtonElement>(
        "[data-field='change']"
      );
      if (change) {
        change.setAttribute("aria-describedby", "pos-shortcuts-message");
        change.textContent =
          recording === action ? msg("labelPressKeys") : msg("labelRebind");
      }
    }
  }
  function note(text: string): void {
    if (dialogMessage) dialogMessage.textContent = text;
  }
  function openDialog(): void {
    if (!dialog || dialog.open) return;
    opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    refresh();
    note("");
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-field='change'], button")?.focus();
  }
  byId<HTMLButtonElement>("pos-shortcuts-open")?.addEventListener(
    "click",
    openDialog
  );
  byId<HTMLButtonElement>("pos-shortcuts-close")?.addEventListener(
    "click",
    () => {
      recording = null;
      dialog?.close();
    }
  );
  dialog?.addEventListener("close", () => {
    recording = null;
    opener?.focus();
  });

  dialogBody?.addEventListener("click", (event) => {
    const button = (
      event.target as HTMLElement | null
    )?.closest<HTMLButtonElement>("[data-field='change']");
    if (!button) return;
    const action = button.closest<HTMLElement>("[data-action-id]")?.dataset
      .actionId as PosShortcutAction | undefined;
    if (!action) return;
    recording = action;
    note(msg("msgPressKeys"));
    refresh();
  });

  // While recording, the next chord becomes the binding. Capture phase so the
  // dialog's own Escape/Tab handling does not run first; Tab is left alone so
  // a keyboard user can always walk away.
  dialog?.addEventListener(
    "keydown",
    (event) => {
      if (!recording) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        recording = null;
        note(msg("msgRecordCancelled"));
        refresh();
        return;
      }
      if (event.key === "Tab") return;
      const combo = comboFromEvent(event);
      if (combo === null) return;
      event.preventDefault();
      event.stopPropagation();
      const checked = checkCombo(combo);
      if (!checked.ok) {
        note(
          checked.reason === "bare_character"
            ? msg("msgComboBare")
            : msg("msgComboReserved")
        );
        return;
      }
      const action = recording;
      const trial = { ...map, [action]: checked.combo };
      const conflict = findShortcutConflicts(trial).find((entry) =>
        entry.actions.includes(action)
      );
      if (conflict) {
        const other = conflict.actions.find(
          (candidate) => candidate !== action
        );
        const otherLabel =
          dialogBody?.querySelector<HTMLElement>(
            `[data-action-id='${other}'] [data-field='label']`
          )?.textContent ?? "";
        note(msg("msgComboConflict").replace("{action}", otherLabel));
        return;
      }
      const next = userOverrides();
      if (checked.combo === DEFAULT_POS_SHORTCUTS[action]) delete next[action];
      else next[action] = checked.combo;
      userRaw = next;
      writeStoredUserShortcuts(next);
      recording = null;
      note(msg("msgComboSaved"));
      refresh();
    },
    true
  );

  byId<HTMLButtonElement>("pos-shortcuts-reset")?.addEventListener(
    "click",
    () => {
      userRaw = null;
      writeStoredUserShortcuts(null);
      recording = null;
      note(msg("msgShortcutsReset"));
      refresh();
    }
  );

  refresh();
}
