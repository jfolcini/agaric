# Session 1871 — scheduled checks, mutation survivors, and the two undo bugs

This session worked the open bug, mutation-survivor and scheduled-check
issues: #5262, #5267, #5110, #3394, #3388, #4690 / #4656 / #4654, and
#4691 / #4816. It first merged the last of the PR board: #5268, the review
notes from session 1870, and the Dependabot bump #5266.

## Scheduled checks

- **Deep checks (#3394).**
  - The 2026-10-05 run had one red lane: shard `(agaric-engine, 8, 18)` of
    `mutants`.
  - It failed in `rustup toolchain install`, on a network error fetching
    `channel-rust-1.95.0.toml.sha256` from static.rust-lang.org, before any
    test ran.
  - A re-run of the failed jobs kept the `schedule` event, so the reporter
    treated it as authoritative and closed #3394 itself.
- **Watchdog (#3388).** It tracked two workflows:
  - `ci.yml`'s push run on main, green since 2026-10-05;
  - that same deep-checks run, green once the re-run finished.

  The next scheduled watchdog run closes it. A dispatched watchdog run only
  does a dry run.
- **Fuzz (#5110).**
  - #5228 had already fixed the `import_parse` crash: a repeat rule ending
    in `¶`.
  - The issue stayed open because of a gap in `file-fuzz-findings.mjs`. The
    body asks a reader to delete a fixed finding's line. Once that empties
    the block, a clean run has nothing to resolve, and the close branch was
    gated on `resolvedOnes.length > 0`.
  - A clean run now also closes an open issue whose block is already empty.
    Two tests cover it, each falsified three ways.

## Mutation survivors

- **Rust (#4690, #4656).**
  - The one tracked survivor was `batch.rs:1163:37`, `/ → %` in
    `reject_replicated_targets`. It was accepted as equivalent on 2026-09-19
    (#5114). The entry dropped on 2026-09-21 only because a doc-only change
    (#5115) moved the line.
  - It is re-anchored in #4690's accepted block. The re-run's filer applied
    it and closed #4656.
- **Rust, new code (#4654).**
  - A `lanes=mutants` dispatch on main covered #5261's `detach_nested_pages`.
    It found `tree.rs:358`, `delete !` on `if !detached.is_empty() {
    commit }`.
  - In loro 1.13.6, committing an empty transaction is a no-op, so the guard
    was dead. The commit is now unconditional.
- **Frontend (#4691, #4816), jex-import.** 36 survivors and 2 no-coverage
  mutants, results below.
  - **Deleted guards.** Twelve guards no input can observe are deleted, which
    removes 27 mutants. Each deletion was re-derived by the reviewer and
    checked by differential fuzz: 500k archives from the builder, 100k from
    the reviewer.
  - **New tests.** Three tests are added. Two old `ACCEPTED GAPS` claims
    (`344:10`, `385:11`) were wrong, and those mutants are now killed.
  - **Rejected test.** One builder test killed two mutants only by using
    Stryker's replacement text as a notebook id. It was replaced with a
    realistic one.
  - **Hang found.** A negative tar size sent `readTar`'s cursor backwards,
    so a corrupt `.jex` hung the importer. A negative size now ends the scan.
    vitest's timeout cannot interrupt a synchronous loop, so the test runs
    `parseJex` under a `vm` timeout.
  - **What remains.** Ten mutants are left, all executed. Seven are
    equivalent:
    - two fallbacks the type checker requires;
    - a 512-byte header read;
    - `offset - BLOCK` now that a negative size ends the scan;
    - `Date.parse(undefined)`;
    - the `mimeToExt` fallback;
    - the code point of a `for…of` character.

    The other three are the `''` fallbacks for a missing `id` or
    `parent_id`. Only an archive using Stryker's replacement text as an id
    tells them apart, which matches the 2026-09-19 verdict "equivalent once
    executed". All ten go into #4691's accepted block, with that caveat on
    the three.

## Bugs

- **#5262.** Undoing a peer-born page's first local space move left it in no
  space.
  - **Cause.** `find_prior_property` and its batch twin read local rows only
    (#2549), so the page's replicated birth `set_property(space)` was
    invisible.
  - **Rejected option.** Refusing the reverse would also break `add_tag`'s
    orphan-tag adoption, whose reverse is a legitimate `DeleteProperty(space)`.
  - **Fix.** For the `space` key only, both kernels now also read replicated
    rows. A peer's space assignment is what placed the page in the doc this
    device received it through, so this device held that value.
  - **#5259 exclusion.** The page-birth exclusion keeps mirroring that rule,
    and so does the mock's `isPageBirthOp`. A peer-born page's first local
    move is therefore a positional Ctrl+Z target again.
- **#5267.** Undoing a space move left the moved page's nested pages as root
  pages. The maintainer chose the design: re-nest from each page's last
  placement op.
  - **What it re-nests.** The reverse of a page's `SetProperty(space)` puts
    back every live root page of the restored space whose latest
    `create_block`/`move_block` placed it under the page or a block of it.
    Local and peer rows both count. Each page goes back at the recorded slot,
    in the doc and in SQL.
  - **What it leaves alone.** A page placed elsewhere since keeps that
    placement. A hand move back does not re-nest.
  - **Edge.** The re-nest runs on every reverse `SetProperty(space)`, so a
    redo re-nests too. Say P was once moved out of space B by hand, leaving
    its nested pages rooted there. A later redo of a move into B re-nests
    them, which the original forward move did not. Excluding that would need
    an undo-or-redo flag threaded through `apply_reverse_in_tx`, so it stays.
  - **No `e2e-tauri/` spec.** Neither bug came from a user report; both were
    found in review of #5261. #5262 needs two devices, which that lane cannot
    drive.

## Verified

The reviewer ran the full suites on the combined branch:

- `cargo nextest run --workspace`: 6,689 passed, 13 skipped, 0 failed.
- `cargo test --doc --workspace`: 10 passed, 5 ignored.
- `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy
  --workspace --all-targets -- -D warnings` and `cargo fmt --all --check`:
  clean.
- `npx vitest run`: 866 files, 20,293 passed, 51 skipped, 1 expected
  failure, 0 failed.
- `npm run typecheck`: clean.
- `node --test scripts/file-fuzz-findings.test.mjs`: 20 passed.
- Stryker for `jex-import`: 97.67%, with 411 killed, 8 timed out, 8
  survived and 2 no-coverage. Each of the ten remaining mutants was applied
  by hand with both jex suites still green.

Falsification, each on a copy and restored with `cmp`:

- **#5262:** the single-op kernel, the batch kernel, both halves of the
  positional exclusion, and the mock rule each redden their own tests.
- **#5267:** disabling the re-nest, flipping the placement order to oldest
  first, filtering out replicated rows, and dropping the tag recompute each
  redden a named test.
- **Fuzz filer:** dropping the emptied-block arm, dropping its `OPEN` check,
  and dropping the clean-run gate each redden a test.

The re-run of the 2026-10-05 deep-checks run is green. The `lanes=mutants`
dispatch on main (37389684709) wrote the rust tracker.
