/**
 * The home page's "recent news" section — the three latest posts, read
 * through issue #28's `src/lib/berita.ts`.
 *
 * ## Why this is wrapped rather than imported directly
 *
 * This issue (#27) started from a `main` that did not yet have #28 merged,
 * and the two branches were built in parallel — the brief for this issue
 * asked for the section to sit behind a guarded dynamic `import()`, so a
 * build on this branch could never break regardless of merge order, with a
 * unit test for BOTH branches (module present, module absent/broken).
 * `src/lib/berita.ts` has since merged into `main` (PR #38) and this branch
 * picked it up — but the guard is kept anyway: it costs nothing once the
 * module is present (the `try` simply succeeds), and it is the same
 * resilience posture this codebase already applies elsewhere
 * (`src/lib/awcms/pemasaran.ts`'s 404-tolerant marketing fetches,
 * `src/lib/awcms/profil.ts`'s degrade-on-missing-endpoint): a home page
 * should not fail to build over one unrelated section.
 *
 * The loader is injected (defaulting to the real dynamic `import()`)
 * purely so `tests/katalog-build.test.ts` can exercise the "module
 * absent/throws" branch without needing the real file to actually be
 * missing on disk.
 */

/** The subset of #28's `PostSummary` this section actually renders — see `src/lib/berita.ts` for the full type. */
export type RecentPost = {
  slug: string;
  title: string;
  excerpt: string | null;
  publishedAt: string;
  rubric: { slug: string; name: string } | null;
};

type BeritaModule = {
  getPosts: (opts?: { limit?: number }) => Promise<RecentPost[]>;
};

type BeritaLoader = () => Promise<BeritaModule>;

const defaultLoader: BeritaLoader = () => import("./berita");

/**
 * The `limit` latest posts, or an empty array when `src/lib/berita.ts`
 * cannot be loaded or throws — logged once, never a failed build over a
 * section the home page can simply omit.
 */
export async function getRecentPosts(
  limit: number,
  loader: BeritaLoader = defaultLoader
): Promise<RecentPost[]> {
  try {
    const mod = await loader();
    return await mod.getPosts({ limit });
  } catch (error) {
    console.warn(
      `[katalog] home page "recent news" section skipped: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return [];
  }
}
