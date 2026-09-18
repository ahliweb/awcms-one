/**
 * GA4's CSP widening (issue #56, A10) — `server/penyaji.mjs`'s `buildCsp`
 * gains `script-src`/`connect-src` for GA's own fixed origins ONLY when the
 * build artifact's `ga` flag is `true` (`src/pages/csp.json.ts`'s GA
 * branch, gated by `src/lib/ga.ts`'s `readGaMeasurementId`). Kept as its own
 * file rather than folded into `tests/katalog-csp-media.test.ts`
 * (issue #27/A1's own file, `csp.json.ts`'s img-src/frame-src work) — same
 * "never editing a sibling issue's file" rule
 * `tests/checkout-build-smoke.test.ts`'s own docblock names.
 */
import { describe, expect, test } from "bun:test";
import { buildCsp, CSP } from "../server/penyaji.mjs";
import { isValidGaMeasurementId } from "../src/lib/ga";

describe("buildCsp: the GA branch", () => {
  test("with no artifact, or ga: false, GA never appears anywhere in the policy", () => {
    expect(buildCsp()).toBe(CSP);
    expect(buildCsp({ ga: false })).toBe(CSP);
    expect(CSP).not.toContain("googletagmanager");
    expect(CSP).not.toContain("google-analytics");
  });

  test("ga: true widens script-src and connect-src with exactly GA's own origins", () => {
    const csp = buildCsp({ ga: true });

    expect(csp).toContain(
      "script-src 'self' https://www.googletagmanager.com;"
    );
    expect(csp).toContain(
      "connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com;"
    );

    // Every other directive is untouched — GA must not widen img-src/frame-src.
    expect(csp).toContain("img-src 'self';");
    expect(csp).toContain("frame-src 'none';");
    expect(csp).toContain("style-src 'self';");
  });

  test("ga: true composes cleanly with img-src/connect-src already widened for media/the CMS origin", () => {
    const csp = buildCsp({
      imgSrc: ["https://media.example.com"],
      connectSrc: ["https://cms.example.com"],
      ga: true
    });

    expect(csp).toContain("img-src 'self' https://media.example.com;");
    expect(csp).toContain(
      "connect-src 'self' https://cms.example.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com;"
    );
  });

  test("a non-boolean ga value is treated as false — fail CLOSED, not a coercion surprise", () => {
    expect(buildCsp({ ga: "true" } as never)).toBe(CSP);
    expect(buildCsp({ ga: 1 } as never)).toBe(CSP);
  });
});

describe("the GA measurement id is validated before it ever reaches the CSP decision", () => {
  test("isValidGaMeasurementId is the one gate both BaseLayout.astro and csp.json.ts defer to", () => {
    expect(isValidGaMeasurementId("G-TEST1234")).toBe(true);
    expect(isValidGaMeasurementId(undefined)).toBe(false);
  });
});
