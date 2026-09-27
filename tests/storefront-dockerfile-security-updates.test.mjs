import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `apps/storefront/Dockerfile`'s `runtime` stage is `FROM oven/bun:${BUN_VERSION}-slim`
 * — a Debian base whose package set is only as current as the day that tag
 * was cut. A trivy scan of `oven/bun:1.4.2-slim` (27 Sep 2026) found three
 * CRITICAL CVEs in `perl-base` (CVE-2026-13221, CVE-2026-42496,
 * CVE-2026-8376), all fixed by Debian security in 5.40.1-6+deb13u1. The fix
 * is a build-time `apt-get upgrade` in the `runtime` stage, applied before
 * `USER bun` (root is required to run `apt-get`) — see that stage's own
 * comment. This test asserts the shape stays in place, not the exact CVE
 * numbers, since those will not be the last ones this pattern closes.
 */

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DOCKERFILE_PATH = join(REPO_ROOT, "apps", "storefront", "Dockerfile");
const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

describe("apps/storefront/Dockerfile's runtime stage applies Debian security updates", () => {
  const runtimeStageMatch = dockerfile.match(/FROM oven\/bun:\$\{BUN_VERSION\}-slim AS runtime[\s\S]*$/);

  test("the runtime stage exists", () => {
    expect(runtimeStageMatch).not.toBeNull();
  });

  const runtimeStage = runtimeStageMatch ? runtimeStageMatch[0] : "";
  const userBunIndex = runtimeStage.indexOf("USER bun");

  // Anchor on the actual `RUN` instruction itself, not just the bare words
  // `apt-get update`/`apt-get upgrade` — this stage's own preceding comment
  // (explaining WHY the RUN exists) uses those same words in prose, and a
  // plain `indexOf` would happily match the comment instead of the command.
  const runLineMatch = runtimeStage.match(/RUN apt-get update[\s\S]*?rm -rf \/var\/lib\/apt\/lists\/\*/);

  test("has a RUN instruction applying apt-get update/upgrade and cleaning up apt lists", () => {
    expect(runLineMatch).not.toBeNull();
  });

  const runLine = runLineMatch ? runLineMatch[0] : "";
  const runLineIndex = runLineMatch ? runtimeStage.indexOf(runLineMatch[0]) : -1;
  const aptUpdateIndex = runLine.indexOf("apt-get update");
  const aptUpgradeIndex = runLine.indexOf("apt-get upgrade");
  const aptListsCleanupIndex = runLine.indexOf("rm -rf /var/lib/apt/lists");

  test("runs `apt-get update` before `apt-get upgrade`, before `USER bun`", () => {
    expect(aptUpdateIndex).toBeGreaterThan(-1);
    expect(aptUpgradeIndex).toBeGreaterThan(-1);
    expect(aptUpdateIndex).toBeLessThan(aptUpgradeIndex);
    expect(userBunIndex).toBeGreaterThan(-1);
    expect(runLineIndex).toBeLessThan(userBunIndex);
  });

  test("removes /var/lib/apt/lists after upgrading, before `USER bun`", () => {
    expect(aptListsCleanupIndex).toBeGreaterThan(-1);
    expect(aptListsCleanupIndex).toBeGreaterThan(aptUpgradeIndex);
    expect(runLineIndex).toBeLessThan(userBunIndex);
  });

  test("still runs as the non-root `bun` user by the end of the stage", () => {
    expect(userBunIndex).toBeGreaterThan(-1);
  });
});
