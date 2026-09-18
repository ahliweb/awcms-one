/**
 * The GA4 `dataLayer`/`gtag` bootstrap (issue #56, A10) —
 * `src/scripts/ga-init.ts`, an ordinary same-origin bundled module rather
 * than the inline `<script>` Google's own snippet normally uses (see that
 * file's docblock for why: an inline script body is blocked by this app's
 * CSP no matter what `script-src` allows). `gtag`/`initGa` are pure enough
 * to test against a plain object standing in for `window`.
 *
 * PR #64 review fix: `gtag.js` only recognises a `dataLayer` entry as a
 * command when it is a real `arguments` object
 * (`Object.prototype.toString.call(entry) === "[object Arguments]"`) — a
 * plain `Array` (what a naive `push([...args])` produces) is silently
 * discarded, so GA would load but never receive a page view or `config`
 * call. Every assertion below checks the ACTUAL runtime shape
 * `gtag()`/`initGa()` push, not just its values.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { gtag, initGa } from "../src/scripts/ga-init";

// `bun test` has no DOM: stand in a plain object for the global `window`
// this module reads/writes, fresh for every test.
beforeEach(() => {
  (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
  window.dataLayer = undefined;
});

/** `[object Arguments]`, not `[object Array]` — see file docblock. */
function isArgumentsObject(value: unknown): boolean {
  return Object.prototype.toString.call(value) === "[object Arguments]";
}

describe("gtag", () => {
  test("creates window.dataLayer lazily and pushes a real `arguments` object per call", () => {
    gtag("js", "one");
    gtag("config", "G-TEST", { anonymize_ip: true });

    expect(window.dataLayer).toHaveLength(2);
    expect(window.dataLayer!.every(isArgumentsObject)).toBe(true);

    expect(Array.from(window.dataLayer![0] as ArrayLike<unknown>)).toEqual(["js", "one"]);
    expect(Array.from(window.dataLayer![1] as ArrayLike<unknown>)).toEqual([
      "config",
      "G-TEST",
      { anonymize_ip: true }
    ]);
  });

  test("never pushes a plain array — the exact shape gtag.js discards", () => {
    gtag("js", "one");
    expect(Array.isArray(window.dataLayer![0])).toBe(false);
  });
});

describe("initGa", () => {
  test("sends exactly the js/config pair, each a real arguments object, with anonymize_ip set", () => {
    initGa("G-TEST1234");

    expect(window.dataLayer).toHaveLength(2);
    expect(window.dataLayer!.every(isArgumentsObject)).toBe(true);

    const [jsCall, configCall] = window.dataLayer!.map((entry) =>
      Array.from(entry as ArrayLike<unknown>)
    );
    expect(jsCall![0]).toBe("js");
    expect(jsCall![1]).toBeInstanceOf(Date);
    expect(configCall).toEqual(["config", "G-TEST1234", { anonymize_ip: true }]);
  });
});
