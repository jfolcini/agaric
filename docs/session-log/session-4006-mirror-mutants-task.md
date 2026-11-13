# Session 4006 — Mutants in the mirror's task and ingest, killed or explained

#5363's mutation box, PR 4b of two (PR 4a has the helper files). It covers the 32 survivors in `src/mirror/mod.rs` and `src/mirror/ingest.rs`.

## The run

- **Population:** cargo-mutants 27.1.0 over `src-tauri/src/mirror/*.rs`, leaving out `*_tests.rs` and `tests.rs`: 518 mutants.
- **Phase 1:** each mutant against the lib's `mirror::` tests, run `--in-place` in a worktree of main, split across this session and three helper sessions.
- **Phase 2:** each phase 1 survivor against the full `test(/mirror/)` suite across every agaric target (132 tests in 6 binaries, `command_integration` among them). 67 survived it, 32 of them in this PR's files.
- **Equivalence:** `src/mirror` is the same at fbe0dfd, 313b7fc and this PR's base.

## How each was settled

17 KILLED by a named test, 11 EXPLAINED, 4 DELETED. The PR body has the table.

- **Kills:** each was confirmed by cargo-mutants, in-place in its worktree at this branch's head, with exact `-F` name filters (line-free for the files this PR edits) and `-- --lib -E 'test(/mirror::/)'`. Each failed on the assertion the PR body names.
- **`closest`'s second key** is `written.len()` now. When the first key ties, both texts explain the same number of the file's lines, so differing in the fewest lines is being the shortest. The four mutants of the old expression had no different order to give, and they are gone with it. `of_the_texts_explaining_a_file_as_well_the_shortest_is_its_base` pins the order.

## What went wrong

- **A disk-full run passed off failures as kills.** One confirm run filled the disk mid-way. The 8 mutants it reported caught included `spawn` and `set_start_error`, which no lib test reaches, so its tests had failed for want of space. The 8 were tested again in a fresh output directory: 3 were caught and 5 missed.
- **Two kill tests were vacuous at first:**
  - The foreign-anchor test had no page whose file had vanished, and `renamed_from` only looks at those.
  - The stale-state test never made the page dirty again, so neither the code nor its mutant reached the guard.

  Both now set up the state the mutant needs, and both went red with it.
- **Three new tests had wrong expectations:**
  - CRLF lines with no blank line between them are one paragraph.
  - An unanchored line moved and edited is a new block.
  - The render to save back is the one after the bullets were read in.

## Results

- `cargo nextest run -p agaric --lib -E 'test(/mirror::/)'`: all passed (cargo-mutants' unmutated baseline at the head).
- `cargo clippy --workspace --all-targets -- -D warnings`: clean.
