# Session 2400 — A deleted page's tree in Trash, on the real backend

#5737's real-lane items, part of the #5726 happy-path sweep. This adds
`e2e-tauri/trash-page-cascade.e2e.ts`: one vault, three cases.

- **Delete from the Pages list.** Trash lists the page once, with a
  `+3 blocks` badge (`trash.itemsInBatch`, not the issue's "3 blocks").
  Restore brings back the three-level outline after a view round-trip.
- **Purge.** After a round-trip, the page is gone from Trash.
- **The editor kebab's "Delete page".** The issue called it "Send to Trash".
  The tab steps off the page, the page leaves Pages, and Restore brings its
  tree back.

**Shown red on the real binary:**
- `restore_block_inner`, with the restore cohort filtered to the root alone.
- `purge_block_inner`, with its descendant select emptied.
- `PageHeader.handleRequestDelete`, with `onBack` removed.

**Traps.**
- TrashView's `handlePurge` drops the row from its cached list before
  `reload()` answers, so the wait right after confirming can pass on the
  cache. Only the post-round-trip absence reads the backend.
- A deleted page is absent from Pages whether or not it was purged, so that
  assertion was dropped from the purge case.

**Not built.**
- **Compaction.** "Compact removes eligible ops" can't happen in this lane.
  Retention is fixed at 90 days, the UI has no control for it, the IPC
  refuses less than 7, and every op in a fresh vault is seconds old. The
  options are in a comment on #5737, waiting for the maintainer.
- **Two-tab delete.** A page deleted while it is open in a second tab stays
  open there. That bug gets its own fix PR, so this spec covers the
  single-tab path.

**Refactor.** `openNewPage` takes an optional title, and `confirmDialog` moved
into `helpers.ts`. Both were verbatim copies in this spec and in
`history-redo-revert-restore.e2e.ts`.

**Lane on this box.** The cloud container can run the real lane locally:
`apt-get install webkit2gtk-driver openbox` and `cargo binstall
tauri-driver`, then the `e2e-tauri/AGENTS.md` commands. A debug build takes
about 15 minutes cold. A tauri-driver orphaned by an interrupted run holds
:4444, so the next run fails in two seconds with "can not listen to
address"; kill that PID.

**Ran:**
- the new spec, `history-redo-revert-restore`, `block-clipboard` and
  `page-alias-undo` on the real binary;
- `npm run typecheck:e2e-tauri`, `npx vitest run e2e-tauri` and oxlint.
