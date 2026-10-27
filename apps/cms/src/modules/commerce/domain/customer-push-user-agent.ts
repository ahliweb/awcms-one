/**
 * A COARSE description of a customer's browser for the device list (Issue #430,
 * ADR-0048 section 2.3): "Chrome on Android (mobile)". Pure.
 *
 * The raw `User-Agent` is never stored on a device row: it is high-entropy
 * (a fingerprinting input) and attacker-controlled, and a customer who looks at
 * their device list only needs to recognise "this is my phone". The result is
 * built from three closed vocabularies, so it cannot carry any part of the
 * header and is always far below the 120-character column limit.
 */

type Rule = readonly [RegExp, string];

// Order matters: Edge, Opera and Samsung Internet all contain "Chrome/", and
// Chrome contains "Safari/".
const BROWSERS: readonly Rule[] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"]
];

const SYSTEMS: readonly Rule[] = [
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "macOS"],
  [/\bLinux\b|\bX11\b/, "Linux"]
];

function firstMatch(rules: readonly Rule[], source: string): string {
  for (const [pattern, label] of rules) {
    if (pattern.test(source)) return label;
  }
  return "Other";
}

function deviceClass(source: string): "mobile" | "tablet" | "desktop" {
  if (/\biPad\b|\bTablet\b/.test(source)) return "tablet";
  if (/\bMobile\b|\biPhone\b|\biPod\b/.test(source)) return "mobile";
  if (/\bAndroid\b/.test(source)) return "tablet";
  return "desktop";
}

/** `null` when the header is absent or blank. */
export function classifyUserAgent(
  userAgent: string | null | undefined
): string | null {
  const source = userAgent?.trim().slice(0, 512);
  if (!source) return null;

  return `${firstMatch(BROWSERS, source)} on ${firstMatch(SYSTEMS, source)} (${deviceClass(source)})`;
}
