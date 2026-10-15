# Session 2141 — the Python guard library is gone

#5579's cleanup step, after the three Rust-scanning guards moved to Node
(#5586, #5593, #5594).

Deleted: `check-raw-tx.py`, `lib/guard_file_source.py`,
`test-py-guard-file-source.sh` and its `py-guard-file-source-selftest`
hook. Nothing imported or ran them by then.

`pr-merge-result-check.sh` loses its Python paths: the `python3`
branch of `derive_crate_roots` (a non-`.mjs` guard is now an error) and
the `*.py` arm of `run_one_guard`. `pr-overlap.yml` stops describing a
python3 failure that can no longer happen.

The helpers the three ports had copied now live once in
`lib/rust-scan.mjs`: `write`, `lineIndexer`, `resolveExisting`,
`underCrateRoot`, `missingCrateRoots`, `isDirectory` and `repoRelative`.
Where the copies differed, the guard keeps its behaviour: `underCrateRoot`
takes the root list with the shared one as default, and `check-raw-tx`
still falls back to the raw argument where `repoRelative` gives nothing.
`check-table-ownership` uses the lib's four extra test-file globs, which
were its own in another order.

#5593's review notes:

- `rootSelfTest` duplicated the missing-root cases its node tests run end
  to end; it is gone, with the injection options on `main()` that only it
  used. The self-test runs 23 cases.
- The comments still naming the deleted `.py` files are fixed.

`test-related-rust.sh` builds its crate map with `node -e` instead of
inline Python; on one saved `cargo metadata` the two outputs are
byte-identical under Node 24 and 22.

Falsified on a copy of the tree: making `underCrateRoot` always false,
`missingCrateRoots` empty or `lineIndexer` constant turns a self-test or
node test red for every guard that imports it. One gap stays:
`repoRelative` returning nothing is not caught under `check-raw-tx`,
because its fallback gives the same path whenever the cwd is the repo
root, which every test uses.

Not in this PR: `verify-ci-equivalent.sh`'s Python heredocs, and the
three remaining Python scripts (`check-baseline-paths.py`,
`check-migration-mock-contract.py`, `mcp_smoke.py`).

Ran, Node 24 and 22: the three guards and their self-tests, `node --test`
on their three test files (32), `check-baseline-paths.py`,
`check-hook-budget.mjs` (121/140), `oxfmt`, type-aware `oxlint`,
`shellcheck`, and `prek run --all-files` (79 passed).
