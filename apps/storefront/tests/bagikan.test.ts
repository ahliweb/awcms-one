import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildShareLinks, resolveFollowLinks, WHATSAPP_ICON_PATH } from "../src/lib/bagikan";
import { SOCIAL_ICON_PATHS } from "../src/lib/ikon-sosial";
import {
  bagikanKeInstagram,
  PESAN_GAGAL_SALIN,
  PESAN_TERSALIN,
  type KemampuanBagikan
} from "../src/scripts/bagikan";

/**
 * Issue #51's Acceptance bullets, one `describe` each:
 *
 * 1. URL builders encode title/URL; TikTok/YouTube omitted when absent;
 *    the `http(s)`-only scheme filter (`src/lib/bagikan.ts`).
 * 2. The Instagram button's Web Share → clipboard → visible-failure
 *    decision table (`src/scripts/bagikan.ts`), driven through an injected
 *    `KemampuanBagikan` — `bun test` has no `navigator.share`, and a real
 *    one needs a user gesture anyway.
 * 3. No third-party share script anywhere in `src/` — the grep test.
 */

const SHARE_URL = "https://berita.example.com/berita/bupati-resmikan-jembatan?utm=x&y=1";
const TITLE = "Bupati & DPRD: \"Jembatan Baru\" #Kobar resmi?";

describe("bagikan: buildShareLinks", () => {
  test("renders exactly the four real share platforms, in seputarborneo's fixed order", () => {
    const links = buildShareLinks(SHARE_URL, TITLE);
    expect(links.map((l) => l.platform)).toEqual(["facebook", "x", "whatsapp", "threads"]);
  });

  test("encodes the URL — its own `?`/`&`/`:`/`/` never leak into the intent's query string", () => {
    const encodedUrl = encodeURIComponent(SHARE_URL);
    for (const link of buildShareLinks(SHARE_URL, TITLE)) {
      expect(link.href).toContain(encodedUrl);
      // The raw URL must not appear unencoded anywhere after the intent's own `?`.
      const query = link.href.slice(link.href.indexOf("?") + 1);
      expect(query).not.toContain("https://berita.example.com");
      expect(query).not.toContain("&y=1");
    }
  });

  test("encodes the title — `&`, `#`, `?` and quotes would otherwise truncate the intent", () => {
    const encodedTitle = encodeURIComponent(TITLE);
    const [facebook, x, whatsapp, threads] = buildShareLinks(SHARE_URL, TITLE);

    expect(x!.href).toContain(`text=${encodedTitle}`);
    expect(whatsapp!.href).toContain(`text=${encodedTitle}%20`);
    expect(threads!.href).toContain(`text=${encodedTitle}%20`);
    for (const link of [x!, whatsapp!, threads!]) {
      expect(link.href).not.toContain("#Kobar");
      expect(link.href).not.toContain('"Jembatan');
    }

    // Facebook's sharer takes only `u=` and reads the title from OG tags.
    expect(facebook!.href).toBe(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SHARE_URL)}`);
  });

  test("uses exactly the endpoints issue #51 names", () => {
    const [facebook, x, whatsapp, threads] = buildShareLinks(SHARE_URL, TITLE);
    expect(facebook!.href.startsWith("https://www.facebook.com/sharer/sharer.php?u=")).toBe(true);
    expect(x!.href.startsWith("https://twitter.com/intent/tweet?url=")).toBe(true);
    expect(x!.href).toContain("&text=");
    expect(whatsapp!.href.startsWith("https://wa.me/?text=")).toBe(true);
    expect(threads!.href.startsWith("https://www.threads.net/intent/post?text=")).toBe(true);
  });

  test("every control carries a full accessible name with the SHARE verb", () => {
    expect(buildShareLinks(SHARE_URL, TITLE).map((l) => l.label)).toEqual([
      "Bagikan ke Facebook",
      "Bagikan ke X",
      "Bagikan ke WhatsApp",
      "Bagikan ke Threads"
    ]);
  });

  test("reuses A2's glyphs for the platforms it already ships; WhatsApp is the one new path", () => {
    const [facebook, x, whatsapp, threads] = buildShareLinks(SHARE_URL, TITLE);
    expect(facebook!.pathData).toBe(SOCIAL_ICON_PATHS.facebook);
    expect(x!.pathData).toBe(SOCIAL_ICON_PATHS.x);
    expect(threads!.pathData).toBe(SOCIAL_ICON_PATHS.threads);
    expect(whatsapp!.pathData).toBe(WHATSAPP_ICON_PATH);
    expect(Object.values(SOCIAL_ICON_PATHS)).not.toContain(WHATSAPP_ICON_PATH);
  });
});

describe("bagikan: resolveFollowLinks", () => {
  test("TikTok and YouTube are omitted entirely when the site profile has neither", () => {
    expect(resolveFollowLinks([])).toEqual([]);
    expect(
      resolveFollowLinks([
        { platform: "Facebook", url: "https://facebook.com/bjekmart" },
        { platform: "Instagram", url: "https://instagram.com/bjekmart" }
      ])
    ).toEqual([]);
  });

  test("renders a configured account with the FOLLOW verb, in TikTok-then-YouTube order regardless of CMS order", () => {
    const links = resolveFollowLinks([
      { platform: "YouTube", url: "https://www.youtube.com/@bjekmart" },
      { platform: "TikTok", url: "https://www.tiktok.com/@bjekmart" }
    ]);
    expect(links.map((l) => [l.platform, l.label, l.href])).toEqual([
      ["tiktok", "Ikuti kami di TikTok", "https://www.tiktok.com/@bjekmart"],
      ["youtube", "Ikuti kami di YouTube", "https://www.youtube.com/@bjekmart"]
    ]);
    expect(links[0]!.pathData).toBe(SOCIAL_ICON_PATHS.tiktok);
    expect(links[1]!.pathData).toBe(SOCIAL_ICON_PATHS.youtube);
  });

  test("a missing TikTok never shifts YouTube — the row shows one follow link, not a gap", () => {
    const links = resolveFollowLinks([{ platform: "YouTube", url: "https://youtu.be/abc" }]);
    expect(links.map((l) => l.platform)).toEqual(["youtube"]);
  });

  test("scheme filter: javascript:, data:, and a schemeless address are dropped even when labelled TikTok", () => {
    expect(resolveFollowLinks([{ platform: "TikTok", url: "javascript:alert(1)" }])).toEqual([]);
    expect(resolveFollowLinks([{ platform: "TikTok", url: "data:text/html,x" }])).toEqual([]);
    expect(resolveFollowLinks([{ platform: "TikTok", url: "www.tiktok.com/@bjekmart" }])).toEqual([]);
  });

  test("the platform is decided by HOSTNAME, never by the CMS-typed label", () => {
    // Labelled "TikTok" but pointing at Facebook — not a follow link at all.
    expect(resolveFollowLinks([{ platform: "TikTok", url: "https://facebook.com/bjekmart" }])).toEqual([]);
    // Labelled anything, pointing at tiktok.com — is TikTok.
    expect(
      resolveFollowLinks([{ platform: "medsos", url: "https://tiktok.com/@bjekmart" }]).map((l) => l.platform)
    ).toEqual(["tiktok"]);
  });
});

describe("bagikan: bagikanKeInstagram (Web Share → clipboard → visible failure)", () => {
  const data = { title: TITLE, url: SHARE_URL };

  function statusRecorder(): { pesan: string[]; tampilkan: (t: string) => void } {
    const pesan: string[] = [];
    return { pesan, tampilkan: (t) => pesan.push(t) };
  }

  test("prefers navigator.share and passes exactly { title, url }; no status is announced", async () => {
    const calls: Array<{ title: string; url: string }> = [];
    const kemampuan: KemampuanBagikan = {
      share: async (d) => {
        calls.push(d);
      },
      tulisPapanKlip: async () => {
        throw new Error("must not be reached");
      }
    };
    const status = statusRecorder();

    expect(await bagikanKeInstagram(data, kemampuan, status.tampilkan)).toBe("share");
    expect(calls).toEqual([data]);
    expect(status.pesan).toEqual([]);
  });

  test("a dismissed share sheet (AbortError) is silent — no clipboard, no status", async () => {
    let clipboardCalls = 0;
    const kemampuan: KemampuanBagikan = {
      share: async () => {
        throw new DOMException("dismissed", "AbortError");
      },
      tulisPapanKlip: async () => {
        clipboardCalls += 1;
      }
    };
    const status = statusRecorder();

    expect(await bagikanKeInstagram(data, kemampuan, status.tampilkan)).toBe("batal");
    expect(clipboardCalls).toBe(0);
    expect(status.pesan).toEqual([]);
  });

  test("any other share() rejection falls through to the clipboard, with the visible 'Tautan disalin' status", async () => {
    const copied: string[] = [];
    const kemampuan: KemampuanBagikan = {
      share: async () => {
        throw new DOMException("no gesture", "NotAllowedError");
      },
      tulisPapanKlip: async (t) => {
        copied.push(t);
      }
    };
    const status = statusRecorder();

    expect(await bagikanKeInstagram(data, kemampuan, status.tampilkan)).toBe("salin");
    expect(copied).toEqual([SHARE_URL]); // the SHARE_URL only — never the title, never a title+SHARE_URL blob
    expect(status.pesan).toEqual([PESAN_TERSALIN]);
  });

  test("no Web Share API at all (desktop) goes straight to the clipboard", async () => {
    const copied: string[] = [];
    const status = statusRecorder();

    expect(
      await bagikanKeInstagram(
        data,
        {
          tulisPapanKlip: async (t) => {
            copied.push(t);
          }
        },
        status.tampilkan
      )
    ).toBe("salin");
    expect(copied).toEqual([SHARE_URL]);
    expect(status.pesan).toEqual([PESAN_TERSALIN]);
  });

  test("clipboard denied/unavailable ends in a VISIBLE failure status, never a silent no-op or a prompt()", async () => {
    const denied = statusRecorder();
    expect(
      await bagikanKeInstagram(
        data,
        {
          tulisPapanKlip: async () => {
            throw new DOMException("denied", "NotAllowedError");
          }
        },
        denied.tampilkan
      )
    ).toBe("gagal");
    expect(denied.pesan).toEqual([PESAN_GAGAL_SALIN]);

    const missing = statusRecorder();
    expect(await bagikanKeInstagram(data, {}, missing.tampilkan)).toBe("gagal");
    expect(missing.pesan).toEqual([PESAN_GAGAL_SALIN]);
  });
});

describe("bagikan: no third-party share script (issue #51's grep test)", () => {
  const SRC_ROOT = new URL("../src/", import.meta.url).pathname;

  /** Recursively lists every source file under `src/` — the whole app, not only this issue's files. */
  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
      else if (/\.(astro|ts|mjs|js|css)$/.test(entry)) out.push(full);
    }
    return out;
  }

  /**
   * The SDK/widget hosts each platform's "official" share button loads
   * from. None may appear anywhere under `src/`: every share control is a
   * plain intent link or this app's own bundled module, and
   * `script-src 'self'` (`server/penyaji.mjs`) would block them anyway —
   * silently, at runtime — so the grep catches the mistake at test time
   * instead.
   */
  const FORBIDDEN = [
    "connect.facebook.net",
    "platform.twitter.com",
    "platform.x.com",
    "platform.instagram.com",
    "www.instagram.com/embed.js",
    "www.tiktok.com/embed.js",
    "platform.threads.net",
    "apis.google.com/js/platform.js",
    "FB.XFBML",
    "twttr.widgets"
  ];

  test("src/ references no Facebook SDK, Twitter/X widgets, Instagram/TikTok/Threads embed script", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push(`${file.slice(SRC_ROOT.length)}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the share row's own script is an external module import, never inline", () => {
    const component = readFileSync(join(SRC_ROOT, "components", "berita", "BarisBagikan.astro"), "utf8");
    expect(component).toContain('import "../../scripts/bagikan"');
    expect(component).not.toMatch(/<script[^>]*is:inline/);
  });
});
