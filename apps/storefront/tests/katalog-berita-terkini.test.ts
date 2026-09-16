import { describe, expect, test } from "bun:test";
import { getRecentPosts } from "../src/lib/berita-terkini";

/**
 * Exercises BOTH branches of the guarded loader — see `src/lib/
 * berita-terkini.ts`'s own docblock for why this is kept even though
 * `src/lib/berita.ts` (#28) is now genuinely present on this branch: the
 * loader is injectable specifically so this test does not depend on that.
 */
describe("berita-terkini: getRecentPosts", () => {
  test("module present: returns whatever getPosts({limit}) answers", async () => {
    const posts = [
      { slug: "a", title: "A", excerpt: "Ringkasan A", publishedAt: "2026-09-01T00:00:00.000Z", rubric: { slug: "ekonomi", name: "Ekonomi" } }
    ];

    const result = await getRecentPosts(3, async () => ({
      getPosts: async (opts) => {
        expect(opts).toEqual({ limit: 3 });
        return posts;
      }
    }));

    expect(result).toEqual(posts);
  });

  test("module absent/throws on import: degrades to an empty list, never throws", async () => {
    const result = await getRecentPosts(3, async () => {
      throw new Error("Cannot find module './berita'");
    });

    expect(result).toEqual([]);
  });

  test("getPosts itself throwing also degrades to an empty list", async () => {
    const result = await getRecentPosts(3, async () => ({
      getPosts: async () => {
        throw new Error("boom");
      }
    }));

    expect(result).toEqual([]);
  });
});
