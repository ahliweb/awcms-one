/**
 * Scanner input for the POS screen (Issue #292, ADR-0032): the parse of what a
 * keyboard-wedge (USB HID) scanner types, and the burst detector that tells a
 * scan from a person typing. Pure - no DOM, no timers, no I/O - the screen's
 * script feeds it key events with their own `timeStamp`, which is also what
 * makes it deterministic under test.
 *
 * ## How a wedge scanner looks to the page
 *
 * It is a keyboard: it types the code's characters a few milliseconds apart
 * and finishes with Enter (a "suffix"; some are configured with Tab, which this
 * detector deliberately does not honour - Tab is how a keyboard-only cashier
 * MOVES focus). A person cannot type at that speed, so the discriminator is the
 * inter-key gap of the WHOLE burst, not just its last key.
 *
 * ## Where detection may fire
 *
 * The detector never decides this itself - the caller passes `editable: true`
 * for any key typed inside a text field other than the dedicated scan field,
 * and the detector then drops its buffer and ignores the key. So a scan can
 * never be mistaken for typing into the customer name or a payment amount, and
 * the customer's own typing can never be mistaken for a scan.
 */

/** Smallest scan this detector will accept: shorter bursts are indistinguishable from fast typing. */
export const SCAN_MIN_LENGTH = 4;
/** Longest gap between two keys of one burst. Wedge scanners type at ~1-20 ms; humans at 80 ms or more. */
export const SCAN_MAX_GAP_MS = 35;
/** Largest quantity multiplier (`12*CODE`). */
export const SCAN_MAX_QUANTITY = 999;

export type ScanRequest = { code: string; quantity: number };

const MULTIPLIER_PATTERN = /^(\d{1,3})\*(\S+)$/;
const CODE_PATTERN = /^[\x21-\x7E]{1,48}$/;

/**
 * Parses a scan-field value: `CODE`, or `<n>*CODE` for a quantity multiplier.
 * `null` for an empty / malformed value or a multiplier outside 1-999 - the
 * caller shows its inline "not a valid code" message. A stored barcode can
 * never start with `<n>*` (`domain/barcode.ts`), so the split is unambiguous.
 */
export function parseScanInput(raw: string): ScanRequest | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  // A multiplier with no code after it ("3*") is a typo, not a code.
  if (/^\d{1,3}\*$/.test(value)) return null;
  const multiplied = MULTIPLIER_PATTERN.exec(value);
  if (multiplied) {
    const quantity = Number.parseInt(multiplied[1]!, 10);
    const code = multiplied[2]!;
    if (quantity < 1 || quantity > SCAN_MAX_QUANTITY) return null;
    if (!CODE_PATTERN.test(code)) return null;
    return { code, quantity };
  }
  if (!CODE_PATTERN.test(value)) return null;
  return { code: value, quantity: 1 };
}

export type ScanKeyEvent = {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.timeStamp` (ms). */
  timeStamp: number;
  /** True when the key went to a text field OTHER than the dedicated scan field. */
  editable: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export type ScanOutcome =
  | { kind: "none" }
  /** A complete burst ended in Enter: act on `code`, and swallow the Enter (`preventDefault`) so it cannot also click a focused button. */
  | { kind: "scan"; code: string };

export type ScanDetectorOptions = {
  minLength?: number;
  maxGapMs?: number;
};

/**
 * Accumulates the characters of a fast burst. Anything that breaks the burst -
 * a gap over `maxGapMs`, a modifier chord, a non-printable key, a key typed in
 * a text field - clears the buffer, so state never leaks from one interaction
 * into the next.
 */
export class ScanBurstDetector {
  private buffer = "";
  private lastTime = Number.NEGATIVE_INFINITY;
  private readonly minLength: number;
  private readonly maxGapMs: number;

  constructor(options: ScanDetectorOptions = {}) {
    this.minLength = options.minLength ?? SCAN_MIN_LENGTH;
    this.maxGapMs = options.maxGapMs ?? SCAN_MAX_GAP_MS;
  }

  reset(): void {
    this.buffer = "";
    this.lastTime = Number.NEGATIVE_INFINITY;
  }

  /** Characters buffered so far (exposed for tests). */
  pending(): string {
    return this.buffer;
  }

  feed(event: ScanKeyEvent): ScanOutcome {
    if (event.editable || event.ctrlKey || event.altKey || event.metaKey) {
      this.reset();
      return { kind: "none" };
    }
    const gap = event.timeStamp - this.lastTime;
    if (this.buffer.length > 0 && gap > this.maxGapMs) {
      // A pause: whatever was buffered was somebody typing, not a scan.
      this.reset();
    }
    if (event.key === "Enter") {
      const code = this.buffer;
      const fast = gap <= this.maxGapMs;
      this.reset();
      if (code.length >= this.minLength && fast && CODE_PATTERN.test(code)) {
        return { kind: "scan", code };
      }
      return { kind: "none" };
    }
    if (event.key.length === 1 && event.key !== " ") {
      this.buffer += event.key;
      this.lastTime = event.timeStamp;
      if (this.buffer.length > 48) this.reset();
      return { kind: "none" };
    }
    // Tab, arrows, Escape, Space, function keys...: not part of a scan.
    this.reset();
    return { kind: "none" };
  }
}
