/**
 * The build-time PNG icon generator (issue #428, `src/lib/pwa-ikon.ts`):
 * valid, deterministic PNGs of the requested size, brand-derived, with the
 * transparency rules iOS and the manifest `maskable` purpose need.
 */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { encodePng, iconInitial, renderIconPixels, renderIconPng } from "../src/lib/pwa-ikon";

const SPEC = { background: "#10b981", foreground: "#000000", initial: "B" } as const;

function readPng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const signature = [...png.subarray(0, 8)];
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return { signature, width, height, bitDepth: png[24], colorType: png[25] };
}

describe("iconInitial", () => {
  test("first ASCII letter or digit, upper-cased, diacritics folded", () => {
    expect(iconInitial("Borneojek Mart")).toBe("B");
    expect(iconInitial("  toko saya")).toBe("T");
    expect(iconInitial("Éclair")).toBe("E");
    expect(iconInitial("7 Hari")).toBe("7");
  });
  test("null when there is nothing drawable", () => {
    expect(iconInitial("")).toBeNull();
    expect(iconInitial("東京")).toBeNull();
  });
});

describe("renderIconPng", () => {
  for (const size of [180, 192, 512]) {
    test(`${size}px is a valid RGBA PNG whose pixel data inflates to the right length`, () => {
      const png = renderIconPng({ ...SPEC, size, fullBleed: false });
      const info = readPng(png);
      expect(info.signature).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect([info.width, info.height]).toEqual([size, size]);
      expect([info.bitDepth, info.colorType]).toEqual([8, 6]);
      // Locate IDAT and inflate it.
      const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
      let at = 8;
      let idat: Uint8Array | null = null;
      while (at < png.length) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
        if (type === "IDAT") idat = png.subarray(at + 8, at + 8 + length);
        at += 12 + length;
      }
      expect(idat).not.toBeNull();
      expect(inflateSync(idat!).length).toBe((size * 4 + 1) * size);
    });
  }

  test("deterministic: same input, byte-identical output", () => {
    const a = renderIconPng({ ...SPEC, size: 192, fullBleed: false });
    const b = renderIconPng({ ...SPEC, size: 192, fullBleed: false });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test("derives from the brand: a different colour or letter changes the file", () => {
    const base = renderIconPng({ ...SPEC, size: 192, fullBleed: false });
    const color = renderIconPng({ ...SPEC, background: "#2563eb", size: 192, fullBleed: false });
    const letter = renderIconPng({ ...SPEC, initial: "K", size: 192, fullBleed: false });
    expect(Buffer.from(base).equals(Buffer.from(color))).toBe(false);
    expect(Buffer.from(base).equals(Buffer.from(letter))).toBe(false);
  });

  test("any-purpose icon has transparent corners; full-bleed icon is opaque everywhere", () => {
    const size = 192;
    const rounded = renderIconPixels({ ...SPEC, size, fullBleed: false });
    const bleed = renderIconPixels({ ...SPEC, size, fullBleed: true });
    const alphaAt = (px: Uint8Array, x: number, y: number) => px[(y * size + x) * 4 + 3];
    expect(alphaAt(rounded, 0, 0)).toBe(0);
    expect(alphaAt(rounded, size / 2, size / 2)).toBe(255);
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]] as const) {
      expect(alphaAt(bleed, x, y)).toBe(255);
    }
  });

  test("the glyph is drawn in the foreground colour at the centre of the icon", () => {
    const size = 192;
    const px = renderIconPixels({ ...SPEC, size, fullBleed: true });
    const centre = ((size / 2) * size + size / 2) * 4;
    // "B" has ink in the middle row, so the centre pixel is foreground, not background.
    expect([px[centre], px[centre + 1], px[centre + 2]]).toEqual([0, 0, 0]);
    const corner = [px[0], px[1], px[2]];
    expect(corner).toEqual([0x10, 0xb9, 0x81]);
  });

  test("encodePng rejects nothing silently: output starts with the PNG signature for any size", () => {
    expect(encodePng(1, new Uint8Array(4))[1]).toBe(0x50);
  });
});
