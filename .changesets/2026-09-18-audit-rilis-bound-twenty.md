---
bump: patch
type: structure
impact: internal
---

# `audit:rilis` count bound raised from 10 to 20 waiting changesets

The gate's own docblock called 10 files a "starting assumption pending real
release history". There is history now: v0.3.0 folded ten changesets from
one increment, and increment 3 (epic #46) produces one changeset per atomic
PR — fourteen children plus follow-ups — before its own release, so the
bound of 10 turned `check` red on every PR in the second half of the
increment while asking the contributor for nothing. Twenty is the measured
size of one increment's release plus headroom; the 14-day age bound, which
is the one that actually catches an unwatched backlog, is unchanged.

- Only felt while developing: `bun run audit:rilis` no longer reddens a
  branch merely because an increment is more than half merged.
