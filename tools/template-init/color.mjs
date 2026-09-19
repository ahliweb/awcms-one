/**
 * color.mjs — the two colour defaults `docs/template.md`'s CLI reference
 * promises when `--warna-sekunder`/`--warna-aksen` are omitted: "a darker
 * shade of `--warna-primer`" and "a contrasting accent". No dependency: a
 * small, self-contained hex<->HSL round trip is all either needs.
 */

/**
 * @param {string} hex - `#rrggbb`
 * @returns {{ h: number, s: number, l: number }}
 */
function hexToHsl(hex) {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r:
      h = (g - b) / d + (g < b ? 6 : 0);
      break;
    case g:
      h = (b - r) / d + 2;
      break;
    default:
      h = (r - g) / d + 4;
  }
  return { h: h * 60, s, l };
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {string} `#rrggbb`
 */
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  const toByte = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toByte(r1)}${toByte(g1)}${toByte(b1)}`;
}

/**
 * A darker shade of `hex`, for `DEFAULT_THEME_COLORS.secondary` when
 * `--warna-sekunder` is not given. Lightness reduced by a fixed 18 points
 * (floored at 8%), hue/saturation untouched — a shade, not a different hue.
 *
 * @param {string} hex
 * @returns {string}
 */
export function darken(hex) {
  const { h, s, l } = hexToHsl(hex);
  const next = Math.max(0.08, l - 0.18);
  return hslToHex(h, s, next);
}

/**
 * A fixed, neutral warm amber, for `DEFAULT_THEME_COLORS.accent` when
 * `--warna-aksen` is not given. Not derived from `--warna-primer`: an
 * accent is meant to stand OUT against the primary, and a hue rotation
 * computed with no human eye to check it risks landing on a clash this tool
 * cannot see — a fixed, already-tested-elsewhere-in-this-repo amber
 * (BjekMart's own accent) is a safer unattended default than a formula.
 *
 * @returns {string}
 */
export function defaultAccent() {
  return "#f59e0b";
}
