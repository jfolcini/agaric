# Session 2137 — check-dynamic-sql runs as .mjs

#5579 step 5. `check-dynamic-sql` is the third Rust-scanning guard ported
to Node, on `scripts/lib/rust-scan.mjs`. The Python is deleted.

The lib gains what this guard needs:

- `isExcludedFile`, with the four extra test-file globs the Python
  declared;
- a read cache and `readMany` on the file source, so the orphan sweep
  reads every staged file in one `git cat-file --batch` instead of one
  spawn per file.

Equivalence with the Python, checked by a differential harness kept out of
the repo (stdout, stderr, exit code and the written baseline), on Node 24
and 22:

- **57 cases, all with the same exit code.** 51 are byte-identical. The
  other 6 differ only in wording: three messages from the shared
  `guard-file-source.mjs` (unreadable index, foreign index, damaged
  object), the missing-root hint, which now names the lib as the root
  list's home, and the order options are listed in an unknown-option
  error.
- **Git spawns:** the same count in every mode (whole tree `--cached`,
  one file, commit hook, worktree, bare `--update-baseline`).
- **Scanner:** the reviewer ran 6,496 more texts through the site scan,
  the marker search and the test-module test, from every tracked `.rs`
  file, mutated windows and synthetic snippets. Zero differences.
- **Differs, left alone:** non-ASCII digits in a hand-edited baseline
  count (Python's `int()` accepts `٣`), symlinked directories under a crate
  root are followed, and paths sort by UTF-16 unit. Real baselines are
  generated and real paths are ASCII with no symlinks under the roots.

`scripts/lib/check-dynamic-sql.test.mjs` runs the guard end to end in a
scratch repo. Eleven mutations to its wiring each turn a test red. The
review found the drift rule (a baseline recording more sites than the
tree) was unit-tested but not through `main()`; a test now pins it, and
dropping `driftedEntries` from `check()` turns only that test red.

Review notes applied before the PR:

- The helper that printed a Python dict repr is gone; the messages use
  JSON. The sort helper that equalled the default sort is gone too.
- The file source's `listPaths` had an index branch with no production
  caller, since `--update-baseline` and `--self-test` both read the working
  tree. It is gone, and the guard walks the tree itself.
- The last reference to the `.py` in `pr-merge-result-check.sh` is fixed.

`test-py-guard-file-source.sh` loses the sections that drove this guard;
the cleanup PR deletes it with the rest of the Python guard library.

Ran, Node 24 and 22:

- `node scripts/check-dynamic-sql.mjs` (no args, whole tree, `--cached`)
  and its `--self-test` (61 cases);
- `node --test scripts/lib/rust-scan.test.mjs scripts/lib/check-dynamic-sql.test.mjs` (24);
- `check-raw-tx.mjs` and its `--self-test`, `check-table-ownership.py` and
  its `--self-test`, `check-baseline-paths.py`,
  `test-py-guard-file-source.sh`, `check-hook-budget.mjs`;
- `oxfmt --check`, `oxlint --type-aware` and `npm run typecheck`;
- in a scratch clone with the change committed, `prek run --all-files`
  (79 passed) and `pr-merge-result-check.sh`, which exits 1 on a planted
  unjustified `sqlx::query(`.
