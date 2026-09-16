import { describe, expect, test } from "bun:test";
import { renderPortableText, documentHasPlayableVideo } from "../src/lib/portable-text";

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
 */
describe("lib/portable-text: videoNews (issue #28)", () => {
  test("a well-formed youtube videoNews block renders a real watch link, never an iframe", () => {
    const html = renderPortableText([
      {
        _type: "videoNews",
        _key: "v1",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        title: "Kebakaran Pasar Kobar",
        sourceLabel: "Warga sekitar",
        durationSeconds: 95,
        caption: "Api cepat menjalar."
      }
    ]);

    expect(html).toContain('href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"');
    expect(html).toContain("Kebakaran Pasar Kobar");
    expect(html).toContain("Warga sekitar");
    expect(html).toContain("1:35"); // 95s -> 1:35
    expect(html).toContain("Api cepat menjalar.");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
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
