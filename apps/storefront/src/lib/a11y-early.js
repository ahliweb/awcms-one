/*
 * Early-apply for the reading-preferences panel (issue #539, ADR-0057).
 *
 * A same-origin CLASSIC, BLOCKING script (no `defer`, no `async`, no module)
 * linked from the top of `<head>` by `src/layouts/BaseLayout.astro`, so the
 * visitor's stored choices are on `<html>` before the first paint and the page
 * never flashes in the wrong size or contrast. It is a file rather than an
 * inline script because `script-src 'self'` (server/penyaji.mjs) blocks inline
 * script bodies; it is plain ES5 and not part of the bundle because a bundled
 * module is deferred, which would reintroduce exactly that flash.
 *
 * It repeats the read-validate-apply half of `src/lib/a11y-preferences.ts`.
 * `tests/a11y-early.test.ts` runs both against the same inputs and fails if
 * they disagree, so the two cannot drift apart unnoticed.
 *
 * Contract: reads `localStorage["awcms-a11y"]`; anything that is not a
 * complete version-1 object is ignored (the OS defaults then apply through
 * CSS); every access is guarded because `localStorage` itself throws in some
 * private/blocked-storage profiles; it never throws, never writes storage and
 * never sends anything anywhere.
 */
(function () {
  try {
    var raw = window.localStorage.getItem("awcms-a11y");
    if (typeof raw !== "string" || raw === "") return;

    var prefs = JSON.parse(raw);
    if (typeof prefs !== "object" || prefs === null || Array.isArray(prefs)) return;
    if (prefs.v !== 1) return;
    if (prefs.text !== "normal" && prefs.text !== "large" && prefs.text !== "x-large") return;

    var switches = ["contrast", "mono", "dyslexia", "underline", "highlight", "motion"];
    for (var i = 0; i < switches.length; i++) {
      if (typeof prefs[switches[i]] !== "boolean") return;
    }

    var root = document.documentElement;
    if (prefs.text !== "normal") root.setAttribute("data-a11y-text", prefs.text);
    if (prefs.contrast) root.setAttribute("data-a11y-contrast", "");
    if (prefs.mono) root.setAttribute("data-a11y-mono", "");
    if (prefs.dyslexia) root.setAttribute("data-a11y-dyslexia", "");
    if (prefs.underline) root.setAttribute("data-a11y-underline", "");
    if (prefs.highlight) root.setAttribute("data-a11y-highlight", "");
    if (prefs.motion) root.setAttribute("data-a11y-motion", "reduce");
    root.setAttribute("data-a11y-user", "");
  } catch (error) {
    /* Blocked storage or a corrupt value: fall back to the OS defaults. */
  }
})();
