/**
 * `/apple-touch-icon.png` — the iOS Home Screen icon (issue #428), 180x180
 * and full-bleed (iOS paints transparent pixels black and rounds the corners
 * itself). At the site root because iOS also probes that default path.
 */
import type { APIRoute } from "astro";
import { renderSiteIcon } from "../lib/pwa-ikon-situs";

export const prerender = true;

export const GET: APIRoute = () => renderSiteIcon("apple-touch-icon");
