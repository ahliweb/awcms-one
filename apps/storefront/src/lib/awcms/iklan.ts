/**
 * Ad-slot convenience for issue #28 — maps the issue's own vocabulary
 * ("header, in-article after paragraph N, sidebar, footer") onto the real,
 * verified `AD_PLACEMENT_KEYS` (`src/lib/awcms/blog.ts`), and renders
 * nothing where a placement the issue names does not actually exist.
 *
 * ## There is no "footer" slot
 *
 * The verified twelve keys (`ad-placement-policy.ts`) are `header_banner`,
 * `below_headline`, `homepage_middle`, `homepage_bottom`, `article_top`,
 * `article_middle`, `article_bottom`, `sidebar_top`, `sidebar_middle`,
 * `sidebar_bottom`, `category_archive_top`, `search_result_top` — none of
 * them is a footer placement. This app therefore renders header/in-article/
 * sidebar slots only; there is no footer ad anywhere in this build, and no
 * slot is invented to fill the gap.
 */
import { getActiveAdPlacements, type AdPlacementKey, type PublicAdPlacement } from "./blog";

/** The placement keys this app's pages actually render, in the issue's own vocabulary. */
export const AD_SLOTS = {
  header: "header_banner",
  belowHeadline: "below_headline",
  articleTop: "article_top",
  articleMiddle: "article_middle",
  articleBottom: "article_bottom",
  sidebar: "sidebar_top",
  categoryArchiveTop: "category_archive_top",
  searchResultTop: "search_result_top"
} as const satisfies Record<string, AdPlacementKey>;

/** One slot's creatives, or an empty array when the CMS has nothing booked — "render nothing when no placement" (issue text) is simply this array being empty; every caller already handles that. */
export async function getAdSlot(key: AdPlacementKey): Promise<PublicAdPlacement[]> {
  const slots = await getActiveAdPlacements();
  return slots[key] ?? [];
}
