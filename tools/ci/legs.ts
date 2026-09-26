/**
 * legs.ts — the single source of truth for local CI's leg table and the
 * exact `local-ci/*` status contexts it reports.
 *
 * ADR-0021 (issue #225 part 1) replaces `.github/workflows/{ci,
 * template-init-smoke,e2e,codeql}.yml` with this local/server runner and
 * exact-SHA commit statuses, Option A: a flat 1:1 mapping between what used
 * to be a required GitHub Actions status check and a `local-ci/*` context.
 * A later change (branch-protection migration, and eventually this repo's
 * own docs) reads this exported table rather than re-typing the twelve
 * names — see `tests/versi-toolchain.test.mjs`'s planned use of
 * {@link BUN_PIN_CHECK} and this module together, and AGENTS.md's own future
 * update once branch protection is swapped over (ADR-0021's "Migration
 * sequence").
 */

export type LegGroup = "check" | "template" | "e2e" | "security";

export interface LegDefinition {
  /** The exact `local-ci/*` status context this leg reports. */
  context: string;
  /** Which runner module (`tools/ci/runners/*.ts`) executes this leg. */
  group: LegGroup;
  /** The build profile this leg runs under, when the group has one. */
  profile?: "toko" | "berita" | "landing";
  /** True for the leg in a group that also runs the group's shared/root-only steps (the `toko` check leg's audits, the template group's `root-suite`). */
  primary?: boolean;
  /** One line, what a reader sees in `bun run ci`'s own leg list. */
  description: string;
}

/**
 * The twelve legs, in the exact order `.github/workflows/*.yml` defined
 * them across `ci.yml`, `template-init-smoke.yml`, `e2e.yml`, and
 * `codeql.yml`. Order matters only for the default run's own progress
 * output — every leg is independent and `--leg` may select any subset.
 */
export const LEGS: readonly LegDefinition[] = [
  {
    context: "local-ci/check-toko",
    group: "check",
    profile: "toko",
    primary: true,
    description:
      "apps/storefront type-check + profile smoke (toko) — plus root bun test, audit:dokumen, audit:translation, audit:graf, audit:rilis, bun audit"
  },
  {
    context: "local-ci/check-berita",
    group: "check",
    profile: "berita",
    description: "apps/storefront type-check + profile smoke (berita)"
  },
  {
    context: "local-ci/check-landing",
    group: "check",
    profile: "landing",
    description: "apps/storefront type-check + profile smoke (landing)"
  },
  {
    context: "local-ci/check-cms",
    group: "check",
    description: "apps/cms's own ~53-step check chain, then tests/integration/ against an ephemeral postgres:18.4"
  },
  {
    context: "local-ci/template-toko",
    group: "template",
    profile: "toko",
    description: "bun run template:init --profil toko against a disposable checkout, then a real build against the stub CMS"
  },
  {
    context: "local-ci/template-berita",
    group: "template",
    profile: "berita",
    description: "bun run template:init --profil berita against a disposable checkout, then a real build against the stub CMS"
  },
  {
    context: "local-ci/template-landing",
    group: "template",
    profile: "landing",
    description: "bun run template:init --profil landing against a disposable checkout, then a real build against the stub CMS"
  },
  {
    context: "local-ci/template-root",
    group: "template",
    primary: true,
    description: "bun run template:init --profil toko, then the full root bun test (root-suite)"
  },
  {
    context: "local-ci/e2e-toko",
    group: "e2e",
    profile: "toko",
    description: "apps/storefront Playwright e2e (SITE_PROFILE=toko)"
  },
  {
    context: "local-ci/e2e-berita",
    group: "e2e",
    profile: "berita",
    description: "apps/storefront Playwright e2e (SITE_PROFILE=berita)"
  },
  {
    context: "local-ci/e2e-landing",
    group: "e2e",
    profile: "landing",
    description: "apps/storefront Playwright e2e (SITE_PROFILE=landing)"
  },
  {
    context: "local-ci/security",
    group: "security",
    description: "CodeQL CLI (javascript-typescript, security-extended) + gitleaks (pinned by digest) + bun audit"
  }
];

/** Every `local-ci/*` context, in leg-table order — the flat list a branch-protection change or a doc reads. */
export const LEG_CONTEXTS: readonly string[] = LEGS.map((leg) => leg.context);

/** Look a leg up by its exact context name, e.g. from `--leg <name>`. */
export function findLeg(context: string): LegDefinition | undefined {
  return LEGS.find((leg) => leg.context === context);
}

/** Every leg belonging to a given group, in table order. */
export function legsInGroup(group: LegGroup): readonly LegDefinition[] {
  return LEGS.filter((leg) => leg.group === group);
}
