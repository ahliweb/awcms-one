import { describe, expect, test } from "bun:test";
import { renderPortableText, escapeHtml } from "../src/lib/portable-text";

describe("lib/portable-text", () => {
  test("escapeHtml neutralises every HTML-meaningful character", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"
    );
  });

  test("renders a normal paragraph", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        children: [{ _type: "span", _key: "s1", text: "Halo dunia", marks: [] }],
        markDefs: []
      }
    ]);
    expect(html).toBe("<p>Halo dunia</p>");
  });

  test("clamps h1 to h2 and h5/h6 to h4 — the page's own <h1> owns the outline", () => {
    const heading = (style: string) =>
      renderPortableText([
        {
          _type: "block",
          _key: "b1",
          style,
          children: [{ _type: "span", _key: "s1", text: "Judul", marks: [] }],
          markDefs: []
        }
      ]);

    expect(heading("h1")).toBe("<h2>Judul</h2>");
    expect(heading("h3")).toBe("<h3>Judul</h3>");
    expect(heading("h5")).toBe("<h4>Judul</h4>");
    expect(heading("h6")).toBe("<h4>Judul</h4>");
  });

  test("renders blockquote as <blockquote><p>...</p></blockquote>", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "blockquote",
        children: [{ _type: "span", _key: "s1", text: "Kutipan", marks: [] }],
        markDefs: []
      }
    ]);
    expect(html).toBe("<blockquote><p>Kutipan</p></blockquote>");
  });

  test("decorators apply in a fixed order (code, em, strong) regardless of marks array order", () => {
    const render = (marks: string[]) =>
      renderPortableText([
        {
          _type: "block",
          _key: "b1",
          style: "normal",
          children: [{ _type: "span", _key: "s1", text: "x", marks }],
          markDefs: []
        }
      ]);

    expect(render(["strong", "em", "code"])).toBe(render(["code", "em", "strong"]));
    expect(render(["strong", "em", "code"])).toBe("<p><strong><em><code>x</code></em></strong></p>");
  });

  test("a link annotation with an allowed scheme renders as <a>, with noopener/noreferrer", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        children: [{ _type: "span", _key: "s1", text: "tautan", marks: ["link1"] }],
        markDefs: [{ _type: "link", _key: "link1", href: "https://example.test/" }]
      }
    ]);
    expect(html).toBe(
      '<p><a href="https://example.test/" rel="noopener noreferrer">tautan</a></p>'
    );
  });

  test("a javascript: href is refused — the span still renders, unlinked", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        children: [{ _type: "span", _key: "s1", text: "berbahaya", marks: ["link1"] }],
        markDefs: [{ _type: "link", _key: "link1", href: "javascript:alert(1)" }]
      }
    ]);
    expect(html).toBe("<p>berbahaya</p>");
    expect(html).not.toContain("<a");
  });

  test("a relative href is allowed", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        children: [{ _type: "span", _key: "s1", text: "internal", marks: ["link1"] }],
        markDefs: [{ _type: "link", _key: "link1", href: "/halaman/kontak" }]
      }
    ]);
    expect(html).toContain('href="/halaman/kontak"');
  });

  test("renders a flat bullet list as one <ul> with one <li> per item", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        listItem: "bullet",
        level: 1,
        children: [{ _type: "span", _key: "s1", text: "satu", marks: [] }],
        markDefs: []
      },
      {
        _type: "block",
        _key: "b2",
        style: "normal",
        listItem: "bullet",
        level: 1,
        children: [{ _type: "span", _key: "s2", text: "dua", marks: [] }],
        markDefs: []
      }
    ]);
    expect(html).toBe("<ul><li>satu</li><li>dua</li></ul>");
  });

  test("renders a numbered list as <ol>", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        listItem: "number",
        level: 1,
        children: [{ _type: "span", _key: "s1", text: "satu", marks: [] }],
        markDefs: []
      }
    ]);
    expect(html).toBe("<ol><li>satu</li></ol>");
  });

  test("a nested list item is appended inside its parent <li>, not as a sibling list", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        listItem: "bullet",
        level: 1,
        children: [{ _type: "span", _key: "s1", text: "induk", marks: [] }],
        markDefs: []
      },
      {
        _type: "block",
        _key: "b2",
        style: "normal",
        listItem: "bullet",
        level: 2,
        children: [{ _type: "span", _key: "s2", text: "anak", marks: [] }],
        markDefs: []
      }
    ]);
    expect(html).toBe("<ul><li>induk<ul><li>anak</li></ul></li></ul>");
  });

  test("a gallery block degrades to a stated, visible placeholder — never an <img>", () => {
    const html = renderPortableText([
      { _type: "gallery", _key: "g1", items: [{ mediaObjectId: "x" }, { mediaObjectId: "y" }] }
    ]);
    expect(html).toContain("Galeri (2 gambar)");
    expect(html).not.toContain("<img");
  });

  test("a videoNews block degrades to a stated placeholder", () => {
    const html = renderPortableText([{ _type: "videoNews", _key: "v1" }]);
    expect(html).toContain("Video");
    expect(html).toContain("content-placeholder");
  });

  test("an unrecognised _type degrades to a visible placeholder rather than vanishing", () => {
    const html = renderPortableText([{ _type: "somethingFromTheFuture", _key: "u1" }]);
    expect(html).toContain("somethingFromTheFuture");
    expect(html).toContain("content-placeholder");
  });

  test("a non-array document renders as empty rather than throwing", () => {
    expect(renderPortableText(null)).toBe("");
    expect(renderPortableText(undefined)).toBe("");
    expect(renderPortableText({})).toBe("");
  });

  test("a CMS-authored string cannot break out of the surrounding tag (XSS regression)", () => {
    const html = renderPortableText([
      {
        _type: "block",
        _key: "b1",
        style: "normal",
        children: [
          { _type: "span", _key: "s1", text: '</p><script>window.__pwned=1</script>', marks: [] }
        ],
        markDefs: []
      }
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
