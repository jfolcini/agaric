# Session 4193 — The `space` stamp tests own their clock

Two tests failed once each on `main`, on commits that do not touch them.

## `import_markdown_link_target_is_last_edited_at_its_space_stamp` (run 43632206197)

A test race, not a product bug. The three `*_is_last_edited_at_its_space_stamp` tests check that a page created in a space is last edited at its `space` op, not at its create. Both ops take their `created_at` from the wall clock (`agaric_store::db::now_ms`). The test could only tell the two apart when they fell in different milliseconds, so it made ten pages and hoped at least one would straddle a tick. On a fast runner none did, and its own guard failed.

Shown deterministically: with `now_ms` frozen at a constant, the old tests fail 3/3 with CI's message. Unfrozen, 1 run in 5 failed locally.

### What shipped

- `agaric_store::db::distinct_now_ms()`, a `test-util` seam: once called, `now_ms` never hands out the same millisecond twice and stays at or ahead of the wall clock. It is process-global, which is fine because nextest runs each test in its own process.
- The three tests call it, create one page each, and assert the page's `space` op is newer than its create and that `last_edited_ms` equals it. The ten-page hope is gone.

They pass with `now_ms` frozen. They go red on `last edited at its newest op` when the three commands drop their `enqueue_without_dispatch(space_op…)`, which leaves the page at its create's stamp.

## `advanced-query-saved-views.spec.ts:57` (run 43630056291), not reproduced

The failed run's `error-context.md` shows Advanced Query with the Rename button focused and no dialog. Both toasts ("Loaded view", "Saved view") are still up 15 s after the click. Locally they expire within 4 s, so in CI sonner had paused them: the pointer was over the toast stack or pressing it. Two readings fit:

- The press hit Rename (which is why it holds focus) and the release hit a toast, so no `click` fired. Playwright checks only the first pointer event of a click against its target, so it reported success.
- The dialog opened and something closed it, and Radix gave focus back to Rename.

Not reproduced in:

- 30 plain runs
- 20 runs at 6x CPU throttling
- 8 runs with sonner's transitions stretched to 3 s
- 100 runs on oversubscribed workers while clippy built

Instrumented runs pinned down the geometry at 1280x720:

- Rename's centre sits at (1140, 564), inside the toast column (x 900–1256).
- Collapsed toasts never come above y 600: entering, lifting, and both removals.
- Only an expanded stack reaches the button. The older toast's gap bridge spans y 560–575, and once the stack is expanded the pointer on Rename keeps it expanded.

Nothing found expands the stack while the pointer travels from Load to Rename. No fix is guessed.

## Suites run

- `cargo nextest run --workspace -E 'test(/is_last_edited_at_its_space_stamp/)'`: normal, frozen clock, and the two mutations above.
- `cargo clippy --workspace --all-targets -- -D warnings`.
- The Playwright runs above.
