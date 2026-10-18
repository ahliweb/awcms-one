/**
 * The "Add to Home Screen" help page's build-time switch and detection
 * logic (issue #428). OFF by default, like GA (`src/lib/ga.ts`): unset
 * means NO page, NO link, NO script, NO sitemap entry and no `<head>`
 * change — a build without the flag is byte-identical to one made before
 * this feature existed (apart from the manifest/icon work, which is not
 * behind the flag).
 *
 * `PUBLIC_INSTALL_HELP` is `PUBLIC_`-prefixed for the same reason
 * `PUBLIC_GA_ID` is: it is a non-secret deployment choice, and being public
 * by construction is what makes the prefix correct. It is read at BUILD
 * time only (`integrations/profil.mjs` injects the route, the footers
 * render the link).
 *
 * The page itself requests NO permission and subscribes to NO push service
 * (issue #428 explicitly excludes it); it only explains the iPhone flow and
 * the limits of a browser tab.
 */
import { readEnv } from "./env";

/** Where the help page lives when the flag is on. Deliberately not in `ROUTES`: it must not enter the sitemap, nav or profile matrices. */
export const INSTALL_HELP_PATH = "/pasang-aplikasi";

export function isInstallHelpEnabled(): boolean {
  const raw = readEnv("PUBLIC_INSTALL_HELP");
  return raw !== undefined && ["1", "true", "on", "yes"].includes(raw.toLowerCase());
}

/** The browser facts detection needs, injectable for tests. */
export type InstallEnvironment = {
  userAgent: string;
  maxTouchPoints: number;
  /** `matchMedia("(display-mode: standalone)").matches` */
  displayModeStandalone: boolean;
  /** Safari's non-standard `navigator.standalone` */
  navigatorStandalone: boolean | undefined;
};

export type InstallState = {
  /** Already launched from the Home Screen. */
  standalone: boolean;
  /** An iPhone/iPad (including iPadOS reporting a Mac user agent). */
  ios: boolean;
};

export function detectInstallState(env: InstallEnvironment): InstallState {
  const iosUa = /iPhone|iPad|iPod/.test(env.userAgent);
  const ipadOs = /Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1;
  return {
    standalone: env.displayModeStandalone || env.navigatorStandalone === true,
    ios: iosUa || ipadOs
  };
}
