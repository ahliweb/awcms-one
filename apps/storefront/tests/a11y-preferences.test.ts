/**
 * Unit tests for the reading-preferences module (issue #539, ADR-0057) —
 * `src/lib/a11y-preferences.ts`: the storage contract, attribute application,
 * OS-default resolution and the script-driven-motion helpers. Everything is
 * driven with plain objects (no DOM, no real `localStorage`), the same shape
 * `dengar.test.ts` uses.
 */
import { describe, expect, test } from "bun:test";
import {
  A11Y_STORAGE_KEY,
  ATTRIBUTES,
  DEFAULT_PREFERENCES,
  applyPreferences,
  clearAppliedPreferences,
  clearStoredPreferences,
  isMotionReduced,
  parsePreferences,
  preferredScrollBehavior,
  readStoredPreferences,
  resolveEffectivePreferences,
  serializePreferences,
  writeStoredPreferences,
  type A11yPreferences,
  type StorageLike
} from "../src/lib/a11y-preferences";

const ALL_ON: A11yPreferences = {
  v: 1,
  text: "x-large",
  contrast: true,
  mono: true,
  dyslexia: true,
  underline: true,
  highlight: true,
  motion: true
};

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  };
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("SecurityError: storage is blocked");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError: storage is blocked");
  }
};

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    hasAttribute: (name: string) => attrs.has(name),
    getAttribute: (name: string) => attrs.get(name) ?? null
  };
}

describe("storage contract", () => {
  test("the key is the cross-product `awcms-a11y`, not an `awcms-one:` key", () => {
    expect(A11Y_STORAGE_KEY).toBe("awcms-a11y");
  });

  test("serialises the full object with a fixed key order and parses it back", () => {
    const json = serializePreferences(ALL_ON);
    expect(json).toBe(
      '{"v":1,"text":"x-large","contrast":true,"mono":true,"dyslexia":true,"underline":true,"highlight":true,"motion":true}'
    );
    expect(parsePreferences(json)).toEqual(ALL_ON);
    expect(parsePreferences(serializePreferences(DEFAULT_PREFERENCES))).toEqual(DEFAULT_PREFERENCES);
  });

  test("anything that is not a complete version-1 object is 'nothing stored'", () => {
    const valid = JSON.parse(serializePreferences(ALL_ON)) as Record<string, unknown>;
    const reject = (value: unknown) => expect(parsePreferences(JSON.stringify(value))).toBeNull();

    // Not JSON, not an object, empty.
    expect(parsePreferences(null)).toBeNull();
    expect(parsePreferences(undefined)).toBeNull();
    expect(parsePreferences("")).toBeNull();
    expect(parsePreferences("{not json")).toBeNull();
    reject(null);
    reject([]);
    reject("large");
    reject(1);

    // Wrong or missing version.
    reject({ ...valid, v: 2 });
    reject({ ...valid, v: "1" });
    const { v: _v, ...withoutVersion } = valid;
    reject(withoutVersion);

    // Unknown text size.
    reject({ ...valid, text: "huge" });
    reject({ ...valid, text: 3 });
    reject({ ...valid, text: "LARGE" });

    // Every switch must be a real boolean, and present.
    for (const key of ["contrast", "mono", "dyslexia", "underline", "highlight", "motion"]) {
      reject({ ...valid, [key]: "true" });
      reject({ ...valid, [key]: 1 });
      reject({ ...valid, [key]: null });
      const { [key]: _removed, ...without } = valid;
      reject(without);
    }
  });

  test("ignores extra keys instead of carrying them forward", () => {
    const parsed = parsePreferences(JSON.stringify({ ...ALL_ON, future: "x" }));
    expect(parsed).toEqual(ALL_ON);
    expect(parsed).not.toHaveProperty("future");
  });

  test("read, write and clear go through storage and never throw", () => {
    const storage = memoryStorage();
    expect(readStoredPreferences(storage)).toBeNull();
    expect(writeStoredPreferences(storage, ALL_ON)).toBe(true);
    expect(storage.data.get(A11Y_STORAGE_KEY)).toBe(serializePreferences(ALL_ON));
    expect(readStoredPreferences(storage)).toEqual(ALL_ON);
    expect(clearStoredPreferences(storage)).toBe(true);
    expect(storage.data.has(A11Y_STORAGE_KEY)).toBe(false);
  });

  test("corrupt stored data reads as nothing stored", () => {
    expect(readStoredPreferences(memoryStorage({ [A11Y_STORAGE_KEY]: "{oops" }))).toBeNull();
    expect(readStoredPreferences(memoryStorage({ [A11Y_STORAGE_KEY]: '{"v":9}' }))).toBeNull();
  });

  test("storage that throws, or is missing, degrades quietly", () => {
    expect(readStoredPreferences(throwingStorage)).toBeNull();
    expect(writeStoredPreferences(throwingStorage, ALL_ON)).toBe(false);
    expect(clearStoredPreferences(throwingStorage)).toBe(false);
    for (const missing of [null, undefined]) {
      expect(readStoredPreferences(missing)).toBeNull();
      expect(writeStoredPreferences(missing, ALL_ON)).toBe(false);
      expect(clearStoredPreferences(missing)).toBe(false);
    }
  });
});

describe("OS-default resolution", () => {
  test("with nothing stored, motion follows prefers-reduced-motion and contrast follows prefers-contrast", () => {
    expect(resolveEffectivePreferences(null, { reducedMotion: false, contrastMore: false })).toEqual(DEFAULT_PREFERENCES);
    expect(resolveEffectivePreferences(null, { reducedMotion: true, contrastMore: false })).toEqual({
      ...DEFAULT_PREFERENCES,
      motion: true
    });
    expect(resolveEffectivePreferences(null, { reducedMotion: false, contrastMore: true })).toEqual({
      ...DEFAULT_PREFERENCES,
      contrast: true
    });
  });

  test("a stored choice wins over the OS in both directions", () => {
    const explicitlyOff: A11yPreferences = { ...DEFAULT_PREFERENCES, text: "large" };
    expect(resolveEffectivePreferences(explicitlyOff, { reducedMotion: true, contrastMore: true })).toEqual(explicitlyOff);
    expect(resolveEffectivePreferences(ALL_ON, { reducedMotion: false, contrastMore: false })).toEqual(ALL_ON);
  });

  test("the OS defaults never turn on the other switches", () => {
    const effective = resolveEffectivePreferences(null, { reducedMotion: true, contrastMore: true });
    expect({ ...effective, contrast: false, motion: false }).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("attribute application", () => {
  test("every preference maps to its documented attribute", () => {
    const root = fakeRoot();
    applyPreferences(root, ALL_ON);
    expect(Object.fromEntries(root.attrs)).toEqual({
      "data-a11y-text": "x-large",
      "data-a11y-contrast": "",
      "data-a11y-mono": "",
      "data-a11y-dyslexia": "",
      "data-a11y-underline": "",
      "data-a11y-highlight": "",
      "data-a11y-motion": "reduce",
      "data-a11y-user": ""
    });
  });

  test("text size 'large' sets the attribute and 'normal' removes it", () => {
    const root = fakeRoot();
    applyPreferences(root, { ...DEFAULT_PREFERENCES, text: "large" });
    expect(root.attrs.get("data-a11y-text")).toBe("large");
    applyPreferences(root, { ...DEFAULT_PREFERENCES, text: "normal" });
    expect(root.attrs.has("data-a11y-text")).toBe(false);
  });

  test("turning a switch off removes its attribute but keeps the 'has a choice' marker", () => {
    const root = fakeRoot();
    applyPreferences(root, ALL_ON);
    applyPreferences(root, { ...ALL_ON, contrast: false, motion: false });
    expect(root.attrs.has("data-a11y-contrast")).toBe(false);
    expect(root.attrs.has("data-a11y-motion")).toBe(false);
    expect(root.attrs.has("data-a11y-mono")).toBe(true);
    expect(root.attrs.has("data-a11y-user")).toBe(true);
  });

  test("clearing removes every attribute, marker included, so the OS defaults apply again", () => {
    const root = fakeRoot();
    applyPreferences(root, ALL_ON);
    clearAppliedPreferences(root);
    expect([...root.attrs.keys()]).toEqual([]);
    expect(Object.values(ATTRIBUTES).every((name) => !root.attrs.has(name))).toBe(true);
  });

  test("all-off preferences set no preference attribute, only the marker", () => {
    const root = fakeRoot();
    applyPreferences(root, DEFAULT_PREFERENCES);
    expect([...root.attrs.keys()]).toEqual(["data-a11y-user"]);
  });
});

describe("script-driven motion", () => {
  test("with no stored choice the OS decides", () => {
    expect(isMotionReduced(fakeRoot(), true)).toBe(true);
    expect(isMotionReduced(fakeRoot(), false)).toBe(false);
  });

  test("an explicit choice wins in both directions", () => {
    const on = fakeRoot();
    applyPreferences(on, { ...DEFAULT_PREFERENCES, motion: true });
    expect(isMotionReduced(on, false)).toBe(true);

    const off = fakeRoot();
    applyPreferences(off, { ...DEFAULT_PREFERENCES, motion: false });
    expect(isMotionReduced(off, true)).toBe(false);
  });

  test("scroll behaviour is instant while motion is reduced and smooth otherwise", () => {
    const media = (matches: boolean) => ({ matchMedia: () => ({ matches }) });

    expect(preferredScrollBehavior({ documentElement: fakeRoot() }, media(true))).toBe("auto");
    expect(preferredScrollBehavior({ documentElement: fakeRoot() }, media(false))).toBe("smooth");

    const chosen = fakeRoot();
    applyPreferences(chosen, { ...DEFAULT_PREFERENCES, motion: true });
    expect(preferredScrollBehavior({ documentElement: chosen }, media(false))).toBe("auto");

    const offDespiteOs = fakeRoot();
    applyPreferences(offDespiteOs, DEFAULT_PREFERENCES);
    expect(preferredScrollBehavior({ documentElement: offDespiteOs }, media(true))).toBe("smooth");
  });

  test("a browser without matchMedia, or one that throws, counts as 'no OS preference'", () => {
    expect(preferredScrollBehavior({ documentElement: fakeRoot() }, {})).toBe("smooth");
    expect(
      preferredScrollBehavior(
        { documentElement: fakeRoot() },
        {
          matchMedia: () => {
            throw new Error("nope");
          }
        }
      )
    ).toBe("smooth");
  });
});
