/**
 * derived-product.ts — the ONE file a repository derived from this template
 * edits to turn off local-CI leg groups (issue #531).
 *
 * `tools/ci/legs.ts` keeps the inherited table as `TEMPLATE_LEGS` and
 * exports `LEGS` as that table minus every group named here. A disabled
 * group's legs are absent from `LEGS` and `LEG_CONTEXTS`, so `bun run ci`
 * neither runs nor posts them, and `--leg <context>` (and the `ci:*`
 * shortcut scripts) stop with "Unknown leg context" instead of running.
 *
 * The template ships the empty list: every leg runs. A derived product edits
 * only this file, so a template sync never conflicts on the leg table.
 * Keep its branch protection's required contexts equal to the contexts that
 * remain; `tests/local-ci-legs.test.mjs` pins the template's set.
 *
 * Valid groups: "check" | "template" | "e2e" | "security". An unknown name
 * makes `legs.ts` throw on import (a typo must not silently disable nothing).
 * Example for a product that is already initialised:
 *
 *   export const DISABLED_LEG_GROUPS: readonly LegGroup[] = ["template"];
 */
import type { LegGroup } from "./legs.ts";

export const DISABLED_LEG_GROUPS: readonly LegGroup[] = [];
