import { describe, expect, test } from "bun:test";
import { isHttpUrl, detectSocialPlatform, resolveSocialIcons } from "../src/lib/ikon-sosial";

/**
 * `src/lib/ikon-sosial.ts` coverage (issue #48's own Tests bullet:
 * "platform detection; URL-scheme filter rejects `javascript:` and
 * schemeless"). Pure functions, no network.
 */

describe("ikon-sosial: isHttpUrl", () => {
  test("accepts http and https", () => {
    expect(isHttpUrl("https://facebook.com/seputarborneo")).toBe(true);
    expect(isHttpUrl("http://facebook.com/seputarborneo")).toBe(true);
  });

  test("rejects a javascript: URL — the stored-XSS case this guard exists for", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  });

  test("rejects a schemeless address — the common admin-typo case (sb_url_sosial()'s own docblock)", () => {
    expect(isHttpUrl("www.tiktok.com/@seputarborneo")).toBe(false);
  });

  test("rejects other schemes (mailto:, data:)", () => {
    expect(isHttpUrl("mailto:redaksi@example.com")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>1</script>")).toBe(false);
  });

  test("rejects an empty string", () => {
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("ikon-sosial: detectSocialPlatform", () => {
  test("detects each of the six platforms this app renders an icon for", () => {
    expect(detectSocialPlatform("https://facebook.com/x")).toBe("facebook");
    expect(detectSocialPlatform("https://www.facebook.com/x")).toBe("facebook");
    expect(detectSocialPlatform("https://x.com/x")).toBe("x");
    expect(detectSocialPlatform("https://twitter.com/x")).toBe("x");
    expect(detectSocialPlatform("https://instagram.com/x")).toBe("instagram");
    expect(detectSocialPlatform("https://youtube.com/@x")).toBe("youtube");
    expect(detectSocialPlatform("https://youtu.be/abc123")).toBe("youtube");
    expect(detectSocialPlatform("https://tiktok.com/@x")).toBe("tiktok");
    expect(detectSocialPlatform("https://threads.net/@x")).toBe("threads");
  });

  test("an unrecognised host returns null — no generic/broken icon", () => {
    expect(detectSocialPlatform("https://example.com/x")).toBeNull();
  });

  test("a javascript: or schemeless URL returns null (the isHttpUrl guard applies here too)", () => {
    expect(detectSocialPlatform("javascript:alert(1)")).toBeNull();
    expect(detectSocialPlatform("www.tiktok.com/@x")).toBeNull();
  });
});

describe("ikon-sosial: resolveSocialIcons", () => {
  test("renders only recognised, safe platforms, in the fixed display order", () => {
    const icons = resolveSocialIcons([
      { platform: "youtube", url: "https://youtube.com/@seputarborneo" },
      { platform: "facebook", url: "https://facebook.com/seputarborneo" }
    ]);
    expect(icons.map((i) => i.platform)).toEqual(["facebook", "youtube"]);
  });

  test("a link with an unrecognised host is silently omitted", () => {
    const icons = resolveSocialIcons([{ platform: "facebook", url: "https://example.com/x" }]);
    expect(icons).toEqual([]);
  });

  test("a link that slipped past the CMS's own filter with a javascript: URL is still rejected here", () => {
    const icons = resolveSocialIcons([{ platform: "facebook", url: "javascript:alert(1)" }]);
    expect(icons).toEqual([]);
  });

  test("two links for the same platform keep only the first", () => {
    const icons = resolveSocialIcons([
      { platform: "facebook", url: "https://facebook.com/a" },
      { platform: "facebook", url: "https://facebook.com/b" }
    ]);
    expect(icons).toHaveLength(1);
    expect(icons[0]?.url).toBe("https://facebook.com/a");
  });
});
