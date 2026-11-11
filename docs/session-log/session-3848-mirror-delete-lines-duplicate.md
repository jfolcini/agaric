# Session 3848 — Deleting lines from a mirrored file duplicated blocks

The convergence proptest (#6507) failed in a full run on `main`: blocks `["w0", "s2", "s0", "s1", "s2"]`, "no block is duplicated". It reproduced from its shrunk case in a clean checkout.

## The cause

An ingest saves a file against one of the texts the mirror last wrote, the one `closest` picks in `src/mirror/ingest.rs`. It picked the text differing from the file in the fewest lines, counting lines on both sides.

The shrunk case: Agaric edited `w1` to `s0` and added `s1` and `s2`, then wrote `w0 s0 w2 s1 s2`. An editor then cut the file to `w0 s2`. That is closer, in that count, to the older text `w0 w1 w2` than to the newest one. Against the older base, the three-way merge kept Agaric's edit and its two added blocks, which the deletes never touched, and created the file's `s2` as a new block. So the user's deletes were undone and a twin appeared on the page: a data-integrity bug, not a test-model mistake.

## The fix

`closest` now counts only the file's lines that a text does not hold, the lines the user must have typed, with ties going to the newest text. Lines the file lacks no longer count, so deleting lines from the newest text keeps it as the base.

The stale-editor case still picks the older text, because a stale save holds edited lines only the older text explains (`a_save_from_a_stale_editor_does_not_undo_what_agaric_wrote_since`).

## Tests

- `deleting_paragraphs_after_two_added_blocks_duplicates_none` (`tests/command_integration/mirror_convergence.rs`) is the shrunk case as a named test. It was red on `main` with the same duplicate.
- `tests/proptest-regressions/mirror_convergence.txt` holds the seed, so the proptest replays the case first. With the old metric planted, the proptest fails on it.
- Two falsifications, each in one command that restored on exit:
  - the old metric back fails the new test, and the stale-editor test passes;
  - always taking the newest text fails the stale-editor test.
- 256 random cases of the proptest with the old metric planted did not find the bug, so the named test is what pins it.
- All 99 mirror tests pass. `cargo clippy -p agaric --all-targets -- -D warnings` is clean.
