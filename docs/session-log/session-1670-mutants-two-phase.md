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

## Round two

The reviewer found a double count: the confirm selects by SITE, so it
re-tests both variants at a surviving site, including the one the scan
already caught — and the assemble kept the scan's outcome for that variant
and appended the confirm's, so the merge summary would have read
`138 of 125` under a correct `tested: 125 of 125`. The assemble now drops
the scan's outcome for every re-tested site (the confirm's is the one that
ran the full suite) and unions the `.txt` lists with `sort -u`. Two more
holes from the same review, closed: a confirm whose baseline failed still
wrote an `outcomes.json`, so every scan survivor would have been carried as
"unconfirmed" under a notice — the assemble now refuses on a non-Success
confirm baseline the way the guard refuses a scan's; and the scan filter
lookup's `exit 2` was discarded under `set -uo pipefail` without `-e` — it
is `|| exit 1` now.

The assemble harness grew two cases: a caught variant sharing a site with a
survivor (counted once; three caught, none missed, four outcomes for three
mutants plus the baseline), and a confirm with a `Timeout` baseline (not
assembled). The other four cases hold. Guard and self-test green, shellcheck
clean on all four blocks, zizmor clean.

## Round three

Two more from the same reviewer, both real. The failed-confirm-baseline
branch refused to assemble but left the confirm's own `mutants.out/` in
place, whose `outcomes.json` satisfied the guard's existence check — a shard
that would have gone green publishing nothing of its survivors. And the
confirm, selecting by site without `--shard`, re-tests the sibling variant
that round-robin assigned to ANOTHER shard, so two shards published one
mutant and the merge summary double-counted it, one level above the
intra-shard count round two fixed.

The assemble step is rebuilt around one source: the confirm's outcomes are
filtered to this shard's `mutants.json` first, replace the scan's outcome
mutant-by-mutant (a key of file, line, column and replacement — site alone
cannot tell the two variants apart), and the four `.txt` lists are derived
from the assembled outcomes, so a mutant appears in exactly one of them. Both
refusal branches now remove `mutants.out/`. The harness gained the cross-shard
case and asserts the directory is gone on both refusals.

## Round four

The reviewer caught an assumption: the `.txt` lists were regenerated from
`mutants.json`'s `.name`, a field nothing in the repo pins, with `// empty`
as the failure mode — an absent or differently spelled name would have
shipped an empty `missed.txt`, which the filer reads as "nothing survived"
and clears every tracked survivor (#3364's class). Stripping `name` from the
harness's `mutants.json` produced exactly that: every list empty, every case
red. The lists are now line sets: this shard's mutants are exactly the lines
in the scan's four lists, the confirm's lists are filtered to those, and each
class is the confirm's kept lines plus the scan's lines the confirm did not
re-test. The harness keeps `name` stripped so nothing can start reading it,
and has a truncated-scan case where the confirm's outcome for a
never-scanned sibling is dropped. `total_mutants` is the assembled count, so
`tested` and the per-package line agree on a truncated shard; the confirm's
floor is five minutes and the wall-clock comment does the arithmetic; the
guard's `--scan-filter` sits below `printShardCount` again, under its own
doc.
