# Session 1470 — a guard that was green only in the tree nobody works in

Shipped the mechanical half of #4501: every path in a baseline, allowlist or `DENY_FILES` set must
resolve, plus the `CRATE_ROOTS` sweep the maintainer said belonged to this issue, plus the re-anchor
ratchet. The most useful thing that happened was a blocker that only existed outside the worktree it
was built in.

## The new guard was red in every real checkout

`check-baseline-paths.py` discovers baseline files rather than listing them, which is the property a
hand-written list cannot have: a baseline added tomorrow is either covered or loud. The first version
discovered them by walking the filesystem — `REPO_ROOT.rglob("*")`, pruning a handful of directories
*after* the walk.

In the worktree it was built in, that is fine: no `target/`, `node_modules` is a symlink, and nothing
has ever run Stryker there. In the main checkout it finds `.stryker-tmp/sandbox-*/scripts/` — a
verbatim copy of `scripts/`, 32 stray hits — and four `baseline-prof.txt` files under
`src-tauri/gen/android/app/build/`. Both are gitignored. The hook is `always_run` at pre-commit and
pre-push, so **anyone who had run Stryker or built the Android app would have been unable to commit
anything**, and the guard's own fail-closed-on-unknown-file design is what would have blocked them.

The asymmetry is the whole lesson. A guard verified only in a fresh worktree has been verified in the
one environment that is guaranteed not to have build artifacts, which is exactly the environment no
contributor is in. Discovery now asks `git ls-files`, which answers the question actually being asked
— *which baselines does this repository track?* — and fails closed with its own banner when git cannot
answer.

The cost claim was wrong for the same reason and in the same direction. The hook advertised 0.16s,
measured in the worktree where `rglob` never descends into a real `node_modules` or `target`. In the
main checkout an unpruned `rglob('*')` is 727,845 entries and 3.08s, with `src-tauri/target` alone
accounting for 634,512 entries and 6.90s. The tracked-file version is 0.04s, and that is the number
in `prek.toml` now.

## Three shapes of the same bug, one with nothing to grep for

The maintainer's comment asked whether `check-raw-tx.py`, `check-table-ownership.py` and
`check-dynamic-sql.py` share the `is_dir()` silent-discard that #4508 fixed in
`check-space-filter-drift.py`. They do not share it — they have three *different* spellings of it, and
one of them has no token to search for at all:

- `check-op-log-delete.py` filters `is_dir()` at `scan()` — the same shape, greppable.
- `check-dynamic-sql.py` has no `is_dir()` anywhere; a missing root simply yields nothing from
  `SOURCE.list_paths`.
- `check-raw-tx.py` never walks its roots. They are argv-filter string prefixes, so a misspelled root
  makes `under_crate_root()` reject every real file under that crate and `main`'s loop `continue` past
  all of them. Same outcome — a green run over a subtree the guard stopped reading — reached without
  any of the constructs the other two use.

`check-table-ownership.py` and `check-space-filter-drift.py` were confirmed already fixed rather than
taken on trust, which matters: a false "already clean" is the same silent hole one level up.

Each fix was falsified in three arms — correct roots, misspelled root with the assertion, misspelled
root with the assertion removed. The third arm is the one that earns the change: exit 0, empty output,
over a tree containing a real `BEGIN IMMEDIATE` and a real `DELETE FROM op_log`.

## The fixture tension, answered two different ways on purpose

A guard that asserts its own scan roots exist is incompatible with a fixture repo that deliberately has
different ones — the maintainer recorded that adding one such assertion turned seventeen of
`pr-merge-result-check.sh`'s self-test assertions red. Two guards adopting it at once turned twenty-four
red here.

The two synthetic-fixture harnesses got opposite treatments, because their fixtures exist for different
reasons. `pr-merge-result-check.sh`'s merge fixtures have foreign roots *as the property under test*, so
it gets an explicit `--synthetic-tree` opt-out. `test-py-guard-file-source.sh`'s fixtures are about which
*copy* of a file a guard reads and their crate topology is incidental, so the real roots are seeded with
tracked `.gitkeep` files — which keeps the assertion live rather than switched off, adds no second
opt-out surface to police, and keeps `--update-baseline` usable in a fixture, which the marker cannot.

The opt-out is asserted unreachable in real invocations, in both directions, for all three guards. What
makes those assertions non-vacuous is not the probe file the first draft credited — deleting it changes
nothing — but the partner mutant: making `--synthetic-tree` inert inside a guard flips the pair. The
comment claiming otherwise was corrected to say the true thing.

## Two claims that did not survive checking

The classification of sixteen `--update-baseline` commands had two errors, both in the direction of
claiming more coverage than exists. "Two already refuse on a drop" is one: `check-hook-deps.mjs` gates
*growth*, not shrinkage, and `check-table-ownership.py`'s refusal is on a missing root. And "ten
suppression baselines where shrinking is the goal" is nine at best — `check-bulk-equivalence.mjs` is an
inventory of the workspace carrying `status: "covered"` **coverage claims**, and its `updateBaseline`
drops every function not in the live inventory, unconditionally, exit 0. That is precisely the hole the
classification asserted was not there.

Recorded rather than fixed, because the sweep is not finished: an independent pass found roughly
fourteen further silent-narrowing carriers in two more spellings — a git pathspec or `find` root that
matches nothing, and five inline `grep -r <root>` hooks inside `prek.toml` itself, where `grep`'s exit 2
reads as "no match" and the hook exits 0. The worst of them prints "✓ … legitimate cleanup" while
failing open twice. The roots half of this issue has no discovered population the way the baseline half
now does, and that is the next thing worth building.
