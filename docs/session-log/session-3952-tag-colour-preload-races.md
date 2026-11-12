# Session 3952 — a stale tag-colour preload no longer overwrites newer state

Follow-up to #6633 (review notes), `Refs #6544`.

`refreshTagColors` in `src/stores/resolve.ts` awaits one property read and then replaces the whole
`tagColors` map. Two things could happen during that read:

- The user switches space. The old space's colours then replaced the new space's. The write is now
  skipped when the space the read started for is no longer active, the check `refreshDeleted` uses.
- A colour is set or cleared. The read came back with the value from before and put it back.
  `setSyncedTagColor` now bumps a counter and a preload whose counter moved skips its write.

A skipped preload drops its whole result, so other tags' newer colours wait for the next preload,
as they already do after a failed read. A per-key merge was not used: it is more code and gets the
case wrong where the user sets a colour back to its earlier value while a peer's change is in the
read.

`COMPARISON.md`, "What export drops": the export still drops tag colours, but because a tag is
written only as its `#name` reference, not because the colour is device-local.

Tests: three in `resolve.test.ts`, each shown red before the fix and again by removing the guard it
covers. Checks run: `npx vitest run src/stores src/hooks`, typecheck, lint, the pre-commit and
manual hooks.
