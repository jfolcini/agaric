# Session 1874 — stale-state audit, then its three high-severity bugs

This session re-ran the storage and cache invalidation audit across the page,
tag, link, property and space lifecycles, this time including the client-side
caches: TanStack Query, the Zustand stores and the hand-rolled maps. It then
fixed the three high-severity findings in PR #5300.

## The audit

- **Investigators.** Eight read-only investigators each traced one area:
  - TanStack queries;
  - stores and persisted client state;
  - hand-rolled caches;
  - tags;
  - pages;
  - links;
  - backend-to-frontend events;
  - properties, tasks and spaces.

  For every finding they traced the write path through to the read path.
- **Validators.** One adversarial validator per area then tried to refute
  each finding.
- **Result.** 27 issues were filed (#5272–#5298): 3 high, 12 medium, 12 low.
  Three findings were refuted:
  - the disaster-recovery trigger can no longer occur;
  - pages nested by `parent_id` cannot be created from the UI;
  - a stale `tags_cache.space_id` has no visible reader.

## What shipped (#5300)

- **#5273: batch actions touched blocks that were on no screen.**
  - The batch toolbar, its handlers and the context menu's bulk mode act only
    on selected ids that the tree's page store holds.
  - A journal day, mode or space change clears the selection.
  - The review found that the context menu's bulk TODO and priority loop
    still wrote to blocks on other days, so that loop is fixed too.
  - The review also found that a stale selection, with no toolbar left, kept
    hiding task markers on the new day. Clearing the selection on those
    changes fixes it.
- **#5272: links that "Move to space" made cross-space blocked every save.**
  - A cross-space target now passes the content scan when a live block of
    the same page already holds it.
  - That covers the edited block, the next-occurrence copy of a repeating
    task, and Edit-as-Markdown creates. Those creates run before that
    apply's edits and deletes, so the page's old rows are still live.
  - A link the page never held is still refused.
  - **Left open on #5272:** Enter-split, where the link moves into the new
    block, is still refused, because `splitBlock` saves the shortened
    original first. Fixing it means reordering the split's create and edit
    and inverting its #730/#2913 rollback.
- **#5274: tag pickers outside the `#` picker listed every space's tags.**
  - `list_tags_by_prefix` now takes a `SpaceScope`. The LIKE scan and both
    exact-match fallbacks filter by the space.
  - Every caller passes the active space. `resolveTagFilters` threads the
    agenda's space.
  - The Graph's tag list moved to `list_all_tags_in_space`, because its
    filter bar has no search and the prefix IPC caps at 200.
  - The conformance fixtures gained a global-scope rejection step.
  - The Graph keeping the old space's tag filter after a switch is #5294,
    not this fix.

## Verified

- Rust:
  - `cargo nextest run --workspace` passed twice: 6692 tests after #5272 and
    6694 after #5274, with 0 failures.
  - `SQLX_OFFLINE=true cargo check --workspace --all-targets` and
    `cargo fmt -- --check` are clean.
- Frontend:
  - #5273: the related vitest directories passed 6292 tests.
  - #5274: 381 files passed 8373 tests.
  - `npm run typecheck` is clean.
- Each new test was shown red by reverting its fix in a scratch-backed copy,
  then restored and checked with `cmp`.
- CI on the first two fixes was green.
