# Session 2348 — Three tests that failed under load, fixed at the cause

Three tests misbehaved while other worktrees loaded the machine. Each was
reproduced under load (16 cores, load average 13 to 23), and its mechanism
was found before the fix.

1. **Playwright `toolbar-controls.spec.ts`, "Insert-table picker".** The
   failure was in the app. A press on a block's static text, while the editor
   sat on another block of the same tree, blurred that editor. The edited
   block collapsed (its toolbar went), the rows below moved up under the
   pointer before the release, and the click landed on another element, so
   no editor opened. Logged mouse events showed the target block 91 px higher
   at `mouseup` than at `mousedown`. The spec passed only when the table
   picker was still fading out: the blur then bailed on a visible portal, so
   nothing moved. A plain text block lost the click 6 of 6 times when nothing
   was loaded. `EditableBlock` now hands `StaticBlock` an `onMouseDown` that
   keeps the editor focused for a plain primary press on non-interactive
   text. The click then runs `handleFocus`, which saves the other block first
   and blurs the still-focused editor, since `mount` refocuses only an
   unfocused one; without that blur the moved editor had no focus and typing
   after the click went nowhere, so the spec now types after it.
   A press on a chip or button inside the block still moves focus, so its
   blur saves as before. A new `editor-lifecycle.spec.ts` case (edit, then
   click a lower block) failed 4 of 4 without the fix. Three vitest cases each
   failed when their own branch of the guard was removed. The
   `focusBlockById` comment now limits the old advice to editors in another
   tree, which this fix does not cover.
2. **Playwright `pages-filter.spec.ts`, "clears the saved scroll offset".**
   The spec was wrong. From the bottom of the list, the shorter filtered list
   clamps `scrollTop`. That scroll correctly saves an offset for the new set,
   so the key was null only for about 750 ms after the clear, and
   `expect.poll` had to land a poll inside that window. A storage spy that
   waited 1.5 s saw the key filled again in 20 of 20 runs. The spec now
   scrolls to a mid-list offset that the filter does not move, so null is the
   final state. It failed 4 of 4 with the clear removed.
3. **Rust `reverse_proptest_b1`.** Each of the 64 cases migrated a fresh pool.
   A probe of 32 cases under load measured 12.9 s to migrate pools, 2.7 s to
   copy them from a template, 0.7 s to seed and 0.4 s to compute reverses.
   `agaric_store::test_support::test_pool_from_template` migrates once per
   process and copies the result. It works the same way as the app crate's
   `init_pool_from_template` from #5668, which `agaric-engine` cannot reach.
   Both proptests use it, and every assertion is unchanged. A new test checks
   that two callers never share a database. It failed when the helper shared
   one path. B1's own oracle passed with a shared path, so it does not check
   this.

| | before | after |
|---|---|---|
| table picker, `--repeat-each=20 --workers=8` | 1/20 failed (10/20 with trace on) | 0/20 |
| scroll offset, same | 3/20 failed | 0/20 |
| `compute_reverse_is_deterministic` alone, alternating | 12.0, 12.0, 13.1 s (load 10-13); 15.8 s (load 5) | 1.7, 1.8, 3.9 s; 2.3 s |

Gates: the three tests at `--repeat-each=30 --workers=4 --retries=0` (0
failures each), the three spec files three times, the full Playwright suite
(1071 passed, 8 skipped), the full vitest suite in four shards, `npm run
typecheck`, oxlint, `oxfmt --check`, `cargo clippy --workspace --all-targets
-- -D warnings`, and `cargo fmt --check`.
