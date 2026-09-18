/**
 * The media-origin CSP (issue #27).
 *
 * Product photos are the first thing this storefront references off its own
 * origin, and `server/penyaji.mjs`'s policy was `img-src 'self'` — under
 * which the browser blocks every one of them SILENTLY: correct HTML, green
 * build, broken page. The origins are therefore derived from the URLs the
 * CMS actually sent for this build and read back by the server at startup.
 *
 * Two halves, tested separately because they fail differently:
 *
 *   - `src/lib/csp-asal-media.ts` — what the BUILD collects. A wrong answer
 *     here writes a policy that is too narrow (images blocked) or names an
 *     origin nothing references.
 *   - `server/penyaji.mjs`'s `buildCsp`/`readCspOrigins`/`sanitizeOrigins` —
 *     what the SERVER does with a file another process wrote. A wrong
 *     answer here is a weakened policy, which is the worse direction, so
 *     every rejection case below is a security assertion rather than a
 *     tidiness one.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  buildCspOriginsArtifact,
  collectOrigins,
  originOf
} from "../src/lib/csp-asal-media";
import { CSP, buildCsp, readCspOrigins } from "../server/penyaji.mjs";

/** Shared by `readCspOrigins` and the `frame-src` describe block below. */
function fixtureDir(contents?: string): URL {
  const dir = mkdtempSync(path.join(tmpdir(), "awcms-one-csp-"));
  if (contents !== undefined) {
    writeFileSync(path.join(dir, "csp.json"), contents, "utf8");
  }
  return pathToFileURL(`${dir}/`);
}

describe("originOf", () => {
  test("returns the origin of an absolute http(s) URL", () => {
    expect(originOf("https://media.example.com/produk/1.webp")).toBe(
      "https://media.example.com"
    );
    expect(originOf("http://localhost:4310/media/x.png")).toBe("http://localhost:4310");
    expect(originOf("https://media.example.com:8443/x.png")).toBe(
      "https://media.example.com:8443"
    );
  });

  test("returns null for anything that is not one", () => {
    // A relative path is already same-origin — `'self'` covers it, and
    // adding an origin for it would be adding one that does not exist.
    expect(originOf("/media/x.png")).toBeNull();
    expect(originOf("data:image/png;base64,iVBOR")).toBeNull();
    expect(originOf("blob:https://example.com/x")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf(null)).toBeNull();
    expect(originOf(undefined)).toBeNull();
    expect(originOf("not a url at all")).toBeNull();
  });
});

describe("collectOrigins", () => {
  test("de-duplicates and sorts, so the artifact is byte-stable across a rebuild that changed nothing", () => {
    const origins = collectOrigins([
      "https://b.example.com/2.png",
      "https://a.example.com/1.png",
      "https://b.example.com/3.png",
      null,
      "/relative.png"
    ]);

    expect(origins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  test("an empty catalog yields an empty list, not a wildcard", () => {
    expect(collectOrigins([])).toEqual([]);
  });
});

describe("buildCspOriginsArtifact", () => {
  test("carries a version and separates img-src from connect-src", () => {
    const artifact = buildCspOriginsArtifact(["https://media.example.com/a.png"]);

    expect(artifact.version).toBe(1);
    expect(artifact.imgSrc).toEqual(["https://media.example.com"]);
    // Issue #30 adds the first browser-side request to another origin; until
    // then this stays empty rather than being pre-widened "just in case".
    expect(artifact.connectSrc).toEqual([]);
  });
});

describe("buildCsp", () => {
  test("with no artifact, every directive is 'self' or 'none' — the baseline CSP", () => {
    expect(buildCsp()).toBe(CSP);
    expect(CSP).toContain("img-src 'self';");
    expect(CSP).toContain("connect-src 'self';");
  });

  test("widens only img-src/connect-src, and only with what it was given", () => {
    const csp = buildCsp({
      imgSrc: ["https://media.example.com"],
      connectSrc: ["https://cms.example.com"]
    });

    expect(csp).toContain("img-src 'self' https://media.example.com;");
    expect(csp).toContain("connect-src 'self' https://cms.example.com;");
    // Everything else is untouched — a widened img-src must not become a
    // widened script-src by accident.
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("frame-src 'none';");
    expect(csp).toContain("object-src 'none';");
    expect(csp).toContain("base-uri 'none';");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("rejects every origin shape that must never reach a CSP directive", () => {
    const csp = buildCsp({
      imgSrc: [
        "*", // the worst possible value
        "https:", // scheme-only wildcard
        "https://media.example.com/path", // carries a path
        "https://media.example.com/", // trailing slash is a path
        "https://user:pw@media.example.com", // credentials
        "https://a.example.com; script-src *", // directive injection
        "https://b.example.com'unsafe-inline'", // quote smuggling
        "ftp://media.example.com", // wrong scheme
        "", // empty
        42, // not a string
        null
      ] as string[]
    });

    expect(csp).toBe(CSP);
    expect(csp).not.toContain("*");
    expect(csp).not.toContain("unsafe-inline");
  });

  test("a non-array artifact field is ignored rather than throwing", () => {
    expect(buildCsp({ imgSrc: "https://media.example.com" as unknown as string[] })).toBe(
      CSP
    );
    expect(buildCsp({} as never)).toBe(CSP);
  });
});

describe("readCspOrigins", () => {
  test("reads a well-formed artifact", () => {
    const dir = fixtureDir(
      JSON.stringify({ version: 1, imgSrc: ["https://media.example.com"], connectSrc: [] })
    );

    expect(readCspOrigins(dir)).toEqual({
      imgSrc: ["https://media.example.com"],
      connectSrc: [],
      frameSrc: [],
      // Issue #56 (A10): the fixture above predates the GA flag and never
      // sets it — `false` is `readCspOrigins`'s own documented default.
      ga: false
    });
  });

  test("degrades to NO external origins when the file is missing, malformed, or an unknown version", () => {
    // Each of these is a real state: a fresh checkout with no dist/, a
    // partially written file, and a container running an older server
    // against a newer client bundle. All three must fail CLOSED — a
    // missing artifact costs images (visible, fixed by a rebuild); a
    // wrongly-wide default silently weakens a policy nobody asked to widen.
    // Issue #56 (A10) added the `ga` flag, always `false` in every one of
    // these degraded/fail-closed states; issue #47 added `frameSrc`, always
    // `[]` in the same states.
    const EMPTY = { imgSrc: [], connectSrc: [], frameSrc: [], ga: false };
    expect(readCspOrigins(fixtureDir())).toEqual(EMPTY);
    expect(readCspOrigins(fixtureDir("{ not json"))).toEqual(EMPTY);
    expect(readCspOrigins(fixtureDir("[]"))).toEqual(EMPTY);
    expect(
      readCspOrigins(fixtureDir(JSON.stringify({ version: 2, imgSrc: ["https://x.test"] })))
    ).toEqual(EMPTY);
  });

  test("an artifact written before frameSrc/ga existed reads back frameSrc: [] and ga: false — not malformed", () => {
    const dir = fixtureDir(
      JSON.stringify({ version: 1, imgSrc: ["https://media.example.com"], connectSrc: [] })
    );
    expect(readCspOrigins(dir).frameSrc).toEqual([]);
    expect(readCspOrigins(dir).ga).toBe(false);
  });

  test("the artifact the build writes is exactly what the server can read back", () => {
    // The two halves are written in different languages against different
    // runtimes; this is the one test that binds them together.
    const artifact = buildCspOriginsArtifact([
      "https://media.example.com/produk/1.webp",
      "https://media.example.com/produk/2.webp"
    ]);

    const dir = fixtureDir(JSON.stringify(artifact));

    expect(buildCsp(readCspOrigins(dir))).toContain(
      "img-src 'self' https://media.example.com;"
    );
  });
});

describe("frame-src (issue #47 — the click-to-load YouTube facade)", () => {
  test("a video post's build serves frame-src widened to the youtube-nocookie origin", () => {
    // Mirrors exactly what src/pages/csp.json.ts writes once getVideo()
    // answers at least one post — see that file's own docblock: the poster
    // origin goes to img-src, the embed origin to frame-src, both only when
    // a video post exists in this build.
    const artifact = buildCspOriginsArtifact(
      ["https://media.example.com/berita/foto.jpg", "https://i.ytimg.com/vi/x/hqdefault.jpg"],
      ["https://cms.example.com"],
      ["https://www.youtube-nocookie.com"]
    );

    const dir = fixtureDir(JSON.stringify(artifact));
    const csp = buildCsp(readCspOrigins(dir));

    expect(csp).toContain("frame-src https://www.youtube-nocookie.com;");
    // `'none'` and a real origin are not meant to combine in one directive.
    expect(csp.split("frame-src")[1]?.split(";")[0]).not.toContain("'none'");
  });

  test("a build with no video post keeps the baseline frame-src 'none'", () => {
    const artifact = buildCspOriginsArtifact(["https://media.example.com/produk/1.webp"]);
    expect(buildCsp(artifact)).toContain("frame-src 'none';");
  });

  test("rejects an unsafe frameSrc origin the same way img-src/connect-src already do", () => {
    const csp = buildCsp({
      frameSrc: ["javascript:alert(1)", "*", "https://www.youtube-nocookie.com"]
    });
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com;");
    expect(csp).not.toContain("javascript:");
    expect(csp).not.toContain("*");
  });
});
