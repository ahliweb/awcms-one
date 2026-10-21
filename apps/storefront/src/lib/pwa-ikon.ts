/**
 * Neutral, build-time PNG app icons for the web app manifest and the iOS
 * Home Screen (issue #428).
 *
 * ## Why generated, not committed
 *
 * A committed `icon-192.png` would be one more brand file `template:init`
 * would have to find and rewrite (it cannot rasterise an SVG), and a
 * forgotten one would ship BjekMart's mark on a derived site's Home Screen.
 * Instead the icon is DERIVED at build time from the two things a
 * deployment already owns: the site name (its first letter) and the theme
 * primary colour (`getSiteTheme()`, which `template:init` rewrites through
 * `DEFAULT_THEME_COLORS`). No new rewrite target, no raster dependency
 * (this app has none and must not gain a build-time one for this) and no
 * asset a derived repository can forget.
 *
 * The encoder is pure (`node:zlib` + a CRC table), deterministic and
 * unit-tested, so the same inputs always produce byte-identical files.
 */
import { deflateSync } from "node:zlib";

/** 5x7 glyphs for `A-Z0-9`; each row is 5 bits, `1` = ink. */
const GLYPHS: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"]
};

/** The icon's letter: the first ASCII letter/digit of `name` (diacritics folded), upper-cased; `null` when there is none (the icon then carries no glyph). */
export function iconInitial(name: string): string | null {
  const folded = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  const match = folded.match(/[A-Z0-9]/);
  return match ? match[0] : null;
}

export type IconSpec = {
  /** Edge length in px (the icon is square). */
  size: number;
  /** `#rrggbb` fill. */
  background: string;
  /** `#rrggbb` glyph colour (use `contrastingForeground(background)`). */
  foreground: string;
  /** The letter to draw, from `iconInitial`; `null` draws none. */
  initial: string | null;
  /**
   * `true` fills the whole square (no transparent corners) and keeps the
   * glyph inside the maskable safe zone. Used for the `maskable` manifest
   * icon and the iOS touch icon (iOS paints transparent pixels black and
   * applies its own rounded mask).
   */
  fullBleed: boolean;
};

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16)
  ];
}

const SUBSAMPLES = 4;

/** Raw RGBA pixels for `spec`, anti-aliased by 4x4 supersampling. */
export function renderIconPixels(spec: IconSpec): Uint8Array {
  const { size, fullBleed } = spec;
  const [br, bg, bb] = hexToRgb(spec.background);
  const [fr, fg, fb] = hexToRgb(spec.foreground);
  const glyph = spec.initial ? GLYPHS[spec.initial] : undefined;

  // Glyph geometry: 7 cells tall. Maskable icons must keep content inside
  // the central 80% circle, so their glyph is smaller.
  const glyphHeight = size * (fullBleed ? 0.4 : 0.5);
  const cell = glyphHeight / 7;
  const glyphLeft = (size - cell * 5) / 2;
  const glyphTop = (size - glyphHeight) / 2;
  const radius = size * 0.22;

  const insideShape = (x: number, y: number): boolean => {
    if (fullBleed) return true;
    const cx = x < radius ? radius : x > size - radius ? size - radius : x;
    const cy = y < radius ? radius : y > size - radius ? size - radius : y;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const insideGlyph = (x: number, y: number): boolean => {
    if (!glyph) return false;
    const col = Math.floor((x - glyphLeft) / cell);
    const row = Math.floor((y - glyphTop) / cell);
    if (col < 0 || col > 4 || row < 0 || row > 6) return false;
    return glyph[row]![col] === "1";
  };

  const pixels = new Uint8Array(size * size * 4);
  const total = SUBSAMPLES * SUBSAMPLES;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgCount = 0;
      let fgCount = 0;
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const x = px + (sx + 0.5) / SUBSAMPLES;
          const y = py + (sy + 0.5) / SUBSAMPLES;
          if (!insideShape(x, y)) continue;
          if (insideGlyph(x, y)) fgCount++;
          else bgCount++;
        }
      }
      const covered = bgCount + fgCount;
      const offset = (py * size + px) * 4;
      if (covered === 0) continue; // fully transparent
      pixels[offset] = Math.round((bgCount * br + fgCount * fr) / covered);
      pixels[offset + 1] = Math.round((bgCount * bg + fgCount * fg) / covered);
      pixels[offset + 2] = Math.round((bgCount * bb + fgCount * fb) / covered);
      pixels[offset + 3] = Math.round((covered / total) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes straight-alpha RGBA pixels as a PNG file. */
export function encodePng(size: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = new Uint8Array((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0))
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

export function renderIconPng(spec: IconSpec): Uint8Array {
  return encodePng(spec.size, renderIconPixels(spec));
}
