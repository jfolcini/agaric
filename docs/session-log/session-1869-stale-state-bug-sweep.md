# Session 1869 — stale-state bug sweep (#5236–#5260)

Worked every open `bug` issue: the 24 findings of the page / tag / link
stale-state audit (#5236–#5259) plus #5260, the follow-up notes from #5232.
The session was confined to one branch, so everything shipped in #5261 as one
commit per batch, each with its own `Closes` lines.

## What shipped

Frontend (16 issues):

- **Journal Today (#5260).** The Today shortcut and the palette's "Go to
  today" now follow the journal mode the way the button does, through one
  `goToToday` journal-store action. Dead classes removed from
  `headerContentClass`.
- **Rename and new-page invalidation (#5249, #5253, part of #5250).**
  `renamePage`, `notifyPageAdded` and alias writes bump the graph-structure
  counter. The Graph view, Unlinked References (and its alias list) and the
  parent's Pages section listen to it.
- **Tags view and page-header tags (#5257, #5254, #5244, plus slices of
  #5236, #5242, #5258 and #5250).**
  - The Tags view follows the active space and drops stale loads. Before,
    a delete could purge the other space's tag.
  - The filter panel listens on the name-change bus.
  - The header loads the whole catalogue via `list_all_tags_in_space` and
    reloads on the bus's `invalidated`.
- **Sync fan-out (#5256, #5258, #5242, #5255).** `reloadChangedPageStores`:
  - bumps the property counter (Unfinished and Agenda now read it);
  - invalidates the Pages-list query and the calendar page-date cache, which
    now notifies mounted consumers;
  - retitles held tabs and recents through `renamePage`.

  Search's tag resolver drops its "no such tag" entries on the bus.
- **Link chips (#5245, #5246, #5247, #5248, last slice of #5250).**
  - Cached block titles refresh on content change and in the post-sync
    rescan.
  - `markDeleted` and `refreshDeleted` keep chips in step with every
    delete and restore path.
  - Trash restores invalidate the calendar cache.
  - `announcePagesMovedOut` drops a moved page from the origin's picker and
    renders its chips as the broken "not in this space" link.
- **Found while testing:** Ctrl+A in the page title, or any text field, ran
  the block tree's select-all. The e2e test that should have caught it
  asserted `toContainText`.

Backend (9 issues):

- **Tags (#5236, #5237).**
  - Tag creation reuses the live same-name tag in the same space, through
    the import's `snapshot_tags_by_norm`.
  - Migration 0121 rebuilds `tags_cache` with `UNIQUE(space_id, name)`.
  - The rebuild and the oracle key by space.
  - Search's `tag:#` resolution reads the active space only.
- **Undo (#5238, #5240, #5252, #5259).**
  - Space-key reverses go through `apply_set_property_via_loro`.
  - `apply_reverse_in_tx` applies the reverse op's tag-inheritance delta.
  - The undo fan-out re-links the restored cohort.
  - Positional page undo excludes the page's birth ops: its own create, and
    its first *local* `set_property(space)`, matching `find_prior_property`.
- **Engine / sync (#5239, #5241, #5251).**
  - Nested pages are re-rooted in the old doc before a move's purge, their
    SQL `parent_id` is cleared to match what peers project, and hydration
    stops at nested pages.
  - Inbound sync enqueues `ReindexFtsReferences` for changed pages and tags.
  - The placement sink fires the pending post-sync rebuild and then emits
    `blocks:changed`.
- **Trashed page roots (#5243).** `load_page_subtree` answers a trashed root
  with `NotFound`, and the store heals it with a "This page is in the trash"
  notice.
- **Mock parity.**
  - The mock's `create_block` for space-root pages and tags now matches the
    backend.
  - The mock's `set_todo_state` and batch writers now stamp and clear
    `completed_at` the way the backend does.

Each mock change is pinned by a backend-authored conformance fixture.

Filed #5262: by-reference undo (History view, revert) of a peer-born page's
first space move still strips its space. That needs a decision on
`find_prior_property`'s view of replicated ops.

## How it was run

- **Builders and reviewers.** Each batch had a builder subagent, then a
  separate reviewer. The reviewer re-ran falsification: break the fix on a
  copy, see the test go red, restore it and check with `cmp`.
- **Frontend batches:** five builders in the main checkout. Two of them
  touched the same `PageHeader.tsx`, which forced hunk-level commits.
  Reviews moved to one worktree per agent, each with its own Playwright
  port. Lesson: give every agent its own worktree from the start.
- **Rust batches:** a ~39 GB disk quota fills with two target trees.
  - Batches ran sequentially in one worktree that shares the main target
    dir.
  - R3 and R4 were written code-only while that worktree was busy, then
    compiled and fixed by their verifiers.
  - `cargo sqlx prepare` builds into the worktree's own `target/`, not the
    shared one.
- **Commit signing:** `gpg.ssh.program` points at `/tmp/code-sign`, a link
  to `/root/.claude/environment-manager/code-sign`. Deleting it while
  freeing `/tmp` broke commits until it was re-linked.

## Verified

- **Frontend, combined tree:**
  - `npm run typecheck` is clean.
  - 268 vitest files pass (5,678 tests).
  - The 22 new Playwright tests pass in one run: `journal-today-shortcut`,
    `rename-invalidation`, `tags-lifecycle`, `sync-refresh` and
    `link-chip-lifecycle`.
- **Rust, per batch:**
  - Tags: 707 targeted nextest tests.
  - Undo: 902, including `conformance_fixtures_match_backend` in assert
    mode.
  - Engine / sync: 1,673 under `SQLX_OFFLINE`.
  - Each batch also passed `cargo clippy -D warnings`, `just gen-sqlx` and
    `prek run --files` on every changed file.
  - Trashed roots and mock `completed_at`: 455 targeted nextest tests,
    vitest 92 files (2,346 tests), and 7 Playwright tests (`sync-refresh`
    plus the new `trashed-page-recents`). `CONFORMANCE_UPDATE=1` rewrote
    74 fixtures; 72 of them differed only in array layout, were JSON-equal
    to HEAD, and were restored.
- **Full vitest on the combined tree (before the trashed-root batch):**
  656 of 659 files passed. The other three failed to load while a cargo
  build held the machine, then passed on a re-run (45 tests).
- **CI:** green on every frontend head. On 7cefdc600, every job that got a
  runner passed. Two jobs were twice cancelled unassigned after 15 minutes
  in the queue. CI on a459948c1 went red on five SearchPanel tests that still
  mocked `list_tags_by_prefix`; they now mock `list_all_tags_in_space`.

## PR board

- #5235 (header back/forward) got its back-loop fix, went green, was
  approved and merged; main was then merged into #5261 without conflicts.
- Dependabot:
  - #5265 (iroh) needed the fuzz lockfile refreshed with `cargo metadata`.
  - #5264 (Tauri crates) needed the npm half of the Tauri stack in the
    same PR. Its tauri-cli 2.12 Android template targets SDK 37, which
    `scripts/patch-android-build.sh` does not patch, so the Android lane
    decides it.
