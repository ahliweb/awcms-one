/**
 * `src/lib/a11y-early.js` (served as `/a11y-early.js`, issue #539, ADR-0057) is the plain-ES5 twin of the
 * read-validate-apply half of `src/lib/a11y-preferences.ts`: it must run as a
 * blocking classic script before first paint, so it cannot import the module.
 * Two copies of one rule drift, so this test runs the real file and the module
 * against the same stored values and requires the same `<html>` attributes.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  A11Y_STORAGE_KEY,
  applyPreferences,
  parsePreferences,
  type A11yPreferences
} from "../src/lib/a11y-preferences";

const SOURCE = readFileSync(new URL("../src/lib/a11y-early.js", import.meta.url), "utf8");

type Attributes = Record<string, string>;

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name)
  };
}

/** Runs the real early script against a `window.localStorage` stand-in. */
function runEarly(localStorage: { getItem(key: string): string | null } | "throws-on-access"): Attributes {
  const root = fakeRoot();
  const win =
    localStorage === "throws-on-access"
      ? Object.defineProperty({}, "localStorage", {
          get() {
            throw new Error("SecurityError");
          }
        })
      : { localStorage };
  new Function("window", "document", SOURCE)(win, { documentElement: root });
  return Object.fromEntries(root.attrs);
}

/** What the module would put on `<html>` for the same raw stored value. */
function viaModule(raw: string | null): Attributes {
  const root = fakeRoot();
  const parsed = parsePreferences(raw);
  if (parsed) applyPreferences(root, parsed);
  return Object.fromEntries(root.attrs);
}

function storing(raw: string | null) {
  return {
    getItem(key: string) {
      expect(key).toBe(A11Y_STORAGE_KEY);
      return raw;
    }
  };
}

const VALID: A11yPreferences = {
  v: 1,
  text: "large",
  contrast: true,
  mono: false,
  dyslexia: true,
  underline: false,
  highlight: true,
  motion: true
};

describe("a11y-early.js", () => {
  test("applies a stored preference exactly like the module does", () => {
    const raw = JSON.stringify(VALID);
    expect(runEarly(storing(raw))).toEqual(viaModule(raw));
    expect(runEarly(storing(raw))).toEqual({
      "data-a11y-text": "large",
      "data-a11y-contrast": "",
      "data-a11y-dyslexia": "",
      "data-a11y-highlight": "",
      "data-a11y-motion": "reduce",
      "data-a11y-user": ""
    });
  });

  test("agrees with the module on every kind of unusable stored value", () => {
    const valid = VALID as unknown as Record<string, unknown>;
    const cases: Array<string | null> = [
      null,
      "",
      "{not json",
      "null",
      "[]",
      '"large"',
      "7",
      JSON.stringify({ ...valid, v: 2 }),
      JSON.stringify({ ...valid, v: "1" }),
      JSON.stringify({ ...valid, text: "huge" }),
      JSON.stringify({ ...valid, text: 2 }),
      JSON.stringify({ ...valid, contrast: "true" }),
      JSON.stringify({ ...valid, motion: 1 }),
      JSON.stringify({ ...valid, mono: undefined }),
      // Valid forms the module accepts, so a rule can't be tightened in one place only.
      JSON.stringify({ ...valid, text: "normal" }),
      JSON.stringify({ ...valid, text: "x-large" }),
      JSON.stringify({ ...valid, future: "ignored" })
    ];

    for (const raw of cases) {
      expect(runEarly(storing(raw))).toEqual(viaModule(raw));
    }
  });

  test("never throws when storage is blocked, and leaves the page on the OS defaults", () => {
    expect(runEarly("throws-on-access")).toEqual({});
    expect(
      runEarly({
        getItem() {
          throw new Error("SecurityError");
        }
      })
    ).toEqual({});
  });

  test("is a classic script: no module syntax, nothing sent anywhere, no storage write", () => {
    expect(SOURCE).not.toMatch(/^\s*(import|export)\s/m);
    expect(SOURCE).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|setItem|removeItem|document\.write|eval\(/);
  });
});
