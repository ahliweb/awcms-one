/**
 * Issue #30's own CSP acceptance criterion: "the CSP in the built server
 * output contains the CMS origin in `connect-src` and nowhere else" —
 * ties `requireAwcmsOrigin` (`toko-origin.ts`) → `buildCspOriginsArtifact`
 * (`csp-asal-media.ts`, the SAME mechanism issue #27 built, extended rather
 * than duplicated per the manager's own instruction) → `buildCsp`
 * (`server/penyaji.mjs`) end to end, the way `csp.json.ts` actually wires
 * them at build time.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { requireAwcmsOrigin } from "../src/lib/awcms/toko-origin";
import { buildCspOriginsArtifact } from "../src/lib/csp-asal-media";
import { buildCsp } from "../server/penyaji.mjs";

const ORIGINAL = process.env.PUBLIC_AWCMS_ORIGIN;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PUBLIC_AWCMS_ORIGIN;
  else process.env.PUBLIC_AWCMS_ORIGIN = ORIGINAL;
});

describe("PUBLIC_AWCMS_ORIGIN ends up in connect-src, exactly once, and nowhere else", () => {
  test("the full build-time chain", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";

    const origin = requireAwcmsOrigin();
    const artifact = buildCspOriginsArtifact(["https://media.example.com/a.png"], [origin]);
    const csp = buildCsp(artifact);

    // Exactly one `connect-src` directive in the whole policy string.
    expect(csp.match(/connect-src/g)).toHaveLength(1);
    expect(csp).toContain("connect-src 'self' https://cms.example.com;");

    // The CMS origin never leaks into img-src, and the media origin never
    // leaks into connect-src — the two artifact fields stay independent.
    expect(csp).toContain("img-src 'self' https://media.example.com;");
    expect(csp.split("connect-src")[1]?.split(";")[0]).not.toContain("media.example.com");
  });

  test("connect-src carries no other origin when only PUBLIC_AWCMS_ORIGIN is configured", () => {
    process.env.PUBLIC_AWCMS_ORIGIN = "https://cms.example.com";
    const artifact = buildCspOriginsArtifact([], [requireAwcmsOrigin()]);
    expect(artifact.connectSrc).toEqual(["https://cms.example.com"]);
  });
});
