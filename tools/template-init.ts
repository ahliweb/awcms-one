#!/usr/bin/env bun
/**
 * tools/template-init.ts — `bun run template:init` (issue #138).
 *
 * Rewrites this repository's brand surface (name, domain, colours, contact,
 * build profile) for a repository created from GitHub's own "Use this
 * template" button, per ADR-0018 D4/D5 and `docs/template.md`'s CLI
 * reference. All the real logic lives in `tools/template-init/` — this file
 * is only the thin entry point every other root-level script here follows.
 *
 * See `docs/template.md` for the full CLI reference, exit codes, and what
 * this does and does not rewrite.
 */
import { main } from "./template-init/run.mjs";

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
