🇬🇧 English (source) · 🇮🇩 [Bahasa Indonesia](README.id.md)

# awcms-one root skills

Practical how-tos for this repository's own, root-owned work — not `apps/cms`'s own skills (`apps/cms/.claude/skills/`, `ahliweb/awcms`'s own convention, carried by the subtree embed and out of scope for this index).

| Skill | Use when |
| --- | --- |
| [`awcms-one-storefront`](awcms-one-storefront/SKILL.md) | Adding or changing a page/route in `apps/storefront` — the static/runtime split, the stub-backed build, the derived CSP |
| [`awcms-one-commerce`](awcms-one-commerce/SKILL.md) | Adding a table, endpoint, or admin screen to `apps/cms`'s `commerce` module — one module not three, RLS, the two `Bun.SQL` quirks, the anonymous-vs-owner API split |

Both were written for issue #31 (the increment-2 documentation refresh) against the tree as merged after issues #22–#30 — see [`docs/arsitektur.md`](../../docs/arsitektur.md) and [`docs/adr/`](../../docs/adr/README.md) for the decisions each one assumes.
