# Session 1670 — two-phase mutants: scan narrow, confirm wide

#4872 is lever C of #4696, the one that was never started: narrow the tests
each mutant runs against, without publishing the false survivors a narrowed
suite produces. Two phases per shard dissolve that by construction — scan
every mutant against a narrowed suite, then re-run only the scan's survivors
against the full package suite — so the published list is the set the full
suite missed.

## The shape, and the one deviation from the issue

The issue expected per-glob narrowing and named the reconciliation of
per-glob invocations with per-package shards as "the actual design work".
This lands per-PACKAGE narrowing instead: one nextest expression per examined
package (`scripts/mutants-scan-filters.json`), which keeps one scan
invocation per shard, the shard matrix untouched, and no second baseline per
glob. Measured against the built test binaries the filters keep 136 of 1437
store tests, 243 of 1026 engine tests and 214 of 1008 sync tests. If the
lane's own numbers say the per-glob split is worth its extra baselines, it is
a refinement of the filter table, not of the lane.

Per shard: **scan** (`--shard`, `-- -E <filter>`, output moved to
`scan.out/`), **confirm** (one anchored `--re` alternation over the surviving
`file:line:col:` sites, no `--shard`, no `--`, what the scan left of the wall
budget, floored at ten minutes), **assemble** (the scan's `mutants.json` and
`total_mutants`, both phases' caught/unviable/timeout, the confirm's
`missed.txt` plus any scan survivor the confirm did not reach — carried,
never dropped, and counted in `two-phase.json`). A confirm that was needed
and wrote nothing means nothing is assembled and the zero-coverage guard reds
the shard rather than publish narrowed-suite survivors as confirmed.
`mutants-merge`, `missed.txt`'s shape, `--shard-count` and the filer are
unchanged; the merge summary gains one line per package from the
`two-phase.json` files, which is where the issue's before/after gets read.

`check-mutants-scope.mjs` now checks the two-phase shape (a narrowed,
sharded scan; an unsharded, unnarrowed, `--re`-selected confirm; a filter
for every matrix package) and serves the scan filter to the workflow with
`--scan-filter`, so the guard and the lane read one table. The confirm's
`--re` had to be a literal on the invocation line for the guard to see it —
which is why it is one alternation rather than a bash array — and that is
also why a `--re` hidden in an array reddened the guard on the first run.

## What this cannot verify

The lane runs weekly. Everything below the lane was checked here: the guard
and its self-tests, shellcheck over the four `run:` blocks, zizmor, and the
`--re` selector against `cargo mutants --list` (both variants at a site, and
an alternation of sites). What was not is the lane itself: the acceptance
asks for a `workflow_dispatch` run compared against the previous cron's
`missed.txt` before it is trusted, and that run is the maintainer's to start.
The PR is a draft for that reason.

## Verified

- `node scripts/check-mutants-scope.mjs` green on the rewritten job; `--self-test`
  green, including the five new two-phase cases and the real-workflow one.
  The real job was RED on the first run (`confirm-unselected`) while the
  confirm's `--re` sat inside a bash array the guard cannot see — the check
  fired on the real thing before it was green.
- `cargo mutants --list --re '^(agaric-store/src/op_log/append\.rs:12:5:|agaric-store/src/op\.rs:76:9:)'`
  lists exactly the two variants at the real site, so the confirm's selector
  selects what it means to.
- shellcheck (`-S warning`) clean over the scan, confirm, assemble and guard
  `run:` blocks; zizmor clean on the workflow.
- The assemble step driven over synthetic phase outputs: a confirm that
  catches one survivor and misses one; a confirm that reached only one site
  (the other carried as unconfirmed, with the notice); a scan with no
  survivors; a scan with survivors and no confirm output (nothing assembled).
  Every count, list and `two-phase.json` matched.
- The scan filters keep 136 / 1437 (store), 243 / 1026 (engine), 214 / 1008
  (sync) tests, measured with `cargo nextest list -E`.
- Not run, and cannot be here: the lane. The acceptance's `workflow_dispatch`
  comparison against the previous cron's `missed.txt` is the maintainer's.
