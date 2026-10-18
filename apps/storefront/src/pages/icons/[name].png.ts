/**
 * `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon-maskable-512.png`
 * — the manifest's PNG icons (issue #428), rendered at build time from the
 * site name and theme colour (`src/lib/pwa-ikon.ts` explains why generated).
 */
import type { APIRoute, GetStaticPaths } from "astro";
import { renderSiteIcon, type IconName } from "../../lib/pwa-ikon-situs";

export const prerender = true;

export const getStaticPaths: GetStaticPaths = () =>
  (["icon-192", "icon-512", "icon-maskable-512"] as const).map((name) => ({ params: { name } }));

export const GET: APIRoute = ({ params }) => renderSiteIcon(params.name as IconName);
