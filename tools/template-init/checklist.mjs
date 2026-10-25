/**
 * checklist.mjs — the post-init product governance checklist `template:init`
 * prints when it finishes (issue #476), and the single source the
 * "Post-init checklist" tables in `docs/template.md` / `docs/template.id.md`
 * restate.
 *
 * It exists because `template:init` rewrites a SHORT, CLOSED list of files
 * (`docs/template.md`'s "What it rewrites") and nothing else, so a derived
 * repository is left with surfaces that still carry the template's identity
 * until its owners edit them. The first derived product, OMES-Web, found that
 * out one file at a time: its root `AGENTS.md`, `README.md`, `docs/template.md`
 * and `compose.production.yaml` still named awcms-one, and its
 * `repository.url` still read `GANTI-ORG` (ahliweb/omes-web#19). Each entry
 * below says which of three things is true of one governance area:
 *
 *   - `automatic` — `template:init` rewrites all of it and a test pins that;
 *   - `partial`   — `template:init` rewrites part of it; `manual` says the rest;
 *   - `manual`    — `template:init` does not touch it; a person must review it.
 *
 * `tests/template-init.test.mjs` checks the claims: every path named here
 * exists, every `automaticPaths` entry is in the real rewrite plan, and no
 * path that is only ever listed under `manualPaths` is. The checklist
 * therefore cannot claim a rewrite the tool does not perform. Keep entries to
 * what the tool and the tree do today.
 */

/**
 * @typedef {object} ChecklistItem
 * @property {string} id - stable key
 * @property {string} area - the governance area, as issue #476 names it
 * @property {"automatic" | "partial" | "manual"} handling
 * @property {string[]} automaticPaths - paths `template:init` rewrites (empty when `manual`); each must be in the plan
 * @property {string[]} manualPaths - paths `template:init` does NOT touch that still need review (empty when `automatic`)
 * @property {string} automatic - what the tool does (empty when `manual`)
 * @property {string} manual - what a person must still do (empty when `automatic`)
 */

/** @type {ChecklistItem[]} */
export const POST_INIT_CHECKLIST = [
  {
    id: "repository-url",
    area: "Repository URL",
    handling: "partial",
    automaticPaths: ["package.json"],
    manualPaths: ["README.md", "SUPPORT.md", "SECURITY.md"],
    automatic: "package.json repository.url becomes git+https://github.com/GANTI-ORG/<slug>.git, a loud placeholder.",
    manual:
      "Replace GANTI-ORG with the real owner/repo. Issue, advisory and ADR links in README/SUPPORT/SECURITY still point at ahliweb/awcms-one and are left alone."
  },
  {
    id: "identity-docs",
    area: "README, AGENTS, CONTRIBUTING and the other root documents",
    handling: "partial",
    automaticPaths: ["README.md", "SUPPORT.md"],
    manualPaths: [
      "AGENTS.md",
      "CONTRIBUTING.md",
      "GOVERNANCE.md",
      "SECURITY.md",
      "CODE_OF_CONDUCT.md",
      "docs/template.md"
    ],
    automatic:
      "Only the README hero paragraph and the SUPPORT hero sentence (and their .id mirrors) are rewritten; the README title and its 'This repo' table still read awcms-one.",
    manual:
      "Rewrite the README title and body and AGENTS.md for the product, and review CONTRIBUTING, GOVERNANCE, SECURITY, CODE_OF_CONDUCT and docs/template.md (plus the .id mirrors), which still describe awcms-one and BjekMart. Keep historical attribution, then run docs:i18n:stamp."
  },
  {
    id: "deploy-naming",
    area: "Deploy image and Compose naming",
    handling: "partial",
    automaticPaths: ["compose.yaml"],
    manualPaths: ["compose.production.yaml"],
    automatic: "compose.yaml (the local database): project name, container name and named volume.",
    manual:
      "compose.production.yaml is not rewritten: its project, container, volume and image names and the AWCMS_ONE_* variables may name resources that already persist. Do not search-and-replace them; inventory them and change them only through a separate reviewed migration with a rollback."
  },
  {
    id: "ui-ux",
    area: "UI/UX inheritance versus local adaptation",
    handling: "partial",
    automaticPaths: ["apps/storefront/src/config/site.ts"],
    manualPaths: ["apps/storefront/src/layouts/BaseLayout.astro", "docs/ui-ux.md"],
    automatic:
      "DEFAULT_IDENTITY and DEFAULT_THEME_COLORS (the colours feed the theme tokens, the manifest and the generated PNG icons).",
    manual:
      "Fonts, layout, imagery and copy are inherited as they are. Adapt them locally and scope the change (for example to one SITE_PROFILE) so the other profiles keep inheriting the template; see docs/ui-ux.md."
  },
  {
    id: "runtime-release",
    area: "Runtime pin and release/version metadata",
    handling: "partial",
    automaticPaths: ["package.json", "CHANGELOG.md"],
    manualPaths: [".changesets/README.md"],
    automatic:
      "package.json version becomes 0.1.0 and awcmsOne.templateVersion records the template version; CHANGELOG.md is reset to one 0.1.0 entry and .changesets/*.md are cleared (once only).",
    manual:
      "The Bun pin (packageManager, engines.bun) is inherited as shipped; move it deliberately. The product's own changesets age from the day they are written (audit:rilis allows 20 files and 14 days), so plan the first release; see .changesets/README.md and docs/rilis.md."
  },
  {
    id: "status-branding",
    area: "Status and branding links",
    handling: "partial",
    automaticPaths: ["apps/storefront/.env.example"],
    manualPaths: ["docs/status.md", "SECURITY.md"],
    automatic: "apps/storefront/.env.example: SITE_URL, SITE_NAME, SITE_DESCRIPTION and SITE_PROFILE.",
    manual:
      "docs/status.md states awcms-one's own current state, not the product's; rewrite it to the product's real state. Check the public contact, advisory and support links in SECURITY and SUPPORT."
  },
  {
    id: "upstream-drift",
    area: "Upstream version drift",
    handling: "partial",
    automaticPaths: ["package.json"],
    manualPaths: ["AGENTS.md"],
    automatic: "package.json awcmsOne.templateVersion records which template version the repository started from.",
    manual:
      "A repository made from the template has no apps/cms history. Record the ancestry once (a no-change merge of the awcms commit apps/cms matches), keep the awcms remote main-only with --no-tags, merge each subtree sync with a merge commit (never squash or rebase), and set the repository to merge-commit-only before the first sync. See docs/template.md."
  }
];

/**
 * @param {ChecklistItem[]} [items]
 * @returns {string} the checklist as the plain text `template:init` prints
 */
export function describeChecklist(items = POST_INIT_CHECKLIST) {
  const lines = [
    "Post-init checklist — template:init rewrote only the files listed under 'Rewrite:' above.",
    "Everything marked 'manual' below still carries the template's identity until you review it.",
    ""
  ];
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.area} [${item.handling}]`);
    if (item.automatic) lines.push(`   automatic: ${item.automatic}`);
    if (item.manual) lines.push(`   manual:    ${item.manual}`);
  });
  lines.push("", "Details: docs/template.md, 'Post-init checklist'.");
  return lines.join("\n");
}
