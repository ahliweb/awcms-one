/**
 * Exceptions for `bun run deps:audit:check` — advisories knowingly accepted.
 *
 * **Empty is the target state.** (In the awcms-one embed it holds one dated
 * entry — `http-cache-semantics`, no fixed release published — see below.) The reasoning is the
 * one ADR-0058 settled for the permission-enforcement gate: an empty list makes
 * the NEXT exception the only entry, so it cannot be added without being seen.
 * A list with five reasonable-looking entries is where the sixth hides.
 *
 * Every entry MUST carry a real reason, an owner, and a `reviewDate`. An
 * exception without a date is permanent by accident, and `deps:audit:check`
 * fails on entries that no longer match any advisory so the list cannot quietly
 * become a museum of vulnerabilities that were fixed upstream years ago.
 *
 * Before adding one, try `overrides` in `package.json` first. All three
 * advisories open on 2026-08-08 were closed that way and none needed an
 * exception:
 *
 * - `nanoid` → `^3.3.17` (`postcss` asks for `^3.3.16`, so the fix was already
 *   in range and only the lockfile was behind).
 * - `js-yaml` → `^4.3.1` (`astro`/`@astrojs/internal-helpers`/`@changesets/parse`
 *   all ask for `^4.3.0`).
 * - `read-yaml-file` → `^2.1.0`, which is what made the `js-yaml` bump SAFE.
 *   `read-yaml-file@1.1.0` (pinned transitively by `@changesets/cli@2.31.1`,
 *   itself already the latest release) calls `yaml.safeLoad`, removed in
 *   js-yaml 4 — so overriding `js-yaml` alone broke the release tooling with
 *   `Function yaml.safeLoad is removed in js-yaml 4`, proven by calling it.
 *   `2.1.0` is the newest version that is still CommonJS (`3.0.0` is
 *   `"type": "module"` and `@manypkg/get-packages` reaches it through
 *   `require()`), and it depends on `js-yaml@^4.1.1`.
 *
 * Scoping an override to one dependency PATH is not available here: Bun 1.3.14
 * silently ignores both npm's nested `overrides` object and yarn's
 * `"parent/child"` `resolutions` key — neither produced a nested entry in
 * `bun.lock`. So a transitive consumer that cannot take the fixed version must
 * be overridden itself, as `read-yaml-file` was.
 */
export type AuditException = {
  /** Package the advisory is filed against, exactly as `bun audit` names it. */
  packageName: string;
  /** GHSA URL — the identity used for matching, since titles get reworded. */
  advisoryUrl: string;
  /** Why this is accepted. Not "low risk" — what makes it not exploitable HERE. */
  reason: string;
  /** Who accepted it. */
  owner: string;
  /** ISO date. Re-justify by then or remove. */
  reviewDate: string;
};

export const EXCEPTIONS: readonly AuditException[] = [
  // awcms-one local divergence (2026-10-03, root AGENTS.md "Known local
  // divergences"): no release of `http-cache-semantics` fixes this advisory
  // (`<=4.2.0` vulnerable, `4.2.0` is the latest published version), so no
  // `overrides` entry can close it. Drop this entry the day a fixed version is
  // published, or when upstream `ahliweb/awcms` lands its own resolution.
  {
    packageName: "http-cache-semantics",
    advisoryUrl: "https://github.com/advisories/GHSA-ch52-4w7c-c8xp",
    reason:
      "Only consumer is astro's build-time remote-image cache (astro/dist/assets/build/remote.js, " +
      "verified by grep over astro@7.3.5's dist/); it runs once per `astro build` for one operator, " +
      "never behind a shared multi-user HTTP cache at request time, which is the precondition for a " +
      "cross-user max-stale disclosure. No published version fixes it, so no override can.",
    owner: "awcms-one maintainers (ahliweb)",
    reviewDate: "2026-11-03"
  }
];
