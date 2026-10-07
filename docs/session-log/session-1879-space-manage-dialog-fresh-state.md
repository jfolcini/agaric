# Session 1879 — Manage spaces reads fresh state on every open (#5284)

This is the second `/batch-issues` batch of the session that logged 1877. Merged
logs are not edited, so it gets its own file.

## Board

- #5303 (#5301) merged once `validate-all` and `dco` passed and the reviewer had
  approved with no notes.
- The PR board was then empty.
- Another session holds #5276, #5279, #5281, #5282, #5285 and #5302.
- #5284 was unclaimed.

## #5284

**The bug.** Both callers, `SpaceSwitcher` and `JournalPage`, keep
`SpaceManageDialog` mounted with `open={false}` for the whole session. The
dialog cached each space's emptiness probe and journal template per `space.id`
for its lifetime, and its own comment called a reopen "a cache hit". Two
symptoms followed:

- Delete stayed disabled after a space was emptied, and enabled after one gained
  a page.
- The template editor showed the template from app start, and a blur
  overwrote a newer one.

**The fix.**

- **Per-open lifetime.** The state and the probe effect moved into
  `SpaceManageDialogBody`, rendered inside the dialog's `Content`. Radix mounts
  `Content` only while the dialog is open, so each open probes afresh.
  - This is the issue's "render it only while open" direction, kept inside the
    dialog. Both callers stay as they are, and the close animation still runs.
- **The lost probe.** Results are now dropped only on unmount. Before, a
  per-run flag dropped any result that landed after `availableSpaces` changed,
  while the id stayed marked as fetched. That row then never got a value.
- **The old test.** "does not re-fetch on close + reopen" pinned the bug, so it
  is replaced.

## Verified

- `SpaceManageDialog.test.tsx`: 31 tests pass. Two new tests:
  - **Reopen re-reads both values.** Emptiness and the template both change
    while the dialog is closed, and the reopened rows show the new values.
  - **Late probe kept.** A probe resolving after the space list changed still
    enables Delete.
- Two mutations were run against a copy, then restored:
  - Restoring the original component turns both new tests red.
  - Keeping the split but dropping results on a list change turns only the
    second test red.
- Every test file that renders the dialog passes: 9 files, 258 tests, including
  `SpaceSwitcher` and `JournalPage`.
- `npm run typecheck` passes.
- Playwright `spaces-management`, `link-chip-lifecycle` and `tags-lifecycle`
  pass: 18 tests, run on a fresh `build:e2e`.
