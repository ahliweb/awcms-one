import { describe, expect, test } from "bun:test";
import {
  renderPortableText,
  documentHasPlayableVideo,
  extractPlayableVideoInfo,
  collectGalleryMediaObjectIds
} from "../src/lib/portable-text";
import type { ResolvedMedia } from "../src/lib/awcms/media";

/**
 * Issue #28's extension of `src/lib/portable-text.ts` — a NEW file rather
 * than an edit to `tests/portable-text.test.ts` (issue #24's own suite,
 * outside this issue's file ownership), per this issue's own instruction to
 * keep that file's assertions green rather than editing them. Every one of
 * #24's own gallery/videoNews assertions still passes unmodified against
 * the extended renderer — see `src/lib/portable-text.ts`'s own docblock for
 * why (their fixtures carry no `caption`/`provider`/`videoId`, which is
 * exactly the "not enough to render" case that still falls back to the
 * original placeholder).
 *
 * Issue #47 UPDATES the assertion below that named the deliberate issue-#28
 * trim this issue explicitly lifts ("never an `<img>`" for a well-formed
 * `videoNews` block) — see `src/lib/portable-text.ts`'s own docblock, "The
 * public signature DOES change", for why updating rather than leaving it
 * red is correct here.
 *
 * A PR #65 review finding then split this into TWO modes rather than one
 * unconditional facade: `renderPortableText`'s new `options.videoMode`
 * defaults to `"link"` (the original issue-#28 rendering, safe on every
 * page) and only renders the facade when a caller explicitly opts in with
 * `{ videoMode: "facade" }` — because the facade's `<button>` is inert
 * without `video-facade.ts` mounted, which only `/video/[slug].astro` does.
 * Both modes are asserted below.
 */
describe("lib/portable-text: videoNews (issue #28 link, facade opt-in added by #47)", () => {
  const VIDEO_NODE = {
    _type: "videoNews",
    _key: "v1",
    provider: "youtube",
    videoId: "dQw4w9WgXcQ",
    title: "Kebakaran Pasar Kobar",
    sourceLabel: "Warga sekitar",
    durationSeconds: 95,
    caption: "Api cepat menjalar."
  };

  test("videoMode: 'facade' renders a click-to-load facade — a poster <img>, never an <iframe> before activation", () => {
    const html = renderPortableText([VIDEO_NODE], new Map(), { videoMode: "facade" });

    expect(html).toContain('data-video-id="dQw4w9WgXcQ"');
    expect(html).toContain('src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"');
    expect(html).toContain("<button");
    expect(html).toContain("Kebakaran Pasar Kobar");
    expect(html).toContain("Warga sekitar");
    expect(html).toContain("1:35"); // 95s -> 1:35
    expect(html).toContain("Api cepat menjalar.");
    // The watch URL survives ONLY as the <noscript> fallback — no third-party
    // frame/script loads before a real click (`video-facade.ts`).
    expect(html).toContain('<noscript><a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).not.toContain("<iframe");
  });

  test("the DEFAULT (no options, or videoMode: 'link') renders the original real outbound link — no <button>, no <img>, no facade markup", () => {
    const defaulted = renderPortableText([VIDEO_NODE]);
    const explicit = renderPortableText([VIDEO_NODE], new Map(), { videoMode: "link" });
    expect(defaulted).toBe(explicit);

    expect(defaulted).toContain('<a class="content-video-link" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(defaulted).toContain("Kebakaran Pasar Kobar");
    expect(defaulted).toContain("Warga sekitar");
    expect(defaulted).toContain("1:35");
    expect(defaulted).toContain("Api cepat menjalar.");
    expect(defaulted).toContain('rel="noopener noreferrer"');
    expect(defaulted).not.toContain("<button");
    expect(defaulted).not.toContain("<img");
    expect(defaulted).not.toContain("data-video-facade");
  });

  test("an unrecognised provider still degrades to the original issue-#24 placeholder", () => {
    const html = renderPortableText([
      { _type: "videoNews", _key: "v1", provider: "vimeo", videoId: "12345678901" }
    ]);
    expect(html).toContain("Video");
    expect(html).toContain("content-placeholder");
    expect(html).not.toContain("<a");
  });

  test("a videoId that is not the bare 11-character form degrades to the placeholder", () => {
    const html = renderPortableText([
      { _type: "videoNews", _key: "v1", provider: "youtube", videoId: "https://youtu.be/dQw4w9WgXcQ" }
    ]);
    expect(html).toContain("content-placeholder");
  });

  test("documentHasPlayableVideo is true only for a well-formed videoNews block", () => {
    expect(
      documentHasPlayableVideo([
        { _type: "videoNews", _key: "v1", provider: "youtube", videoId: "dQw4w9WgXcQ" }
      ])
    ).toBe(true);

    expect(documentHasPlayableVideo([{ _type: "videoNews", _key: "v1" }])).toBe(false);
    expect(documentHasPlayableVideo([{ _type: "block", _key: "b1" }])).toBe(false);
    expect(documentHasPlayableVideo(null)).toBe(false);
    expect(documentHasPlayableVideo(undefined)).toBe(false);
    expect(documentHasPlayableVideo("not an array")).toBe(false);
  });
});

describe("lib/portable-text: gallery captions (issue #28 — 'figures with credit')", () => {
  test("a gallery item WITH a caption renders a real <figure>/<figcaption>, never an <img>", () => {
    const html = renderPortableText([
      {
        _type: "gallery",
        _key: "g1",
        items: [{ mediaObjectId: "x", caption: "Foto: Antara/Budi" }]
      }
    ]);
    expect(html).toContain("<figure");
    expect(html).toContain("<figcaption>Foto: Antara/Budi</figcaption>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("Galeri (");
  });

  test("a gallery with ONLY uncaptioned items still degrades to the original issue-#24 placeholder", () => {
    const html = renderPortableText([
      { _type: "gallery", _key: "g1", items: [{ mediaObjectId: "x" }, { mediaObjectId: "y" }] }
    ]);
    expect(html).toContain("Galeri (2 gambar)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<figure");
  });

  test("a mix of captioned and uncaptioned items renders one <figure> per item, captioned or not", () => {
    const html = renderPortableText([
      {
        _type: "gallery",
        _key: "g1",
        items: [{ mediaObjectId: "x", caption: "Berkredit" }, { mediaObjectId: "y" }]
      }
    ]);
    expect(html).toContain("<figcaption>Berkredit</figcaption>");
    // Two figures rendered even though only one item has a caption.
    expect(html.split("<figure").length - 1).toBe(2);
  });

  test("a caption is HTML-escaped — no injection through it", () => {
    const html = renderPortableText([
      { _type: "gallery", _key: "g1", items: [{ mediaObjectId: "x", caption: "</figcaption><script>alert(1)</script>" }] }
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("lib/portable-text: gallery images resolve to real <img> (issue #47)", () => {
  const resolved: ResolvedMedia = {
    id: "x",
    publicUrl: "https://media.example.test/foto.jpg",
    alt: "Warga menyeberang jembatan baru",
    width: 1200,
    height: 800,
    creditLine: "Humas Pemkab",
    sourceName: "Pemkab Kotawaringin Barat",
    copyrightStatus: "permission_granted"
  };

  test("an item with mediaType image and a resolved mediaObjectId renders a real <img> with width/height/alt", () => {
    const html = renderPortableText(
      [
        {
          _type: "gallery",
          _key: "g1",
          items: [{ mediaType: "image", mediaObjectId: "x", caption: "Warga menyaksikan peresmian" }]
        }
      ],
      new Map([["x", resolved]])
    );

    expect(html).toContain('<img src="https://media.example.test/foto.jpg"');
    expect(html).toContain('width="1200" height="800"');
    expect(html).toContain('alt="Warga menyeberang jembatan baru"');
    // Caption AND credit both make it into the figcaption.
    expect(html).toContain("Warga menyaksikan peresmian");
    expect(html).toContain("Humas Pemkab");
    expect(html).toContain("Pemkab Kotawaringin Barat");
  });

  test("an item whose mediaObjectId does NOT resolve degrades to the placeholder figure, never a broken <img>", () => {
    const html = renderPortableText(
      [
        {
          _type: "gallery",
          _key: "g1",
          items: [{ mediaType: "image", mediaObjectId: "missing", caption: "Ada teks" }]
        }
      ],
      new Map() // "missing" never resolves.
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("content-figure-placeholder");
    expect(html).toContain("Ada teks");
  });

  test("a mediaType: video item never renders an <img>, even with a matching resolvedMedia entry", () => {
    const html = renderPortableText(
      [{ _type: "gallery", _key: "g1", items: [{ mediaType: "video", mediaObjectId: "x", caption: "Video" }] }],
      new Map([["x", resolved]])
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("Video");
  });

  test("renderPortableText defaults resolvedMedia to empty — an existing single-argument call site keeps compiling and degrading the same way", () => {
    const html = renderPortableText([
      { _type: "gallery", _key: "g1", items: [{ mediaType: "image", mediaObjectId: "x" }] }
    ]);
    expect(html).toContain("Galeri (1 gambar)");
  });
});

describe("lib/portable-text: extractPlayableVideoInfo / collectGalleryMediaObjectIds (issue #47)", () => {
  test("extracts provider/videoId/thumbnail from the first playable videoNews block", () => {
    const info = extractPlayableVideoInfo([
      { _type: "block", _key: "b1" },
      { _type: "videoNews", _key: "v1", provider: "youtube", videoId: "dQw4w9WgXcQ" }
    ]);
    expect(info).toEqual({
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
    });
  });

  test("returns null when the document has no playable videoNews block", () => {
    expect(extractPlayableVideoInfo([{ _type: "videoNews", _key: "v1" }])).toBeNull();
    expect(extractPlayableVideoInfo([{ _type: "block", _key: "b1" }])).toBeNull();
    expect(extractPlayableVideoInfo(null)).toBeNull();
  });

  test("collects only mediaType: image items' mediaObjectId, across every gallery block", () => {
    const ids = collectGalleryMediaObjectIds([
      { _type: "gallery", _key: "g1", items: [{ mediaType: "image", mediaObjectId: "a" }, { mediaType: "video", mediaObjectId: "b" }] },
      { _type: "block", _key: "b1" },
      { _type: "gallery", _key: "g2", items: [{ mediaType: "image", mediaObjectId: "c" }] }
    ]);
    expect(ids).toEqual(["a", "c"]);
  });

  test("returns [] for a non-array document or one with no gallery block", () => {
    expect(collectGalleryMediaObjectIds(null)).toEqual([]);
    expect(collectGalleryMediaObjectIds([{ _type: "block", _key: "b1" }])).toEqual([]);
  });
});
