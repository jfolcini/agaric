# Session 1886 — the space list follows sync (#5283)

This is the fourth `/batch-issues` batch of the session that logged 1877,
1879, 1880 and 1883.

## Board

- #5307 (#5280) merged once `validate-all` and `dco` passed on its renumbered
  head and the reviewer had approved.
- Its first run had failed `session-log-pr-collision`: #5306 had merged a
  `session-1882` log while #5307 was open. The branch merged `main` and
  renumbered its log to 1883, with no force push.
- The `validate-all` failure on the superseded head was cancelled jobs, not a
  test.
- Another session holds #5276, #5279, #5281, #5282, #5285 and #5288.
- #5283 was unclaimed.

## #5283

**The bug.** Spaces do sync, but `availableSpaces` was fetched only at boot,
on `SpaceSwitcher` mount, and after a local edit in Manage spaces. On desktop
the switcher mounts once. So a peer's new, renamed, recoloured or deleted space
never reached any of these until a restart:

- the switcher;
- the Ctrl+1..9 hotkeys;
- the accent stripe;
- the window title;
- the "Move to space" targets.

A deleted active space also stayed active, and creates then failed in
`require_live_space_in_tx`.

**The fix.**

- **Refresh on every sync.** `reloadChangedPageStores`, the shared path for
  `sync:complete` and `blocks:changed`, now calls `refreshAvailableSpaces()`.
  - It never rejects, and its error toast is deduped.
  - It already moves off an active space a peer deleted and says so.
- **Stable identity.** `refreshAvailableSpaces` now keeps the existing array
  when the rows are unchanged (same id, name and accent, in order).
  - Without that, every sync tick (about every 3 s while a peer types) would
    hand subscribers a new array.
  - `AppSidebar` and `ExportSection` would re-render or re-run on each tick.
- **No-op syncs.** A converged no-op sync still skips the reload path, so it
  does not refresh either.

## Verified

- `useSyncEvents.test.ts` and `space.test.ts` pass: 88 tests. The new tests
  cover:
  - the refresh on `sync:complete` and on `blocks:changed`;
  - identity kept for equal rows;
  - the list replaced on a rename, a new accent, or a different space.
- Three mutations were run against a copy, then restored:
  - Removing the call turns both sync tests red.
  - Never keeping identity turns the identity test red.
  - Ignoring the name turns the rename case red.
- `vitest related` over both changed modules passes: 297 files, 8613 tests, 51 skipped.
- `npm run typecheck` passes.
