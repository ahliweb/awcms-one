/**
 * Resolves this deployment's icon inputs (site name + theme primary) and
 * renders one of the named PNGs. Shared by the two endpoints that publish
 * them (`src/pages/icons/[name].png.ts`, `src/pages/apple-touch-icon.png.ts`).
 */
import { getSiteIdentity } from "./awcms/profil";
import { getSiteTheme } from "./awcms/theme";
import { contrastingForeground } from "./warna";
import { iconInitial, renderIconPng } from "./pwa-ikon";

export const ICON_FILES = {
  "icon-192": { size: 192, fullBleed: false },
  "icon-512": { size: 512, fullBleed: false },
  "icon-maskable-512": { size: 512, fullBleed: true },
  "apple-touch-icon": { size: 180, fullBleed: true }
} as const;

export type IconName = keyof typeof ICON_FILES;

export async function renderSiteIcon(name: IconName): Promise<Response> {
  const identity = await getSiteIdentity();
  const theme = await getSiteTheme();
  const { size, fullBleed } = ICON_FILES[name];
  const png = renderIconPng({
    size,
    fullBleed,
    background: theme.primary,
    foreground: contrastingForeground(theme.primary),
    initial: iconInitial(identity.name)
  });
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  return new Response(body, { headers: { "Content-Type": "image/png" } });
}
