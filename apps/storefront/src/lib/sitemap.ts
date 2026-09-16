/**
 * The sitemap registry (issue #24) — the seam that lets `sitemap-index.xml`/
 * `sitemap-[n].xml` (`src/pages/`) enumerate every URL this build knows
 * about without knowing where each one comes from.
 *
 * `registerSitemapSource(name, source)` is called once per URL-producing
 * concern, at module load, by `src/lib/sitemap-sources.ts` (the ONE file
 * that imports every source module for its side effect — see that file's
 * own docblock for why registration is centralized there rather than
 * scattered across page modules). #27 (products) and #28 (news) add their
 * own `registerSitemapSource(...)` call to that same file; neither issue
 * needs to touch `sitemap.ts`, `sitemap-index.xml.ts`, or
 * `sitemap-[n].xml.ts` again.
 */

export type SitemapEntry = {
  loc: string;
  lastmod?: string;
  changefreq?:
    | "always"
    | "hourly"
    | "daily"
    | "weekly"
    | "monthly"
    | "yearly"
    | "never";
  priority?: number;
};

export type SitemapSource = () => Promise<SitemapEntry[]>;

/** The maximum URLs the sitemap protocol allows in one file — see https://www.sitemaps.org/protocol.html#index. `sitemap-[n].xml.ts` splits at this bound. */
export const SITEMAP_MAX_URLS_PER_FILE = 5000;

const sources = new Map<string, SitemapSource>();

/**
 * Registers one named source of sitemap URLs. Registering the same `name`
 * twice is a programming error (a page whose source module got imported
 * twice under two different specifiers, say) rather than a legitimate
 * "replace the old one" — it throws immediately rather than silently
 * dropping half of one source's URLs.
 */
export function registerSitemapSource(name: string, source: SitemapSource): void {
  if (sources.has(name)) {
    throw new Error(
      `registerSitemapSource: "${name}" is already registered. Two sitemap ` +
        `sources sharing one name is almost always an accidental double ` +
        `import, not an intentional replacement — give the second one its ` +
        `own name, or remove the duplicate import.`
    );
  }
  sources.set(name, source);
}

/** Test/build seam: drops every registered source, so a test file can register its own fixtures without inheriting whatever `sitemap-sources.ts` registered. */
export function resetSitemapSourcesForTests(): void {
  sources.clear();
}

/**
 * Runs every registered source and concatenates the results, in
 * registration order (deterministic — a `Map` preserves insertion order).
 * Sources run sequentially, not via `Promise.all`: every source calls into
 * `src/lib/awcms/*`'s own memoized, once-per-build fetches, so there is no
 * concurrency benefit to buy, and sequential keeps one source's build-log
 * warning readable instead of interleaved with another's.
 */
export async function collectSitemapEntries(): Promise<SitemapEntry[]> {
  const entries: SitemapEntry[] = [];
  for (const source of sources.values()) {
    entries.push(...(await source()));
  }
  return entries;
}

let entriesCache: Promise<SitemapEntry[]> | undefined;

/**
 * The memoized, whole-build entry list — `sitemap-index.xml.ts` (to compute
 * the file count) and `sitemap-[n].xml.ts`'s `getStaticPaths()` (to slice
 * out each file's chunk) both need the SAME list, and Astro may evaluate
 * both independently, so this is cached rather than re-run per page.
 */
export function getAllSitemapEntries(): Promise<SitemapEntry[]> {
  entriesCache ??= collectSitemapEntries();
  return entriesCache;
}

/** Test seam: drops the whole-build memoized entry list (independent of `resetSitemapSourcesForTests` — a test may want to keep the real sources registered and only force a re-run). */
export function resetSitemapEntriesCacheForTests(): void {
  entriesCache = undefined;
}

/** Splits `entries` into chunks of at most `SITEMAP_MAX_URLS_PER_FILE`, always returning at least one (possibly empty) chunk so `/sitemap-1.xml` is always a valid, stable URL. */
export function chunkSitemapEntries(
  entries: SitemapEntry[]
): SitemapEntry[][] {
  if (entries.length === 0) return [[]];

  const chunks: SitemapEntry[][] = [];
  for (let i = 0; i < entries.length; i += SITEMAP_MAX_URLS_PER_FILE) {
    chunks.push(entries.slice(i, i + SITEMAP_MAX_URLS_PER_FILE));
  }
  return chunks;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Renders one chunk of entries as a `<urlset>` document — `sitemap-[n].xml.ts`'s whole body. */
export function renderUrlsetXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((entry) => {
      const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : "";
      const changefreq = entry.changefreq
        ? `<changefreq>${escapeXml(entry.changefreq)}</changefreq>`
        : "";
      const priority =
        entry.priority !== undefined ? `<priority>${entry.priority.toFixed(1)}</priority>` : "";
      return `  <url><loc>${escapeXml(entry.loc)}</loc>${lastmod}${changefreq}${priority}</url>`;
    })
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  );
}

/** Renders the sitemap index — `sitemap-index.xml.ts`'s whole body. */
export function renderSitemapIndexXml(sitemapUrls: string[]): string {
  const items = sitemapUrls
    .map((url) => `  <sitemap><loc>${escapeXml(url)}</loc></sitemap>`)
    .join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</sitemapindex>\n`
  );
}
