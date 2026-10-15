# Session 2136 — check-table-ownership runs as .mjs

#5579 step 4. `check-table-ownership` is the second Rust-scanning guard
ported to Node, on the `scripts/lib/rust-scan.mjs` scanner #5586 added.
`check-table-ownership.py` is deleted outright: nothing imported it. A
full-tree run takes 0.9 s, down from 7.4 s.

The lib gains two things this guard needs:

- `stripRustComments(text, { keepStrings })` blanks comments only, because
  the SQL this guard counts lives inside string literals. It is one
  condition in the existing loop; the default still blanks strings.
- `WORD` is exported for the guard's `\w`.

Equivalence with the Python, checked by a differential harness kept out of
the repo (stdout, stderr, exit code and the written baseline):

- **Real tree, self-test and `--update-baseline`:** identical on Node 24
  and Node 22.
- **Seeded cases:** a new cross-crate write, a count past an existing
  pair, annotated, stale and lowered baseline entries, malformed baseline
  lines, a missing crate root with and without `--synthetic-tree`, writes
  inside `#[cfg(test)]`, no baseline file, and two seeds of 400 fuzz files.
  All identical except the three messages that named the `.py`, which now
  name the `.mjs`.
- **Comment stripper with strings kept:** zero differences against
  Python's `strip_comments_keep_strings` over the 368 `.rs` files under the
  crate roots and 30,000 fuzz cases.
- **One input still differs:** a dotless `ı` in an SQL keyword
  (`ınsert into op_log`) counts in Python, whose case folding treats it as
  `i`, and not in Node. Real Rust does not contain it.

The guard has no staged-index mode: like the Python, it rescans the
working tree whatever it is given, because ownership is an aggregate
invariant.

`scripts/check-table-ownership.test.mjs` runs the guard end to end in a
scratch tree. Twelve mutations to `main()` and its helpers each turn one of
its seven tests red: skipping the violation rule, dropping the owner
exemption, ignoring the baseline value, dropping annotations on update, a
non-recursive walk, no missing-root check, a malformed baseline exiting 0,
no `--update-baseline`/`--synthetic-tree` exclusion, blanking strings, the
lib ignoring `keepStrings`, an update that writes nothing, and
`--synthetic-tree` ignored.

Review notes applied before the PR:

- The helper that printed Python's `repr` is gone; the malformed-line
  message quotes with `JSON.stringify`.
- Comments narrating the Python history are gone.
- `rust-scan.test.mjs` pins both `keepStrings` modes; flipping the default
  or dropping the condition turns it red, where before only this guard's
  own tests caught it.
- The self-test gains a lowercase-SQL case and a `bulk_equivalence`
  exclusion case; dropping the `i` flag or the glob now fails it. 30 cases.

`pr-merge-result-check.sh` runs the guard with `node`, lists the two
libraries it imports as prerequisites, and drops the tuple branch that
existed only for the Python's `(label, Path)` crate roots.
`check-raw-tx.mjs`'s missing-root hint no longer says table-ownership
keeps its own copy of the root list.

Ran, Node 24 and 22:

- `node scripts/check-table-ownership.mjs` and its `--self-test`;
- `node --test scripts/check-table-ownership.test.mjs scripts/lib/rust-scan.test.mjs` (15);
- `node scripts/check-raw-tx.mjs --self-test` (42);
- `python3 scripts/check-dynamic-sql.py` and its self-test,
  `check-baseline-paths.py`, `test-py-guard-file-source.sh`,
  `check-hook-budget.mjs`;
- `oxfmt --check` and `oxlint --type-aware`;
- in a scratch clone with the change committed, `prek run --all-files`
  (79 passed) and `pr-merge-result-check.sh`, which exits 1 on a branch
  that adds a cross-crate write.
