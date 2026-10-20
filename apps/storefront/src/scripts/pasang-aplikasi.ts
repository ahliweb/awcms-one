/**
 * Progressive enhancement for `/pasang-aplikasi` (issue #428): with no JS
 * every section is visible, which is correct for everyone. With JS the page
 * hides what does not apply — the install steps once the app is already
 * running from the Home Screen, the iPhone steps on a non-Apple device.
 * Never requests a permission and never talks to the network.
 */
import { detectInstallState } from "../lib/pasang-aplikasi";

export function applyInstallState(root: ParentNode, state: ReturnType<typeof detectInstallState>): void {
  const show = (selector: string, visible: boolean) => {
    root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
      el.hidden = !visible;
    });
  };
  show("[data-when=standalone]", state.standalone);
  show("[data-when=browser]", !state.standalone);
  show("[data-when=not-ios]", !state.ios && !state.standalone);
}

if (typeof document !== "undefined") {
  const state = detectInstallState({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    displayModeStandalone: window.matchMedia?.("(display-mode: standalone)").matches ?? false,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone
  });
  applyInstallState(document, state);
}
