/**
 * The GA4 `dataLayer`/`gtag` bootstrap (issue #56, A10) —
 * `src/scripts/ga-init.ts`, an ordinary same-origin bundled module rather
 * than the inline `<script>` Google's own snippet normally uses (see that
 * file's docblock for why: an inline script body is blocked by this app's
 * CSP no matter what `script-src` allows). `gtag`/`initGa` are pure enough
 * to test against a plain object standing in for `window`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { gtag, initGa } from "../src/scripts/ga-init";

// `bun test` has no DOM: stand in a plain object for the global `window`
// this module reads/writes, fresh for every test.
beforeEach(() => {
  (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
  window.dataLayer = undefined;
});

describe("gtag", () => {
  test("creates window.dataLayer lazily and pushes its arguments", () => {
    gtag("js", "one");
    gtag("config", "G-TEST", { anonymize_ip: true });

    expect(window.dataLayer).toEqual([
      ["js", "one"],
      ["config", "G-TEST", { anonymize_ip: true }]
    ]);
  });
});

describe("initGa", () => {
  test("sends exactly the js/config pair, with anonymize_ip set", () => {
    initGa("G-TEST1234");

    expect(window.dataLayer).toEqual([
      ["js", expect.any(Date)],
      ["config", "G-TEST1234", { anonymize_ip: true }]
    ]);
  });
});
