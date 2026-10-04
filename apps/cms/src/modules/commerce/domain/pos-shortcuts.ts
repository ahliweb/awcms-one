/**
 * The cashier's configurable keyboard shortcuts for the POS screen (Issue
 * #292, ADR-0032). Pure - no DOM, no storage - so the SAME validation runs when
 * a tenant default is read on the server, when a user's personal override is
 * read from `localStorage`, and in the unit tests.
 *
 * ## Layers
 *
 * `DEFAULT_POS_SHORTCUTS` -> the tenant's map (module setting `posShortcuts`,
 * edited through the existing module-settings API) -> the user's own map
 * (browser `localStorage`, edited in the shortcut dialog). Each layer may
 * rebind any subset of actions. {@link resolvePosShortcuts} validates every
 * entry and every collision, and a layer that would break the map is dropped
 * entry by entry rather than trusted: a bad stored value can degrade to the
 * defaults but can never disable the screen's keyboard access.
 *
 * ## What a combo may be (and why)
 *
 * Only forms that do not collide with the browser, the OS, or an assistive
 * technology, and that satisfy WCAG 2.1.4 (Character Key Shortcuts) by never
 * being a bare printable character:
 *
 * - `Alt+Shift+<letter or digit>` - no browser binds these, and screen readers
 *   use Insert/CapsLock rather than Alt; the app resolves the key by physical
 *   `event.code` so it works on any keyboard layout and on macOS Option;
 * - `F2`, `F4`, `F8`, `F9` - the function keys no browser claims (`F1` help,
 *   `F3` find, `F5` reload, `F6` focus-cycle, `F7` caret browsing,
 *   `F10` menu, `F11` fullscreen, `F12` devtools are all refused);
 * - `Ctrl+Enter` / `Ctrl+Shift+Enter` - the conventional "submit" chord.
 *
 * Everything else - `Ctrl+<letter>` (browser), `Meta+...` (OS), `Alt+<letter>`
 * without Shift (menu mnemonics), `Alt+Left/Right/Home`, `Tab`, `Escape`,
 * `Enter`, `Space`, arrows, a bare character - is refused with a reason.
 */

export const POS_SHORTCUT_ACTIONS = [
  "focusScan",
  "focusSearch",
  "editQuantity",
  "removeLine",
  "focusCustomer",
  "focusPayment",
  "hold",
  "resume",
  "finalize",
  "printReceipt",
  "newSale",
  "showHelp"
] as const;

export type PosShortcutAction = (typeof POS_SHORTCUT_ACTIONS)[number];
export type PosShortcutMap = Readonly<Record<PosShortcutAction, string>>;

export const DEFAULT_POS_SHORTCUTS: PosShortcutMap = {
  focusScan: "F2",
  focusSearch: "Alt+Shift+S",
  editQuantity: "Alt+Shift+Q",
  removeLine: "Alt+Shift+R",
  focusCustomer: "Alt+Shift+C",
  focusPayment: "Alt+Shift+P",
  hold: "Alt+Shift+H",
  resume: "Alt+Shift+O",
  finalize: "Ctrl+Enter",
  printReceipt: "Alt+Shift+L",
  newSale: "Alt+Shift+N",
  showHelp: "Alt+Shift+K"
};

export type ComboRejection =
  "malformed" | "reserved" | "bare_character" | "unsupported_modifier";

const ALLOWED_FUNCTION_KEYS = new Set(["F2", "F4", "F8", "F9"]);
const LETTER_OR_DIGIT = /^[A-Z0-9]$/;

/** Canonical modifier order, so `shift+alt+s` and `Alt+Shift+S` are the same combo. */
function canonicalCombo(
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean },
  key: string
): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push("Ctrl");
  if (modifiers.alt) parts.push("Alt");
  if (modifiers.shift) parts.push("Shift");
  if (modifiers.meta) parts.push("Meta");
  parts.push(key);
  return parts.join("+");
}

type ParsedCombo = {
  modifiers: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };
  key: string;
};

function parseCombo(raw: string): ParsedCombo | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 40) {
    return null;
  }
  const pieces = raw.split("+").map((piece) => piece.trim());
  if (pieces.length === 0 || pieces.some((piece) => piece.length === 0)) {
    return null;
  }
  const modifiers = { ctrl: false, alt: false, shift: false, meta: false };
  const keyPiece = pieces[pieces.length - 1]!;
  for (const piece of pieces.slice(0, -1)) {
    switch (piece.toLowerCase()) {
      case "ctrl":
      case "control":
        if (modifiers.ctrl) return null;
        modifiers.ctrl = true;
        break;
      case "alt":
      case "option":
        if (modifiers.alt) return null;
        modifiers.alt = true;
        break;
      case "shift":
        if (modifiers.shift) return null;
        modifiers.shift = true;
        break;
      case "meta":
      case "cmd":
      case "command":
      case "win":
        if (modifiers.meta) return null;
        modifiers.meta = true;
        break;
      default:
        return null;
    }
  }
  const lower = keyPiece.toLowerCase();
  let key: string;
  if (/^f([1-9]|1[0-2])$/.test(lower)) key = lower.toUpperCase();
  else if (lower === "enter" || lower === "return") key = "Enter";
  else if (lower === "escape" || lower === "esc") key = "Escape";
  else if (lower === "tab") key = "Tab";
  else if (lower === "space") key = "Space";
  else if (/^(arrow)?(up|down|left|right)$/.test(lower)) {
    key = `Arrow${lower.replace("arrow", "")[0]!.toUpperCase()}${lower.replace("arrow", "").slice(1)}`;
  } else if (lower === "home" || lower === "end") {
    key = lower[0]!.toUpperCase() + lower.slice(1);
  } else if (lower === "delete" || lower === "backspace") {
    key = lower[0]!.toUpperCase() + lower.slice(1);
  } else if (keyPiece.length === 1) key = keyPiece.toUpperCase();
  else return null;
  return { modifiers, key };
}

export type ComboCheck =
  { ok: true; combo: string } | { ok: false; reason: ComboRejection };

/** Normalises and policy-checks one combo string. */
export function checkCombo(raw: string): ComboCheck {
  const parsed = parseCombo(raw);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { modifiers, key } = parsed;
  const combo = canonicalCombo(modifiers, key);
  const anyModifier =
    modifiers.ctrl || modifiers.alt || modifiers.shift || modifiers.meta;

  if (/^F\d+$/.test(key)) {
    if (anyModifier) return { ok: false, reason: "unsupported_modifier" };
    return ALLOWED_FUNCTION_KEYS.has(key)
      ? { ok: true, combo }
      : { ok: false, reason: "reserved" };
  }
  if (!anyModifier) {
    return LETTER_OR_DIGIT.test(key) || key.length === 1
      ? { ok: false, reason: "bare_character" }
      : { ok: false, reason: "reserved" };
  }
  if (modifiers.meta) return { ok: false, reason: "unsupported_modifier" };
  if (key === "Enter") {
    return modifiers.ctrl && !modifiers.alt
      ? { ok: true, combo }
      : { ok: false, reason: "reserved" };
  }
  if (LETTER_OR_DIGIT.test(key)) {
    return modifiers.alt && modifiers.shift && !modifiers.ctrl
      ? { ok: true, combo }
      : {
          ok: false,
          reason: modifiers.ctrl ? "reserved" : "unsupported_modifier"
        };
  }
  return { ok: false, reason: "reserved" };
}

/** Maps a DOM key event to the canonical combo string it represents, or `null` when it is not combo-shaped. */
export function comboFromEvent(event: {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(event.code)) key = event.code;
  else if (event.code === "Enter" || event.code === "NumpadEnter")
    key = "Enter";
  if (key === null) return null;
  return canonicalCombo(
    {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey
    },
    key
  );
}

export type ShortcutConflict = { combo: string; actions: PosShortcutAction[] };

/** Every combo bound to more than one action. */
export function findShortcutConflicts(
  map: Partial<Record<PosShortcutAction, string>>
): ShortcutConflict[] {
  const byCombo = new Map<string, PosShortcutAction[]>();
  for (const action of POS_SHORTCUT_ACTIONS) {
    const combo = map[action];
    if (!combo) continue;
    byCombo.set(combo, [...(byCombo.get(combo) ?? []), action]);
  }
  return [...byCombo.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([combo, actions]) => ({ combo, actions }));
}

export type ShortcutOverrides = Partial<Record<PosShortcutAction, string>>;

export type OverrideProblem = {
  action: string;
  reason: ComboRejection | "unknown_action" | "conflict";
};

/**
 * Reads one layer of overrides (unknown JSON from settings or storage) into the
 * clean, canonical subset that passes policy. Never throws.
 */
export function sanitizeShortcutOverrides(raw: unknown): {
  overrides: ShortcutOverrides;
  problems: OverrideProblem[];
} {
  const overrides: ShortcutOverrides = {};
  const problems: OverrideProblem[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { overrides, problems };
  }
  for (const [action, value] of Object.entries(
    raw as Record<string, unknown>
  )) {
    if (!(POS_SHORTCUT_ACTIONS as readonly string[]).includes(action)) {
      problems.push({ action, reason: "unknown_action" });
      continue;
    }
    if (typeof value !== "string") {
      problems.push({ action, reason: "malformed" });
      continue;
    }
    const checked = checkCombo(value);
    if (!checked.ok) {
      problems.push({ action, reason: checked.reason });
      continue;
    }
    overrides[action as PosShortcutAction] = checked.combo;
  }
  return { overrides, problems };
}

function applyLayer(
  base: PosShortcutMap,
  layer: ShortcutOverrides,
  problems: OverrideProblem[]
): PosShortcutMap {
  // Apply the whole layer; while the result has a collision, drop every layer
  // entry that takes part in one (reported) and try again. A swap of two
  // actions' combos therefore works, while a combo that steals another
  // action's binding is refused.
  const pending: ShortcutOverrides = { ...layer };
  for (;;) {
    const next = { ...base, ...pending } as PosShortcutMap;
    const conflicts = findShortcutConflicts(next);
    if (conflicts.length === 0) return next;
    let dropped = false;
    for (const conflict of conflicts) {
      for (const action of conflict.actions) {
        if (pending[action] === undefined) continue;
        delete pending[action];
        problems.push({ action, reason: "conflict" });
        dropped = true;
      }
    }
    if (!dropped) return base;
  }
}

export type ResolvedShortcuts = {
  map: PosShortcutMap;
  problems: { tenant: OverrideProblem[]; user: OverrideProblem[] };
};

/** defaults -> tenant -> user, every entry validated, collisions refused. */
export function resolvePosShortcuts(
  tenantRaw: unknown,
  userRaw: unknown
): ResolvedShortcuts {
  const tenant = sanitizeShortcutOverrides(tenantRaw);
  const user = sanitizeShortcutOverrides(userRaw);
  const tenantProblems = [...tenant.problems];
  const userProblems = [...user.problems];
  const withTenant = applyLayer(
    DEFAULT_POS_SHORTCUTS,
    tenant.overrides,
    tenantProblems
  );
  const map = applyLayer(withTenant, user.overrides, userProblems);
  return { map, problems: { tenant: tenantProblems, user: userProblems } };
}

/** Reads the tenant's `posShortcuts` override object out of an effective `commerce` settings document. */
export function readTenantShortcutSettings(
  effectiveSettings: Record<string, unknown> | null | undefined
): ShortcutOverrides {
  return sanitizeShortcutOverrides(effectiveSettings?.posShortcuts).overrides;
}

/** `action -> combo` for the combo that `comboFromEvent` produced, if any. */
export function actionForCombo(
  map: PosShortcutMap,
  combo: string | null
): PosShortcutAction | null {
  if (combo === null) return null;
  return POS_SHORTCUT_ACTIONS.find((action) => map[action] === combo) ?? null;
}
