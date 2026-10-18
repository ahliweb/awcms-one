/**
 * The install-help flag and standalone detection (issue #428).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { detectInstallState, isInstallHelpEnabled } from "../src/lib/pasang-aplikasi";
import { applyInstallState } from "../src/scripts/pasang-aplikasi";

describe("isInstallHelpEnabled", () => {
  const ORIGINAL = process.env.PUBLIC_INSTALL_HELP;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PUBLIC_INSTALL_HELP;
    else process.env.PUBLIC_INSTALL_HELP = ORIGINAL;
  });

  test("off by default", () => {
    delete process.env.PUBLIC_INSTALL_HELP;
    expect(isInstallHelpEnabled()).toBe(false);
  });
  test("only an explicit truthy value turns it on", () => {
    for (const on of ["1", "true", "TRUE", "on", "yes"]) {
      process.env.PUBLIC_INSTALL_HELP = on;
      expect(isInstallHelpEnabled()).toBe(true);
    }
    for (const off of ["", "0", "false", "off", "no", "maybe"]) {
      process.env.PUBLIC_INSTALL_HELP = off;
      expect(isInstallHelpEnabled()).toBe(false);
    }
  });
});

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";

describe("detectInstallState", () => {
  const base = { maxTouchPoints: 0, displayModeStandalone: false, navigatorStandalone: undefined };

  test("a Safari tab on iPhone is iOS and not standalone", () => {
    expect(detectInstallState({ ...base, userAgent: IPHONE, navigatorStandalone: false })).toEqual({ standalone: false, ios: true });
  });
  test("navigator.standalone or display-mode: standalone means launched from the Home Screen", () => {
    expect(detectInstallState({ ...base, userAgent: IPHONE, navigatorStandalone: true }).standalone).toBe(true);
    expect(detectInstallState({ ...base, userAgent: ANDROID, displayModeStandalone: true }).standalone).toBe(true);
  });
  test("iPadOS (Mac user agent with touch) is iOS; a desktop Mac and Android are not", () => {
    expect(detectInstallState({ ...base, userAgent: MAC, maxTouchPoints: 5 }).ios).toBe(true);
    expect(detectInstallState({ ...base, userAgent: MAC }).ios).toBe(false);
    expect(detectInstallState({ ...base, userAgent: ANDROID }).ios).toBe(false);
  });
});

describe("applyInstallState", () => {
  function fakeRoot() {
    const els = {
      "[data-when=standalone]": { hidden: true },
      "[data-when=browser]": { hidden: false },
      "[data-when=not-ios]": { hidden: false }
    };
    const root = {
      querySelectorAll: (sel: keyof typeof els) => ({ forEach: (fn: (el: { hidden: boolean }) => void) => fn(els[sel]) })
    } as unknown as ParentNode;
    return { els, root };
  }

  test("standalone hides the install steps and shows the confirmation", () => {
    const { els, root } = fakeRoot();
    applyInstallState(root, { standalone: true, ios: true });
    expect(els["[data-when=standalone]"].hidden).toBe(false);
    expect(els["[data-when=browser]"].hidden).toBe(true);
  });
  test("a non-iOS browser tab shows the Chrome hint; iOS hides it", () => {
    const a = fakeRoot();
    applyInstallState(a.root, { standalone: false, ios: false });
    expect(a.els["[data-when=not-ios]"].hidden).toBe(false);
    const b = fakeRoot();
    applyInstallState(b.root, { standalone: false, ios: true });
    expect(b.els["[data-when=not-ios]"].hidden).toBe(true);
  });
});
