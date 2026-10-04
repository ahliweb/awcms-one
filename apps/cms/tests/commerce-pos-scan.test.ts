/**
 * Issue #292 (ADR-0032) - `domain/pos-scan.ts`: scan-field parsing and the
 * keyboard-wedge burst detector, driven with explicit timestamps so the timing
 * rules are deterministic.
 */
import { describe, expect, test } from "bun:test";
import {
  parseScanInput,
  SCAN_MAX_GAP_MS,
  SCAN_MAX_QUANTITY,
  ScanBurstDetector,
  type ScanOutcome
} from "../src/modules/commerce/domain/pos-scan";

function type(
  detector: ScanBurstDetector,
  text: string,
  start: number,
  gap: number,
  options: { editable?: boolean; enter?: boolean } = {}
): ScanOutcome {
  let at = start;
  let outcome: ScanOutcome = { kind: "none" };
  for (const key of text) {
    outcome = detector.feed({
      key,
      timeStamp: at,
      editable: options.editable ?? false
    });
    at += gap;
  }
  if (options.enter !== false) {
    outcome = detector.feed({
      key: "Enter",
      timeStamp: at,
      editable: options.editable ?? false
    });
  }
  return outcome;
}

describe("parseScanInput", () => {
  test("a bare code is quantity 1", () => {
    expect(parseScanInput("4006381333931")).toEqual({
      code: "4006381333931",
      quantity: 1
    });
    expect(parseScanInput("  SKU-1  ")).toEqual({ code: "SKU-1", quantity: 1 });
  });

  test("N*CODE is a quantity multiplier", () => {
    expect(parseScanInput("3*ABC123")).toEqual({ code: "ABC123", quantity: 3 });
    expect(parseScanInput("999*X")).toEqual({ code: "X", quantity: 999 });
  });

  test("rejects an empty value, a zero or oversized quantity, and spaces", () => {
    expect(parseScanInput("")).toBeNull();
    expect(parseScanInput("   ")).toBeNull();
    expect(parseScanInput("0*ABC")).toBeNull();
    // Four digits is not a multiplier prefix at all: it is just a (legal) code.
    expect(parseScanInput(`${SCAN_MAX_QUANTITY + 1}*ABC`)).toEqual({
      code: "1000*ABC",
      quantity: 1
    });
    expect(parseScanInput("3*")).toBeNull();
    expect(parseScanInput("AB CD")).toBeNull();
    expect(parseScanInput("A".repeat(49))).toBeNull();
  });

  test("a leading asterisk or a trailing multiplier is part of the code", () => {
    expect(parseScanInput("*ABC")).toEqual({ code: "*ABC", quantity: 1 });
    expect(parseScanInput("ABC*3")).toEqual({ code: "ABC*3", quantity: 1 });
  });
});

describe("ScanBurstDetector", () => {
  test("a fast burst ending in Enter is a scan", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "4006381333931", 1000, 8)).toEqual({
      kind: "scan",
      code: "4006381333931"
    });
    expect(detector.pending()).toBe("");
  });

  test("the maximum allowed gap still counts; one millisecond over does not", () => {
    const ok = new ScanBurstDetector();
    expect(type(ok, "ABCD", 0, SCAN_MAX_GAP_MS)).toEqual({
      kind: "scan",
      code: "ABCD"
    });
    const slow = new ScanBurstDetector();
    expect(type(slow, "ABCD", 0, SCAN_MAX_GAP_MS + 1)).toEqual({
      kind: "none"
    });
  });

  test("human typing speed is never a scan", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "4006381333931", 0, 120)).toEqual({ kind: "none" });
  });

  test("a pause in the middle discards what came before it", () => {
    const detector = new ScanBurstDetector();
    detector.feed({ key: "A", timeStamp: 0, editable: false });
    detector.feed({ key: "B", timeStamp: 5, editable: false });
    // 500 ms pause, then a fresh fast burst: only the burst counts.
    const outcome = type(detector, "WXYZ", 505, 5);
    expect(outcome).toEqual({ kind: "scan", code: "WXYZ" });
  });

  test("a burst shorter than the minimum length is not a scan", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "AB", 0, 5)).toEqual({ kind: "none" });
  });

  test("never fires for keys typed inside a text field", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "4006381333931", 0, 5, { editable: true })).toEqual({
      kind: "none"
    });
    expect(detector.pending()).toBe("");
  });

  test("a text-field key in the middle of a burst resets it", () => {
    const detector = new ScanBurstDetector();
    detector.feed({ key: "A", timeStamp: 0, editable: false });
    detector.feed({ key: "B", timeStamp: 5, editable: false });
    detector.feed({ key: "C", timeStamp: 10, editable: true });
    expect(detector.pending()).toBe("");
    expect(
      detector.feed({ key: "Enter", timeStamp: 15, editable: false })
    ).toEqual({ kind: "none" });
  });

  test("modifier chords, Tab, Space and arrows break the burst", () => {
    for (const interrupt of [
      { key: "s", ctrlKey: true },
      { key: "s", altKey: true },
      { key: "s", metaKey: true },
      { key: "Tab" },
      { key: " " },
      { key: "ArrowDown" },
      { key: "Escape" }
    ]) {
      const detector = new ScanBurstDetector();
      detector.feed({ key: "A", timeStamp: 0, editable: false });
      detector.feed({ key: "B", timeStamp: 5, editable: false });
      detector.feed({ ...interrupt, timeStamp: 10, editable: false });
      expect(detector.pending()).toBe("");
      detector.feed({ key: "C", timeStamp: 15, editable: false });
      expect(
        detector.feed({ key: "Enter", timeStamp: 20, editable: false })
      ).toEqual({ kind: "none" });
    }
  });

  test("a lone Enter is never a scan (a cashier pressing Enter on a button)", () => {
    const detector = new ScanBurstDetector();
    expect(
      detector.feed({ key: "Enter", timeStamp: 100, editable: false })
    ).toEqual({ kind: "none" });
  });

  test("two scans back to back are two scans", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "AAAA1", 0, 5)).toEqual({
      kind: "scan",
      code: "AAAA1"
    });
    expect(type(detector, "BBBB2", 200, 5)).toEqual({
      kind: "scan",
      code: "BBBB2"
    });
  });

  test("an over-long burst is dropped rather than buffered without bound", () => {
    const detector = new ScanBurstDetector();
    expect(type(detector, "A".repeat(100), 0, 1)).toEqual({ kind: "none" });
    expect(detector.pending().length).toBeLessThanOrEqual(48);
  });
});
