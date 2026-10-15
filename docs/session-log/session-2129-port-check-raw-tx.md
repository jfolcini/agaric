# Session 2129 — check-raw-tx runs as .mjs

#5579 step 3. `check-raw-tx` is the first Rust-scanning guard ported to
Node. `scripts/lib/rust-scan.mjs` holds what it shares with the
`check-dynamic-sql` and `check-table-ownership` ports that come next:

- the Rust comment stripper, walking code points, not UTF-16 units;
- the `#[cfg(test)]` line set and the test-file test;
- the `**` glob;
- Python's definitions of whitespace, `\b` and line breaks;
- a file-source adapter over `guard-file-source.mjs`.

`check-raw-tx.py` stays as a library only, because those two Python
guards import it. The cleanup PR deletes it.

Equivalence with the Python, checked by a differential harness kept out of
the repo:

- **Stripper, cfg(test) set and line split:** zero differences over all
  496 tracked `.rs` files, 30,000 fuzz cases, and the reviewer's 20,077 more,
  including lifetimes next to char literals, raw and byte strings, nested
  comments, BOM and CRLF.
- **Guard:** the same stdout, stderr and exit code on the real tree, the
  self-test, seeded violations and the staged-index cases. The exceptions
  are two wordings that come from the shared `guard-file-source.mjs`, and a
  lone CR in a working-tree file, which real Rust never has.
- **Node 22:** both runtimes pass.

The review found that nothing tested the running guard's `main()`. Five
mutations to it stayed green:

- dropping the `begin_with(` rule;
- dropping the definition exemption;
- judging the disk instead of the index;
- ignoring `--cached`;
- failing open on an unreadable index.

`scripts/lib/rust-scan.test.mjs` now runs the guard end to end in a scratch
repo, and each of the five mutations turns at least one of its tests red.
The review also found a `globMatch` branch no caller reaches and two
helpers that existed only to print Python-style failure messages; all
three are deleted.

`pr-merge-result-check.sh` picks how to run a guard by its extension. It
now lists `check-raw-tx.py` as a prerequisite of the two Python guards, so
a merged tree without it reports a missing prerequisite rather than "the
guard failed".

#5584's review notes: its `prek.toml` stub comment went with this PR's
rewrite of that hook's comment, and the over-wide comment line in
`check-raw-tx.py` is rewrapped. Its third note, the section numbering in
`test-py-guard-file-source.sh`, is dropped: the cleanup PR deletes that
script.

Ran, Node 24 and 22:

- `node scripts/check-raw-tx.mjs` and its `--self-test` (42 cases);
- `node --test scripts/lib/rust-scan.test.mjs` (7);
- the dynamic-sql and table-ownership guards, live and in self-test;
- `check-baseline-paths.py`, `test-py-guard-file-source.sh` and
  `check-hook-budget.mjs`;
- oxfmt and oxlint;
- `prek run --all-files` in a clone.
