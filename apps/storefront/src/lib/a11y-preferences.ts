/**
 * The visitor's reading preferences (issue #539, ADR-0057): the pure half of
 * the public accessibility panel — what is stored, how it is validated, and
 * which `<html>` attributes it maps to. No DOM global is touched at import
 * time and every function takes the storage / element / media lookups it
 * needs as arguments, so the module is unit-testable with plain objects (the
 * same split `src/scripts/dengar.ts` uses) and is safe to import from a
 * build-time context.
 *
 * ## Contract
 *
 * - **Storage.** `localStorage["awcms-a11y"]` holds
 *   `{"v":1,"text":"normal"|"large"|"x-large","contrast":bool,"mono":bool,
 *   "dyslexia":bool,"underline":bool,"highlight":bool,"motion":bool}`
 *   (`motion: true` means "reduce motion"). The key is deliberately NOT
 *   prefixed `awcms-one:` like this repo's other keys: it is a cross-product
 *   contract, so the same visitor setting means the same thing on every
 *   product that carries the panel.
 * - **Never trust storage.** Invalid JSON, a wrong `v`, a missing key or an
 *   unknown value is treated as "nothing stored" — the OS preferences apply —
 *   never as a partial preference. Every storage access is wrapped, because a
 *   private window, a blocked-cookies profile or a full quota makes
 *   `localStorage` itself throw.
 * - **Attributes on `<html>`.** `data-a11y-text`, `data-a11y-contrast`,
 *   `data-a11y-mono`, `data-a11y-dyslexia`, `data-a11y-underline`,
 *   `data-a11y-highlight`, `data-a11y-motion="reduce"`. Absent means off.
 *   `data-a11y-user` is the one extra attribute: it records "this visitor has
 *   a stored choice", which switches the CSS media-query defaults
 *   (`prefers-contrast: more`, `prefers-reduced-motion: reduce`) off so an
 *   explicit "off" in the panel really is off.
 * - **Nothing leaves the browser.** No network call, no analytics event.
 *
 * `src/lib/a11y-early.js` (served by `src/pages/a11y-early.js.ts`) repeats the read-validate-apply half in plain ES5,
 * because it must run as a blocking classic script before first paint and a
 * bundled module cannot. `tests/a11y-early.test.ts` runs both against the
 * same inputs and fails if they ever disagree.
 */

/** The `localStorage` key — fixed by the cross-product contract. */
export const A11Y_STORAGE_KEY = "awcms-a11y";

/** The only storage schema version this code reads or writes. */
export const A11Y_STORAGE_VERSION = 1;

/** Dispatched on `document` after every change, `detail` being the effective preferences. */
export const A11Y_CHANGE_EVENT = "awcms-a11y-change";

export const TEXT_SIZES = ["normal", "large", "x-large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const SWITCH_KEYS = ["contrast", "mono", "dyslexia", "underline", "highlight", "motion"] as const;
export type SwitchKey = (typeof SWITCH_KEYS)[number];

export interface A11yPreferences {
  v: typeof A11Y_STORAGE_VERSION;
  text: TextSize;
  contrast: boolean;
  mono: boolean;
  dyslexia: boolean;
  underline: boolean;
  highlight: boolean;
  /** `true` means "reduce motion". */
  motion: boolean;
}

/** Everything off, normal text size. */
export const DEFAULT_PREFERENCES: A11yPreferences = Object.freeze({
  v: A11Y_STORAGE_VERSION,
  text: "normal",
  contrast: false,
  mono: false,
  dyslexia: false,
  underline: false,
  highlight: false,
  motion: false
});

/** The subset of `Storage` this module needs; `null`/`undefined` stands for "storage unavailable". */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The subset of `Element` this module writes attributes through. */
export interface AttributeTarget {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** The OS-level preferences that supply the defaults while nothing is stored. */
export interface OsPreferences {
  reducedMotion: boolean;
  contrastMore: boolean;
}

function isTextSize(value: unknown): value is TextSize {
  return typeof value === "string" && (TEXT_SIZES as readonly string[]).includes(value);
}

/**
 * The preferences encoded in `raw`, or `null` when `raw` is not a complete,
 * valid, version-1 object. Extra keys are ignored; any missing or wrongly
 * typed known key rejects the whole value (a half-valid object is a
 * corrupted one, and guessing the missing half would be inventing a choice
 * the visitor never made).
 */
export function parsePreferences(raw: string | null | undefined): A11yPreferences | null {
  if (typeof raw !== "string" || raw === "") return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.v !== A11Y_STORAGE_VERSION) return null;
  if (!isTextSize(record.text)) return null;
  for (const key of SWITCH_KEYS) {
    if (typeof record[key] !== "boolean") return null;
  }

  return {
    v: A11Y_STORAGE_VERSION,
    text: record.text,
    contrast: record.contrast as boolean,
    mono: record.mono as boolean,
    dyslexia: record.dyslexia as boolean,
    underline: record.underline as boolean,
    highlight: record.highlight as boolean,
    motion: record.motion as boolean
  };
}

/** The JSON stored for `preferences` — the full object, key order fixed. */
export function serializePreferences(preferences: A11yPreferences): string {
  return JSON.stringify({
    v: A11Y_STORAGE_VERSION,
    text: preferences.text,
    contrast: preferences.contrast,
    mono: preferences.mono,
    dyslexia: preferences.dyslexia,
    underline: preferences.underline,
    highlight: preferences.highlight,
    motion: preferences.motion
  });
}

/** The stored preferences, or `null` when nothing valid is stored or storage throws. */
export function readStoredPreferences(storage: StorageLike | null | undefined): A11yPreferences | null {
  if (!storage) return null;
  try {
    return parsePreferences(storage.getItem(A11Y_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Stores `preferences`; `false` (never a throw) when storage is unavailable or refuses the write. */
export function writeStoredPreferences(storage: StorageLike | null | undefined, preferences: A11yPreferences): boolean {
  if (!storage) return false;
  try {
    storage.setItem(A11Y_STORAGE_KEY, serializePreferences(preferences));
    return true;
  } catch {
    return false;
  }
}

/** Removes the stored preferences; `false` (never a throw) when storage is unavailable. */
export function clearStoredPreferences(storage: StorageLike | null | undefined): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(A11Y_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the panel should show, and what a change builds on: the stored
 * preferences when there are any, otherwise the OS defaults (motion
 * reduction follows `prefers-reduced-motion`, contrast follows
 * `prefers-contrast: more`, everything else is off).
 */
export function resolveEffectivePreferences(stored: A11yPreferences | null, os: OsPreferences): A11yPreferences {
  if (stored) return stored;
  return { ...DEFAULT_PREFERENCES, contrast: os.contrastMore, motion: os.reducedMotion };
}

/** `<html>` attribute names, keyed by preference. */
export const ATTRIBUTES = {
  text: "data-a11y-text",
  contrast: "data-a11y-contrast",
  mono: "data-a11y-mono",
  dyslexia: "data-a11y-dyslexia",
  underline: "data-a11y-underline",
  highlight: "data-a11y-highlight",
  motion: "data-a11y-motion",
  user: "data-a11y-user"
} as const;

function toggleAttribute(target: AttributeTarget, name: string, value: string | null): void {
  if (value === null) target.removeAttribute(name);
  else target.setAttribute(name, value);
}

/**
 * Writes `preferences` onto `target` (the `<html>` element) as the
 * attributes in {@link ATTRIBUTES}, and marks the visitor as having made a
 * choice (`data-a11y-user`).
 */
export function applyPreferences(target: AttributeTarget, preferences: A11yPreferences): void {
  toggleAttribute(target, ATTRIBUTES.text, preferences.text === "normal" ? null : preferences.text);
  toggleAttribute(target, ATTRIBUTES.contrast, preferences.contrast ? "" : null);
  toggleAttribute(target, ATTRIBUTES.mono, preferences.mono ? "" : null);
  toggleAttribute(target, ATTRIBUTES.dyslexia, preferences.dyslexia ? "" : null);
  toggleAttribute(target, ATTRIBUTES.underline, preferences.underline ? "" : null);
  toggleAttribute(target, ATTRIBUTES.highlight, preferences.highlight ? "" : null);
  toggleAttribute(target, ATTRIBUTES.motion, preferences.motion ? "reduce" : null);
  target.setAttribute(ATTRIBUTES.user, "");
}

/** Removes every preference attribute, so the OS defaults (CSS media queries) apply again. */
export function clearAppliedPreferences(target: AttributeTarget): void {
  for (const name of Object.values(ATTRIBUTES)) target.removeAttribute(name);
}

/** The subset of `Element`/`document.documentElement` {@link isMotionReduced} reads. */
export interface MotionProbe {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

/**
 * Whether motion should currently be reduced — for script-driven motion
 * (smooth scrolling, a ticker, a carousel, autoplay) that CSS cannot stop.
 * An explicit visitor choice wins in either direction; with no stored
 * choice the OS `prefers-reduced-motion` decides.
 */
export function isMotionReduced(root: MotionProbe, osReducedMotion: boolean): boolean {
  if (root.hasAttribute(ATTRIBUTES.user)) return root.getAttribute(ATTRIBUTES.motion) === "reduce";
  return osReducedMotion;
}

/** The subset of `Document` {@link preferredScrollBehavior} reads. */
export interface ScrollDocument {
  documentElement: MotionProbe;
}

/** The subset of `Window` {@link preferredScrollBehavior} reads. */
export interface ScrollWindow {
  matchMedia?: (query: string) => { matches: boolean };
}

/**
 * `behavior` for `scrollIntoView`/`scrollTo` on this page right now: instant
 * while motion is reduced (by the visitor's choice, else the OS), smooth
 * otherwise. An explicit `behavior: "smooth"` ignores CSS `scroll-behavior`,
 * so a call site has to ask.
 */
export function preferredScrollBehavior(doc: ScrollDocument, win: ScrollWindow): "auto" | "smooth" {
  let osReduced = false;
  try {
    osReduced = win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    osReduced = false;
  }
  return isMotionReduced(doc.documentElement, osReduced) ? "auto" : "smooth";
}
